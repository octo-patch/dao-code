import { describe, it, expect } from "vitest";
import { buildGraph, type FileEntry } from "./graph.js";
import type { FileExtract } from "./extract.js";

function entry(rel: string, defNames: string[], refs: string[] = [], sources: string[] = []): FileEntry {
  const extract: FileExtract = {
    defs: defNames.map((n) => ({ name: n, kind: "function_declaration", startLine: 1, signature: `function ${n}() {}` })),
    refs,
    importSources: sources,
  };
  return { rel, extract };
}

describe("buildGraph", () => {
  it("名字边:A import 的名字命中 B 的 def → A→B", () => {
    const { edges, ranks } = buildGraph([
      entry("a.ts", ["core"]),
      entry("b.ts", [], ["core"]),
      entry("c.ts", ["unrelated"]),
    ]);
    expect(edges.get("b.ts")).toContain("a.ts");
    expect(ranks.get("a.ts")!).toBeGreaterThan(ranks.get("b.ts")!);
    expect(ranks.get("b.ts")!).toBeGreaterThan(0);
  });

  it("路径边:相对 import 直接解析到文件(补扩展名)", () => {
    const { edges } = buildGraph([
      entry("src/main.ts", ["main"], [], ["./util"]),
      entry("src/util.ts", ["helper"]),
    ]);
    expect(edges.get("src/main.ts")).toContain("src/util.ts");
  });

  it("路径边:../ 回上级 + index 文件命中", () => {
    const { edges } = buildGraph([
      entry("src/sub/inner.ts", [], [], [".././api"]),
      entry("src/api/index.ts", ["apiFn"]),
    ]);
    expect(edges.get("src/sub/inner.ts")).toContain("src/api/index.ts");
  });

  it("自引用不算依赖", () => {
    const { edges } = buildGraph([
      entry("a.ts", ["selfRef"], ["selfRef"]),
    ]);
    expect(edges.get("a.ts") ?? new Set()).not.toContain("a.ts");
  });

  it("PageRank:被多个文件依赖的核心模块 rank 最高", () => {
    // star 结构:core 被 a/b/c 依赖;b 也被 a 依赖
    const { ranks } = buildGraph([
      entry("core.ts", ["coreFn"]),
      entry("b.ts", ["bFn"], ["coreFn"]),
      entry("a.ts", [], ["coreFn", "bFn"]),
      entry("c.ts", [], ["coreFn"]),
      entry("lonely.ts", ["lonely"]),
    ]);
    expect(ranks.get("core.ts")!).toBeGreaterThan(ranks.get("b.ts")!);
    expect(ranks.get("b.ts")!).toBeGreaterThan(ranks.get("lonely.ts")!);
    // 总 rank ≈ 1(概率守恒,允许浮点误差)
    const total = [...ranks.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("空输入不崩", () => {
    const { ranks, edges } = buildGraph([]);
    expect(ranks.size).toBe(0);
    expect(edges.size).toBe(0);
  });
});
