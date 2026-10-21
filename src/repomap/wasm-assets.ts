// bun 构建专用:wasm 资源静态引用表。
// ⚠️ 本文件【只允许】被 loader.ts 在 bun 环境(typeof Bun !== "undefined")下动态 import——
// 顶层的 `import x from "*.wasm"` 语法只在 bun 下有意义(bun build --compile 会把静态引用的
// wasm 内嵌进单文件二进制,运行时返回 /$bunfs/ 虚拟路径);node/tsx/vitest 下顶层 import
// .wasm 会直接抛模块类型错误。因此绝不能在其它模块顶层静态 import 本文件。
import runtimeWasm from "web-tree-sitter/tree-sitter.wasm";
import grammarTypescript from "tree-sitter-wasms/out/tree-sitter-typescript.wasm";
import grammarTsx from "tree-sitter-wasms/out/tree-sitter-tsx.wasm";
import grammarJavascript from "tree-sitter-wasms/out/tree-sitter-javascript.wasm";
import grammarPython from "tree-sitter-wasms/out/tree-sitter-python.wasm";
import grammarGo from "tree-sitter-wasms/out/tree-sitter-go.wasm";
import grammarRust from "tree-sitter-wasms/out/tree-sitter-rust.wasm";
import grammarJava from "tree-sitter-wasms/out/tree-sitter-java.wasm";

// grammar 名与 tree-sitter-wasms 产物文件名对齐(见 languages.ts 的 grammar 字段)。
export const bunWasmAssets: Record<string, string> = {
  "tree-sitter.wasm": runtimeWasm,
  "tree-sitter-typescript.wasm": grammarTypescript,
  "tree-sitter-tsx.wasm": grammarTsx,
  "tree-sitter-javascript.wasm": grammarJavascript,
  "tree-sitter-python.wasm": grammarPython,
  "tree-sitter-go.wasm": grammarGo,
  "tree-sitter-rust.wasm": grammarRust,
  "tree-sitter-java.wasm": grammarJava,
};
