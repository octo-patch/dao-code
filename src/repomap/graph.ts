// 文件依赖图 + PageRank。
// 边的语义:A 引用了 B(A import B / A 里出现了 B 定义的符号)→ A→B。
// rank 流向:被引用多的文件(公共库/核心模块)rank 高——正是 repo map 最该展示的部分。
import path from "node:path";
import type { FileExtract } from "./extract.js";

export interface FileEntry {
  rel: string; // 相对仓库根的路径
  extract: FileExtract;
}

// 解析相对 import 源("./foo" → 尝试补扩展名/索引文件命中已知文件)。
function resolveImportSource(from: string, source: string, knownFiles: Set<string>): string | null {
  const base = source.split("/").filter((s) => s !== ".").join("/");
  const candidates: string[] = [];
  const pushWithExts = (p: string) => {
    candidates.push(p, ...EXT_CANDIDATES.map((e) => p + e));
    candidates.push(`${p}/index${""}`);
    for (const e of EXT_CANDIDATES) candidates.push(`${p}/index${e}`);
  };
  pushWithExts(base.replace(/^\.\//, ""));
  for (const c of candidates) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), c));
    if (knownFiles.has(resolved)) return resolved;
  }
  return null;
}

const EXT_CANDIDATES = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".go", ".rs", ".java",
];

export interface GraphResult {
  ranks: Map<string, number>; // rel path → PageRank 分数
  edges: Map<string, Set<string>>; // A → 引用的文件集合
}

// 构图:路径边(相对 import 直接 resolve)+ 名字边(import 名 ↔ 其它文件 def 名)。
export function buildGraph(entries: FileEntry[]): GraphResult {
  const knownFiles = new Set(entries.map((e) => e.rel));
  // def 名 → 定义它的文件集合(全局倒排;同名 def 在多文件出现时全连,粗但有效)
  const defIndex = new Map<string, Set<string>>();
  for (const e of entries) {
    for (const d of e.extract.defs) {
      let set = defIndex.get(d.name);
      if (!set) defIndex.set(d.name, (set = new Set()));
      set.add(e.rel);
    }
  }

  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    if (from === to) return; // 自引用不算依赖
    let set = edges.get(from);
    if (!set) edges.set(from, (set = new Set()));
    set.add(to);
  };

  for (const e of entries) {
    for (const src of e.extract.importSources) {
      const target = resolveImportSource(e.rel, src, knownFiles);
      if (target) addEdge(e.rel, target);
    }
    for (const ref of e.extract.refs) {
      const targets = defIndex.get(ref);
      if (targets) for (const t of targets) addEdge(e.rel, t);
    }
  }

  return { ranks: pageRank(edges, knownFiles), edges };
}

// 标准 PageRank:damping 0.85,均匀 teleport,迭代到收敛或 30 轮。
function pageRank(edges: Map<string, Set<string>>, nodes: Set<string>): Map<string, number> {
  const n = nodes.size;
  if (n === 0) return new Map();
  const DAMPING = 0.85;
  const ITERATIONS = 30;

  // 出度(每条边的目标数;出度为 0 的悬挂节点把 rank 均摊回全体)
  const outDegree = new Map<string, number>();
  for (const [from, tos] of edges) outDegree.set(from, tos.size);

  let rank = new Map<string, number>();
  for (const node of nodes) rank.set(node, 1 / n);
  const sinkMass = (r: Map<string, number>): number => {
    let mass = 0;
    for (const [node, v] of r) if (!outDegree.get(node)) mass += v;
    return mass;
  };

  for (let it = 0; it < ITERATIONS; it++) {
    const next = new Map<string, number>();
    const base = (1 - DAMPING) / n;
    for (const node of nodes) next.set(node, base);
    // 悬挂节点均摊
    const dangling = (DAMPING * sinkMass(rank)) / n;
    for (const node of nodes) next.set(node, (next.get(node) ?? 0) + dangling);
    for (const [from, tos] of edges) {
      const share = (DAMPING * (rank.get(from) ?? 0)) / tos.size;
      for (const to of tos) next.set(to, (next.get(to) ?? 0) + share);
    }
    rank = next;
  }
  return rank;
}
