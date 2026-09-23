// wasm 定位 + tree-sitter 运行时/grammar 懒加载(进程级单例)。
// 两种运行环境,两条定位路径:
// - bun(含 bun build --compile 单文件二进制):动态 import ./wasm-assets.js——静态引用的
//   wasm 已内嵌进二进制,拿到的是 /$bunfs/ 虚拟路径,readFile 可读。绝不能用裸包名
//   import.meta.resolve/require.resolve(compile 后 node_modules 不存在,会报
//   "Cannot find package")。
// - node(tsx dev / vitest):createRequire().resolve 定位 node_modules 里的实际文件。
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// wasm 文件名 → 已解析的绝对路径(bun)/包内子路径(node)。bun 下加载 wasm-assets 时填充。
let bunAssetPaths: Record<string, string> | null = null;

async function resolveBunAssets(): Promise<Record<string, string>> {
  if (!bunAssetPaths) {
    const mod = await import("./wasm-assets.js");
    bunAssetPaths = mod.bunWasmAssets;
  }
  return bunAssetPaths;
}

// 定位单个 wasm 文件,返回可交给 readFile 的路径。找不到返回 undefined(调用方跳过该语言)。
async function locateWasm(file: string): Promise<string | undefined> {
  if (isBun) {
    const assets = await resolveBunAssets();
    return assets[file];
  }
  try {
    const req = createRequire(import.meta.url);
    const spec = file === "tree-sitter.wasm"
      ? "web-tree-sitter/tree-sitter.wasm"
      : `tree-sitter-wasms/out/${file}`;
    return req.resolve(spec);
  } catch {
    return undefined;
  }
}

let parserReady: Promise<void> | undefined;

// 初始化 web-tree-sitter 运行时(进程级一次)。失败抛错,调用方决定降级。
export function ensureParser(): Promise<void> {
  if (!parserReady) {
    parserReady = (async () => {
      const wasmPath = await locateWasm("tree-sitter.wasm");
      if (!wasmPath) throw new Error("repomap: 找不到 tree-sitter 运行时 wasm(web-tree-sitter/tree-sitter.wasm)");
      const bin = await readFile(wasmPath);
      // locateFile 指向内嵌/解析出的路径,绕开 emscripten 的默认相对路径查找
      // (bun compile 下默认路径 /$bunfs/root/tree-sitter.wasm 不存在)。
      await Parser.init({
        locateFile: () => wasmPath,
        wasmBinary: bin.buffer as ArrayBuffer,
      } as Parameters<typeof Parser.init>[0]);
    })();
  }
  return parserReady;
}

const languageCache = new Map<string, Promise<Language | null>>();

// 按 grammar 文件名懒加载语言(进程级缓存;加载失败缓存 null,该语言被跳过而不是反复重试)。
export function loadGrammar(grammarFile: string): Promise<Language | null> {
  let p = languageCache.get(grammarFile);
  if (!p) {
    p = (async () => {
      await ensureParser();
      const wasmPath = await locateWasm(grammarFile);
      if (!wasmPath) return null;
      try {
        return await Language.load(wasmPath);
      } catch {
        return null;
      }
    })();
    languageCache.set(grammarFile, p);
  }
  return p;
}

// 测试辅助:重置进程级单例(生产代码不用)。
export function resetRepomapRuntimeForTest(): void {
  parserReady = undefined;
  languageCache.clear();
  bunAssetPaths = null;
}
