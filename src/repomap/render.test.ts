import { describe, it, expect } from "vitest";
import { renderRepoMap, type RenderedFile } from "./render.js";

function file(rel: string, defs: Array<[string, string]>): RenderedFile {
  return {
    rel,
    defs: defs.map(([name, sig]) => ({ name, kind: "function_declaration", startLine: 1, signature: sig })),
  };
}

describe("renderRepoMap", () => {
  it("aider 风格:文件名 + ⋮... + │ 签名行", () => {
    const out = renderRepoMap([
      file("src/a.ts", [["foo", "function foo(x: number): string"]]),
    ], 2000);
    expect(out).toContain("src/a.ts:");
    expect(out).toContain("⋮...");
    expect(out).toContain("│function foo(x: number): string");
  });

  it("多行签名逐行加 │ 前缀", () => {
    const out = renderRepoMap([
      file("src/b.ts", [["create", "function create(\n  a: string,\n  b: number,\n)"]]),
    ], 2000);
    expect(out).toContain("│function create(");
    expect(out).toContain("│  a: string,");
    expect(out).toContain("│)"); // 多行签名都保留(帮助模型理解参数)
  });

  it("预算耗尽:后续文件不再加入", () => {
    const big = "x".repeat(300); // 一个符号 ~106 token(300/3 + 余量)
    const files = [
      file("a.ts", [["f1", big]]),
      file("b.ts", [["f2", big]]),
      file("c.ts", [["f3", big]]),
    ];
    // 预算 380:扣除 HEADER_MARGIN(120)后剩 260,装得下 a+b(各 ~108),c 超出
    const out = renderRepoMap(files, 380);
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
    expect(out).not.toContain("c.ts");
  });

  it("预算内文件符号加不下时截断该文件(⋮... 收尾)", () => {
    const sig1 = "function f1() { " + "x".repeat(300);
    const sig2 = "function f2() { " + "y".repeat(300);
    const files = [
      file("a.ts", [
        ["f1", sig1],
        ["f2", sig2],
      ]),
    ];
    const out = renderRepoMap(files, 260);
    expect(out).toContain("a.ts");
    expect(out).toContain(sig1.slice(0, 40)); // 第一个符号进来了
    expect(out).not.toContain(sig2.slice(0, 40)); // 第二个被预算截断
    expect(out.trimEnd().endsWith("⋮...")).toBe(true); // 截断标记收尾
  });

  it("空文件列表返回空串", () => {
    expect(renderRepoMap([], 2000)).toBe("");
  });
});
