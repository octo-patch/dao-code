import { promises as fs } from "node:fs";
import path from "node:path";
import { isForeignSkill } from "./adapt.js";
import { contentHash } from "../memory/hash.js";

// 外来技能正文 → DAO 适配。检测为他者所写时,用辅助模型一次性按【用途】重写工具名(无翻译字典),
// 目标词表是 dao 自己的工具注册表;按源 hash 缓存到磁盘(一个技能版本只转一次);
// 辅助模型不可用时退回"原文 + 通用提示"(仍无字典)。

export type FlashCall = (system: string, user: string) => Promise<string>;

export interface AdapterDeps {
  daoTools: Set<string>; // dao 工具名集合(检测"非 dao 工具形 token"用)
  catalog: string; // 目标词表:"Read — 读文件\nBash — 跑命令\n…"
  callFlash: FlashCall;
  homeDir: string; // 缓存根(~/.dao/skill-adapted/)
}

export function convertSystemPrompt(catalog: string): string {
  return [
    "你在把一段【为其它编码 agent(Claude Code / Codex / Gemini CLI / Cursor 等)所写的 skill 正文】适配到 DAO CODE。",
    "DAO CODE 只有这些工具(工具名 — 用途):",
    catalog,
    "",
    "要求:",
    "1. 正文里出现的【外来工具名】按用途替换成上面对应的 DAO 工具名(读文件→Read、跑命令→Bash、改文件→Edit、搜代码→Grep…);没有对应的就用最贴近用途的,或改写成自然语言描述该动作。",
    "2. 跨引用(如 superpowers:xxx)改成 DAO 里按裸技能名加载(`xxx`)。",
    "3. 【外来模型档】(haiku / sonnet / opus / mini / flash 等)没有通用的网关模型 ID；转换后的子代理默认省略 model，继承当前主模型，不要编造或硬编码供应商模型名。",
    "4. 凡'换更便宜的模型 / 用独立上下文 / dispatch 一个 subagent 去做 X'这类意图——【包括原文让主流程/主循环切到便宜模型干活的】——统一改写成 DAO 的子代理模式:用 agent 工具派子代理，默认继承主模型；只有用户明确提供当前网关可用的完整模型 ID 时才保留显式 model。",
    "5. 【只改工具名/模型名/平台相关表述】,其余指令、结构、语气、示例一字不动,保持原意。",
    "6. 直接输出适配后的 skill 正文,不要任何前后说明、不要用代码围栏包裹。若正文本就只用 DAO 工具与模型、无需改动,原样返回。",
  ].join("\n");
}

const GENERIC_NOTE =
  "## 本平台适配(此技能为其它 agent 所写)\n" +
  "正文若出现非本平台的工具名(如 Read/Bash/Edit/apply_patch 等),按【用途】映射到你自己的 DAO 工具" +
  "(读文件/跑命令/改文件/搜代码…);跨引用 `superpowers:xxx` 按裸名 `xxx` 加载。\n" +
  "外来模型档(haiku/sonnet/opus 等)不代表当前网关的模型 ID；子代理默认继承主模型，不要猜测供应商模型名;" +
  "'换便宜模型/独立上下文/派 subagent'(含让主流程换模型的)一律改成用 agent 工具派子代理(独立上下文，默认省略 model；只有用户明确提供网关可用的完整 ID 时才指定 model)。\n\n";

// 返回一个 adapter:外来技能→转换(缓存优先);dao 原生技能→原样。
export function makeSkillAdapter(deps: AdapterDeps): (body: string) => Promise<string> {
  const cacheDir = path.join(deps.homeDir, ".dao", "skill-adapted");
  return async (body: string) => {
    if (!isForeignSkill(body, deps.daoTools)) return body; // dao 原生:不动
    const cacheFile = path.join(cacheDir, `${contentHash(`inherit-model-v2\n${deps.catalog}\n${body}`)}.md`);
    const cached = await fs.readFile(cacheFile, "utf8").catch(() => "");
    if (cached) return cached; // 同版本已转过:免费命中
    try {
      const out = (await deps.callFlash(convertSystemPrompt(deps.catalog), body)).trim();
      if (out) {
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(cacheFile, out, "utf8").catch(() => {});
        return out;
      }
    } catch { /* 落到兜底 */ }
    return GENERIC_NOTE + body; // 辅助模型不可用/失败:无字典兜底
  };
}
