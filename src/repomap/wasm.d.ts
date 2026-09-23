// `import x from "*.wasm"` 只在 bun 构建路径(wasm-assets.ts)里出现;tsc 靠本声明认识它。
// bun build --compile 内嵌后运行时拿到的是虚拟路径 string;bun 直跑同理。
declare module "*.wasm" {
  const path: string;
  export default path;
}
