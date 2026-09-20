import { describe, it, expect } from "vitest";
import { askUserTool } from "./ask_user.js";

describe("AskUserQuestion tool", () => {
  it("returns the user's answer via ctx.ask", async () => {
    const out = await askUserTool.handler(
      { question: "favorite color?" },
      { workspaceRoot: "/tmp", ask: async () => "blue" },
    );
    expect(out).toBe("blue");
  });

  it("passes the question to ctx.ask", async () => {
    let asked = "";
    await askUserTool.handler(
      { question: "which env?" },
      { workspaceRoot: "/tmp", ask: async (q) => { asked = q; return "prod"; } },
    );
    expect(asked).toBe("which env?");
  });

  it("returns a placeholder when the answer is empty", async () => {
    const out = await askUserTool.handler(
      { question: "x?" },
      { workspaceRoot: "/tmp", ask: async () => "   " },
    );
    expect(out).toBe("(用户未回答)");
  });

  it("throws when ask is not configured", async () => {
    await expect(
      askUserTool.handler({ question: "x?" }, { workspaceRoot: "/tmp" }),
    ).rejects.toThrow(/ask 未配置/);
  });

  it("routes to ctx.askChoice (↑↓+Enter 选择器) when options are given", async () => {
    let askedOpts: string[] = [];
    const out = await askUserTool.handler(
      { question: "选哪个方案?", options: ["方案 A", "方案 B"] },
      {
        workspaceRoot: "/tmp",
        ask: async () => "不该走到这",
        askChoice: async (_q, opts) => { askedOpts = opts; return "方案 B"; },
      },
    );
    expect(out).toBe("方案 B");
    expect(askedOpts).toEqual(["方案 A", "方案 B"]);
  });

  it("falls back to ctx.ask (free text) when askChoice is unavailable", async () => {
    const out = await askUserTool.handler(
      { question: "选哪个?", options: ["A", "B"] },
      { workspaceRoot: "/tmp", ask: async () => "我自己写一个" },
    );
    expect(out).toBe("我自己写一个");
  });

  it("declares auto approval", () => {
    expect(askUserTool.approval).toBe("auto");
    expect(askUserTool.name).toBe("AskUserQuestion");
  });

  // ---- 多问题模式(questions 数组) ----

  it("asks multiple questions sequentially and joins results", async () => {
    const asked: string[] = [];
    const out = await askUserTool.handler(
      {
        questions: [
          { question: "用什么框架?", options: [{ label: "React" }, { label: "Vue" }] },
          { question: "用什么语言?", options: [{ label: "TypeScript" }, { label: "JavaScript" }] },
        ],
      },
      {
        workspaceRoot: "/tmp",
        ask: async () => "不该走到这",
        askChoice: async (q) => { asked.push(q); return q.includes("框架") ? "React" : "TypeScript"; },
      },
    );
    expect(asked).toEqual(["用什么框架?", "用什么语言?"]);
    expect(out).toBe("[1. 用什么框架?] React\n[2. 用什么语言?] TypeScript");
  });

  it("中间问题选'先讨论一下':已答的带标号返回,讨论项标注,后续问题标注未问且不再弹出", async () => {
    const asked: string[] = [];
    const discussValue = "我想先讨论一下,先别急着定方向。";
    const out = await askUserTool.handler(
      {
        questions: [
          { question: "用什么框架?", options: [{ label: "React" }, { label: "Vue" }] },
          { question: "用什么语言?", options: [{ label: "TypeScript" }, { label: "JavaScript" }] },
          { question: "用什么数据库?", options: [{ label: "Postgres" }, { label: "MySQL" }] },
        ],
      },
      {
        workspaceRoot: "/tmp",
        ask: async () => "不该走到这",
        askChoice: async (q) => {
          asked.push(q);
          // 问题 2 选"先讨论一下"
          return q.includes("语言") ? discussValue : "React";
        },
      },
    );
    // 问题 1、2 弹出了,问题 3 没弹
    expect(asked).toEqual(["用什么框架?", "用什么语言?"]);
    // 返回格式:已答带标号、讨论项标注、未问项标注
    expect(out).toBe(
      "[1. 用什么框架?] React\n" +
      "[2. 用什么语言?] ⚠ 用户想先讨论一下,先别急着定方向。\n" +
      "[3. 用什么数据库?] (未问——用户要求先讨论)",
    );
  });

  it("structured options with description are passed as 'label - description'", async () => {
    let receivedOpts: string[] = [];
    await askUserTool.handler(
      {
        questions: [
          {
            question: "认证方式?",
            options: [
              { label: "OAuth", description: "第三方授权" },
              { label: "API Key", description: "简单直接" },
            ],
          },
        ],
      },
      {
        workspaceRoot: "/tmp",
        ask: async () => "不该走到这",
        askChoice: async (_q, opts) => { receivedOpts = opts; return "OAuth"; },
      },
    );
    expect(receivedOpts).toEqual(["OAuth - 第三方授权", "API Key - 简单直接"]);
  });

  it("throws when both question and questions are provided", async () => {
    await expect(
      askUserTool.handler(
        { question: "a?", questions: [{ question: "b?" }] },
        { workspaceRoot: "/tmp", ask: async () => "x" },
      ),
    ).rejects.toThrow(/二选一/);
  });

  it("throws when neither question nor questions is provided", async () => {
    await expect(
      askUserTool.handler({}, { workspaceRoot: "/tmp", ask: async () => "x" }),
    ).rejects.toThrow(/必须传/);
  });

  it("shorthand mode still works (backward compat)", async () => {
    const out = await askUserTool.handler(
      { question: "选哪个?", options: ["A", "B"], multiSelect: true },
      {
        workspaceRoot: "/tmp",
        ask: async () => "不该走到这",
        askChoice: async (_q, opts, multi) => {
          expect(multi).toBe(true);
          expect(opts).toEqual(["A", "B"]);
          return "A";
        },
      },
    );
    expect(out).toBe("A");
  });
});
