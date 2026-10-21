// repo map 构建入口:遍历 → 提取(带 mtime 缓存)→ PageRank → 预算裁剪渲染。
// 集成层(index.ts)启动时后台调用一次,结果作为尾部 system 消息注入(不进固定前缀);
// RepoMap 工具 refresh 时复用缓存增量重建。
import { promises as fs } from "node:fs";
import { walkFiles } from "../tools/walk.js";
import { langForFile } from "./languages.js";
import { extractFile, type FileExtract } from "./extract.js";
import { buildGraph } from "./graph.js";
import { renderRepoMap, type RenderedFile } from "./render.js";

export const DEFAULT_TOKEN_BUDGET = 2048;
const MAX_FILES = 4000; // 超大仓库截断保护(monorepo 全量扫会拖慢启动)
const MAX_FILE_BYTES = 512 * 1024; // 单文件 >512KB 跳过(生成产物/巨型 bundle)

// 会话级单文件缓存:mtime+size 未变则复用上次的提取结果(refresh 时只重 parse 变更文件)。
const fileCache = new Map<string, { mtimeMs: number; size: number; extract: FileExtract | null }>();

export interface RepoMapResult {
  text: string; // 渲染后的地图(空 = 没有可提取的内容)
  fileCount: number; // 实际解析的文件数
  truncated: boolean; // 是否因 MAX_FILES 截断
}

export function repoMapTokenBudget(): number {
  const v = Number(process.env.DAO_REPO_MAP_TOKENS);
  // 0 = 显式禁用 repo map(集成层据此跳过构建);非法/未设 = 默认预算。
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_TOKEN_BUDGET;
}

export async function buildRepoMap(root: string, tokenBudget = repoMapTokenBudget()): Promise<RepoMapResult> {
  const files: Array<{ abs: string; rel: string }> = [];
  for await (const f of walkFiles(root)) {
    if (!langForFile(f.rel)) continue;
    if (/\.min\.|\.d\.ts$/.test(f.rel)) continue; // 压缩产物/类型声明不进地图
    files.push(f);
    if (files.length >= MAX_FILES) break;
  }
  const truncated = files.length >= MAX_FILES;

  const entries: Array<{ rel: string; extract: FileExtract }> = [];
  for (const f of files) {
    let st;
    try {
      st = await fs.stat(f.abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES || st.size === 0) continue;
    const cached = fileCache.get(f.abs);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      if (cached.extract) entries.push({ rel: f.rel, extract: cached.extract });
      continue;
    }
    const lang = langForFile(f.rel)!;
    const extract = await extractFile(f.abs, lang);
    fileCache.set(f.abs, { mtimeMs: st.mtimeMs, size: st.size, extract });
    if (extract) entries.push({ rel: f.rel, extract });
  }

  if (entries.length === 0) return { text: "", fileCount: 0, truncated };

  const { ranks } = buildGraph(entries);
  const ranked: RenderedFile[] = entries
    .map((e) => ({ rel: e.rel, defs: e.extract.defs, rank: ranks.get(e.rel) ?? 0 }))
    .sort((a, b) => b.rank - a.rank || a.rel.localeCompare(b.rel))
    .map(({ rel, defs }) => ({ rel, defs }));

  const body = renderRepoMap(ranked, tokenBudget);
  return { text: body, fileCount: entries.length, truncated };
}

// 注入层包装:打 tag + 使用说明(对齐 env_snapshot.ts wrapDelayedEnvNotice 的模式)。
export function wrapRepoMapNotice(mapText: string, isEn: boolean, fileCount: number): string {
  if (!mapText.trim()) return "";
  return isEn
    ? `<codebase-map note="repo map built at process launch (tree-sitter definitions, PageRank-ranked, budget-capped)">\n` +
      `Files below are ranked by importance (most-depended-upon first). │ lines are class/function/method signatures (not full bodies); ⋮... marks elided code. ` +
      `Use this map to locate the right file, then Read for full context. It may be stale after edits — refresh with the RepoMap tool (refresh=true). Parsed ${fileCount} files.\n` +
      `${mapText}\n</codebase-map>`
    : `<代码库地图 说明="进程启动时构建(tree-sitter 提取的定义签名,按 PageRank 重要性排序,token 预算裁剪)">\n` +
      `下方文件按重要性(被依赖程度)排序。│ 行是类/函数/方法的签名(非完整实现),⋮... 表示省略。` +
      `定位代码优先看这张地图,选中目标文件后用 Read 读完整实现。改完文件地图可能过期——用 RepoMap 工具(refresh=true)可刷新。共解析 ${fileCount} 个文件。\n` +
      `${mapText}\n</代码库地图>`;
}

// 测试辅助:清空会话级缓存。
export function resetRepoMapCacheForTest(): void {
  fileCache.clear();
}
