import { z } from "zod";
import { defineTool } from "./types.js";
import { buildRepoMap, repoMapTokenBudget, wrapRepoMapNotice } from "../repomap/index.js";
import { getLang } from "../i18n/i18n.js";

// 代码库地图(aider 风格 repo map):tree-sitter 提取全仓库定义签名,PageRank 排重要性,
// token 预算裁剪。启动时自动构建并注入过一次;本工具用于【改完文件后刷新】或主动查看。
export const repoMapTool = defineTool({
  name: "RepoMap",
  description:
    "构建/刷新代码库地图:tree-sitter 提取全仓库的类/函数/方法定义签名,按被依赖程度(PageRank)排序," +
    "token 预算内输出 aider 风格的折叠地图。启动时已自动注入过一份(尾部 system 消息)——本工具的典型用途是" +
    "【改动较多文件后地图过期时刷新】(refresh=true),或需要更大预算细看某个大仓库时传 max_tokens。" +
    "定位'某功能定义在哪个文件'优先看地图而不是逐个 Grep;选中目标后用 Read 读完整实现。",
  descriptionEn:
    "Build/refresh the codebase map: tree-sitter extracts class/function/method definition signatures across the " +
    "whole repo, ranked by PageRank (most-depended-upon first), rendered as an aider-style folded map within a token " +
    "budget. One was auto-injected at startup (trailing system message) — typical uses here: refresh after editing " +
    "many files (refresh=true), or pass max_tokens for a bigger budget when exploring a large repo. Prefer the map " +
    "over blind Grep to locate where a feature is defined; Read the chosen file for full context.",
  capability: "read",
  approval: "auto",
  shouldDefer: true,
  schema: z.object({
    refresh: z.boolean().optional().describe("强制重新扫描(默认 false 复用缓存;未变更的文件按 mtime 跳过重解析)"),
    max_tokens: z.number().int().min(256).max(16384).optional().describe("token 预算覆盖(默认 DAO_REPO_MAP_TOKENS 或 2048)"),
  }),
  handler: async (args, ctx) => {
    const root = ctx.cwd ?? ctx.workspaceRoot;
    const budget = args.max_tokens ?? repoMapTokenBudget();
    const result = await buildRepoMap(root, budget);
    if (!result.text) {
      return getLang() === "en"
        ? `No supported-language source files found under ${root} (supported: TS/JS/Python/Go/Rust/Java).`
        : `在 ${root} 下没找到支持语言的源文件(支持:TS/JS/Python/Go/Rust/Java)。`;
    }
    const isEn = getLang() === "en";
    const note = wrapRepoMapNotice(result.text, isEn, result.fileCount);
    const footer = result.truncated
      ? (isEn ? `\n(note: repo has more files than the scan cap; map covers the first batch)` : `\n(注:仓库文件数超过扫描上限,地图只覆盖前一批)`)
      : "";
    return note + footer;
  },
});
