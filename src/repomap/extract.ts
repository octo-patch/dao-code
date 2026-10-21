// 单文件符号提取:tree-sitter 解析 → 定义符号(defs)+ 引用(refs)+ 相对 import 源。
// 输出全部是纯 JS 值(名字/行号/签名文本)——提取完立即 tree.delete(),不让 JS 侧持有
// WASM 树节点(几千文件扫描时泄漏会累积)。
import { promises as fs } from "node:fs";
import { Parser } from "web-tree-sitter";
import type { LangDef } from "./languages.js";
import { loadGrammar } from "./loader.js";

export interface SymbolDef {
  name: string;
  kind: string; // tree-sitter 节点类型(class_declaration 等)
  startLine: number; // 1-based
  signature: string; // 签名文本(可多行,不含 body)
}

export interface FileExtract {
  defs: SymbolDef[];
  refs: string[]; // 引用的符号名(import 名/路径末段),已去重
  importSources: string[]; // 相对 import 源("./foo" 等,未解析)
}

const MAX_SIGNATURE_LINES = 8;

// 单 Parser 实例按语言切换(避免每文件建 parser)。
let sharedParser: Parser | undefined;
function getParser(): Parser {
  if (!sharedParser) sharedParser = new Parser();
  return sharedParser;
}

interface TsNodeLike {
  type: string;
  text: string;
  startPosition: { row: number };
  endPosition: { row: number };
  children: TsNodeLike[];
  namedChildren?: TsNodeLike[];
  childForFieldName(field: string): TsNodeLike | null;
}

function namedChildrenOf(n: TsNodeLike): TsNodeLike[] {
  return n.namedChildren ?? n.children.filter((c) => c.type.length > 0 && !c.type.startsWith("."));
}

// 签名文本:def 起始行到 body 起始行(不含);无 body 时整个节点前几行。
function extractSignature(node: TsNodeLike, srcLines: string[]): string {
  const startRow = node.startPosition.row;
  const body = node.childForFieldName("body");
  let endRowExclusive: number;
  if (body && body.startPosition.row > startRow) {
    endRowExclusive = body.startPosition.row;
  } else if (body) {
    endRowExclusive = startRow + 1; // body 同行起:签名只有这一行
  } else {
    endRowExclusive = Math.min(node.endPosition.row + 1, startRow + 3); // 无 body:上限 3 行
  }
  endRowExclusive = Math.min(endRowExclusive, startRow + MAX_SIGNATURE_LINES);
  return srcLines.slice(startRow, endRowExclusive).join("\n").trimEnd();
}

// TS/JS:lexical_declaration 下钻 variable_declarator;仅当 value 是函数才收(纯常量不是 API 符号)。
function tsDeclaratorName(node: TsNodeLike): string | null {
  for (const child of namedChildrenOf(node)) {
    if (child.type !== "variable_declarator") continue;
    const nameNode = child.childForFieldName("name");
    if (!nameNode) continue;
    const value = child.childForFieldName("value");
    if (value && (value.type === "arrow_function" || value.type === "function_expression" || value.type === "generator_function")) {
      return nameNode.text;
    }
  }
  return null;
}

// Go:type_declaration 下钻 type_spec。
function goSpecName(node: TsNodeLike): string | null {
  for (const child of namedChildrenOf(node)) {
    if (child.type === "type_spec") return child.childForFieldName("name")?.text ?? null;
  }
  return null;
}

function defName(node: TsNodeLike, how: "name" | "type" | "declarator" | "spec"): string | null {
  switch (how) {
    case "name": return node.childForFieldName("name")?.text ?? null;
    case "type": return node.childForFieldName("type")?.text ?? null;
    case "declarator": return tsDeclaratorName(node);
    case "spec": return goSpecName(node);
  }
}

function walkDefs(node: TsNodeLike, lang: LangDef, srcLines: string[], out: SymbolDef[]): void {
  const how = lang.defNodes[node.type];
  if (how) {
    const name = defName(node, how);
    if (name) {
      out.push({
        name,
        kind: node.type,
        startLine: node.startPosition.row + 1,
        signature: extractSignature(node, srcLines),
      });
    }
  }
  for (const child of node.children) walkDefs(child, lang, srcLines, out);
}

// ---- refs 提取(按语言:import 语句里的名字 + 路径末段) ----

