// repo map 渲染:按 PageRank 排文件、按预算裁符号,输出 aider 风格的折叠地图。
// 格式(与 aider 一致,模型对这个格式的"这是签名不是全文"有良好直觉):
//   src/foo.ts:
//   ⋮...
//   │class Service {
//   ⋮...
//   │  method(arg: string): void
//   ⋮...
import type { SymbolDef } from "./extract.js";

export interface RenderedFile {
  rel: string;
  defs: SymbolDef[];
}

// token 估算对齐 compact.ts 的口径(字符数 / 3)。
const estTokens = (s: string): number => Math.ceil(s.length / 3);

export function renderRepoMap(files: RenderedFile[], tokenBudget: number): string {
  const HEADER_MARGIN = 120; // 头部说明 + 文件名行的预算余量
  const blocks: string[] = [];
  let used = 0;

  for (const file of files) {
    const fileHeaderTokens = estTokens(file.rel + ":\n");
    if (used + fileHeaderTokens > tokenBudget - HEADER_MARGIN) break;

    // 文件内逐符号累加;符号加不下就截断该文件(保留 ⋮... 提示还有更多)
    const sigLines: string[] = [];
    let fileUsed = fileHeaderTokens;
    let truncated = false;
    for (const def of file.defs) {
      const sigText = def.signature;
      const tokens = estTokens(`│${sigText.split("\n").join("\n│")}\n`) + 6; // ⋮... 行的余量
      if (used + fileUsed + tokens > tokenBudget - HEADER_MARGIN) { truncated = true; break; }
      sigLines.push("⋮...", ...sigText.split("\n").map((l) => `│${l}`));
      fileUsed += tokens;
    }
    if (sigLines.length === 0) continue;
    if (truncated) sigLines.push("⋮...");
    used += fileUsed;
    blocks.push(`${file.rel}:\n${sigLines.join("\n")}`);
  }

  if (blocks.length === 0) return "";
  return blocks.join("\n\n");
}