function tsRefs(node: TsNodeLike, refs: Set<string>, sources: Set<string>): void {
  if (node.type === "import_statement") {
    for (const child of node.children) {
      if (child.type === "string") {
        const src = child.text.replace(/^["']|["']$/g, "");
        if (src.startsWith("./") || src.startsWith("../")) sources.add(src);
        const last = src.split("/").pop() ?? src;
        if (last) refs.add(last);
      } else if (child.type === "import_clause") {
        for (const c of namedChildrenOf(child)) {
          if (c.type === "named_imports") {
            for (const spec of namedChildrenOf(c)) {
              if (spec.type === "import_specifier") {
                const n = spec.childForFieldName("name") ?? spec.namedChildren?.[0];
                if (n) refs.add(n.text);
              }
            }
          } else if (c.type === "namespace_import") {
            // `* as bar` → 取 as 后面的本地名
            const m = c.text.match(/as\s+(\w+)/);
            if (m) refs.add(m[1]!);
          } else if (c.type === "identifier") {
            refs.add(c.text);
          }
        }
      }
    }
  } else if (node.type === "export_statement") {
    const src = node.childForFieldName("source");
    if (src && src.type === "string") {
      const raw = src.text.replace(/^["']|["']$/g, "");
      if (raw.startsWith("./") || raw.startsWith("../")) sources.add(raw);
    }
  }
  for (const child of node.children) tsRefs(child, refs, sources);
}

function pyRefs(node: TsNodeLike, refs: Set<string>, sources: Set<string>): void {
  if (node.type === "import_statement") {
    for (const child of namedChildrenOf(node)) {
      if (child.type === "dotted_name" || child.type === "aliased_import") {
        const segs = child.text.replace(/\s+as\s+\w+/g, "").split(".");
        for (const s of segs) if (s) refs.add(s);
      }
    }
  } else if (node.type === "import_from_statement") {
    const mod = node.childForFieldName("module_name");
    if (mod) for (const s of mod.text.split(".")) if (s) refs.add(s);
    for (const child of namedChildrenOf(node)) {
      if (child.type === "dotted_name") {
        for (const s of child.text.split(".")) if (s) refs.add(s);
      } else if (child.type === "aliased_import") {
        const inner = child.children[0];
        if (inner) for (const s of inner.text.split(".")) if (s) refs.add(s);
      }
    }
    // 相对导入:from . import x / from .mod import y
    if (mod && mod.text.startsWith(".")) sources.add(mod.text);
  }
  for (const child of node.children) pyRefs(child, refs, sources);
}

function goRefs(node: TsNodeLike, refs: Set<string>): void {
  if (node.type === "import_spec") {
    const path = node.childForFieldName("path");
    if (path) {
      const raw = path.text.replace(/^"|"$/g, "");
      const last = raw.split("/").pop() ?? raw;
      if (last) refs.add(last);
    }
  }
  for (const child of node.children) goRefs(child, refs);
}

// Rust use 声明结构多样(use_list/嵌套/通配),按文本拆 token 比逐节点走简单且够用。
function rustRefs(node: TsNodeLike, refs: Set<string>): void {
  if (node.type === "use_declaration") {
    const tokens = node.text
      .replace(/^use\s*/, "").replace(/;$/, "")
      .split(/::|\{|\}|,|\s+/).map((t) => t.trim()).filter(Boolean);
    for (const t of tokens) refs.add(t);
  }
  for (const child of node.children) rustRefs(child, refs);
}

function javaRefs(node: TsNodeLike, refs: Set<string>): void {
  if (node.type === "import_declaration") {
    const last = node.text.replace(/^import\s+(static\s+)?/, "").replace(/;$/, "").split(".").pop();
    if (last) refs.add(last);
  }
  for (const child of node.children) javaRefs(child, refs);
}

function collectRefs(lang: LangDef, root: TsNodeLike): { refs: string[]; importSources: string[] } {
  const refs = new Set<string>();
  const sources = new Set<string>();
  const grammar = lang.grammar;
  if (grammar.includes("typescript") || grammar.includes("javascript")) tsRefs(root, refs, sources);
  else if (grammar.includes("python")) pyRefs(root, refs, sources);
  else if (grammar.includes("go")) goRefs(root, refs);
  else if (grammar.includes("rust")) rustRefs(root, refs);
  else if (grammar.includes("java")) javaRefs(root, refs);
  return { refs: [...refs], importSources: [...sources] };
}

// 解析单文件。grammar 加载失败/文件读失败/解析失败都返回 null(调用方跳过,不让单文件问题拖垮整体)。
export async function extractFile(absPath: string, lang: LangDef): Promise<FileExtract | null> {
  const language = await loadGrammar(lang.grammar);
  if (!language) return null;
  let source: string;
  try {
    source = await fs.readFile(absPath, "utf8");
  } catch {
    return null;
  }
  if (!source.trim()) return null;
  const parser = getParser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) return null;
  try {
    const srcLines = source.split("\n");
    const defs: SymbolDef[] = [];
    const root = tree.rootNode as unknown as TsNodeLike;
    walkDefs(root, lang, srcLines, defs);
    const { refs, importSources } = collectRefs(lang, root);
    return { defs, refs, importSources };
  } finally {
    tree.delete();
  }
}
