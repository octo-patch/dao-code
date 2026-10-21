import type { DurableStore } from "../session/durable_store.js";
import { repairToolPairs } from "../session/recovery.js";
// src/agent/resume_agent.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../client/types.js";
import { ONE_SHOT_AGENT_TYPES } from "./agent_tools.js";
import type { AgentDef } from "./agent_defs.js";
import type { CacheSafeParams } from "./runAgent.js";
import { runAsyncAgentLifecycle, type AsyncAgentTaskManager } from "./agent_lifecycle.js";
import { getAgentModel } from "../config/model_selection.js";

/** 逐条写入 sidechain 转录(fire-and-forget) */
export async function recordSidechainMessage(subagentsDir: string, agentId: string, message: ChatMessage): Promise<void> {
  try {
    await fs.mkdir(subagentsDir, { recursive: true });
    await fs.appendFile(path.join(subagentsDir, `${agentId}.jsonl`), JSON.stringify(message) + "\n", "utf8");
  } catch { /* fire-and-forget */ }
}

/** 写入 agent 元数据 */
export async function writeAgentMetadata(subagentsDir: string, agentId: string, meta: { agentType: string; description?: string; worktreePath?: string; model?: string }): Promise<void> {
  try {
    await fs.mkdir(subagentsDir, { recursive: true });
    await fs.writeFile(path.join(subagentsDir, `${agentId}.meta.json`), JSON.stringify(meta, null, 2), "utf8");
  } catch { /* fire-and-forget */ }
}

/** 读取转录 */
export async function getAgentTranscript(subagentsDir: string, agentId: string): Promise<{ messages: ChatMessage[] } | null> {
  try {
    const raw = await fs.readFile(path.join(subagentsDir, `${agentId}.jsonl`), "utf8");
    const messages: ChatMessage[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim()) try { messages.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return { messages };
  } catch { return null; }
}

/** 读取元数据 */
export async function readAgentMetadata(subagentsDir: string, agentId: string): Promise<{ agentType: string; description?: string; worktreePath?: string; model?: string } | null> {
  try { return JSON.parse(await fs.readFile(path.join(subagentsDir, `${agentId}.meta.json`), "utf8")); }
  catch { return null; }
}

/** 过滤未配对 tool_use 的 assistant 消息 */
export function filterIncompleteToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const idsWithResults = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) idsWithResults.add(m.tool_call_id);
  }
  return messages.filter((m) => {
    if (m.role === "assistant" && m.tool_calls) {
      return !m.tool_calls.some((tc) => !idsWithResults.has(tc.id));
    }
    return true;
  });
}

/** 恢复已结束的子代理(参考 resumeAgentBackground) */
export async function resumeAgentBackground(opts: {
  parentModel?: string;
  durableStore?: DurableStore;
  agentId: string;
  prompt: string;
  subagentsDir: string;
  agentDefs: AgentDef[];
  runAgent: (params: {
    model?: string;
    agentDef: AgentDef;
    promptMessages: ChatMessage[];
    isAsync: boolean;
    override?: { abortController?: AbortController; agentId?: string };
    worktreePath?: string;
    onCacheSafeParams?: (params: CacheSafeParams) => void;
    messageParent?: (text: string, kind?: import("./background_types.js").MessageKind) => void;
  }) => AsyncGenerator<ChatMessage, void>;
  registerAsyncAgent: (opts: { agentId: string; description: string }) => { agentId: string; runId?: string; abortController: AbortController };
  taskManager: AsyncAgentTaskManager;
  messageParent?: (agentId: string, text: string, kind: import("./background_types.js").MessageKind | undefined, runId: string | undefined) => void;
}): Promise<{ agentId: string; description: string; outputFile: string }> {
  const { agentId, prompt, subagentsDir, agentDefs, taskManager } = opts;
  const saved=opts.durableStore?.agents().filter(a=>a.taskId===agentId).at(-1);
  if(opts.durableStore && !saved)throw new Error("缺少持久代理检查点，不能自动使用旧转录恢复。");
  const [transcript, meta] = saved ? [{messages:saved.messages},saved.metadata as {agentType:string;description?:string;worktreePath?:string;model?:string}] : await Promise.all([getAgentTranscript(subagentsDir, agentId), readAgentMetadata(subagentsDir, agentId)]);
  if(saved) {
    if(!meta?.model||!meta.agentType||!agentDefs.some(a=>a.agentType===meta.agentType))throw new Error("原代理定义或模型信息缺失，恢复已停止。");
    if(meta.worktreePath)await fs.access(meta.worktreePath);
    if(opts.durableStore!.unresolved().length)throw new Error("存在未决操作，须先明确核实决定。");
  }
  if (!transcript) throw new Error(`未找到子代理转录:${agentId}`);
  if (meta?.agentType && ONE_SHOT_AGENT_TYPES.has(meta.agentType)) {
    throw new Error(`${meta.agentType} 是一次性 agent,不支持恢复。`);
  }
  const resumedMessages = saved ? repairToolPairs(transcript.messages,opts.durableStore!,saved.runId) : filterIncompleteToolCalls(transcript.messages);
  const { GENERAL_PURPOSE_AGENT } = await import("./bundled_agents.js");
  const agentDef = meta?.agentType ? (agentDefs.find((a) => a.agentType === meta.agentType) ?? GENERAL_PURPOSE_AGENT) : GENERAL_PURPOSE_AGENT;
  const promptMessages: ChatMessage[] = [...resumedMessages, { role: "user", content: prompt }];
  const description = meta?.description ?? "(恢复)";
  // 有历史模型时保持原样；旧转录缺模型时才解析定义/当前主模型，展示与请求使用同一结果。
  const model = getAgentModel(agentDef.model, opts.parentModel, meta?.model);
  const bgTask = opts.registerAsyncAgent({ agentId, description });

  void runAsyncAgentLifecycle({
    taskId: bgTask.agentId, runId: bgTask.runId,
    abortSignal: bgTask.abortController.signal,
    agentId,
    agentType: meta?.agentType,
    isBuiltInAgent: agentDef.source === "built-in",
    prompt,
    model,
    makeStream: (onCacheSafeParams) => opts.runAgent({
      agentDef,
      model,
      promptMessages,
      isAsync: true,
      override: { abortController: bgTask.abortController, agentId },
      worktreePath: meta?.worktreePath,
      onCacheSafeParams,
      messageParent: (text, kind) => opts.messageParent?.(agentId, text, kind, bgTask.runId),
    }),
    taskManager,
  });

  return { agentId, description, outputFile: path.join(subagentsDir, `${agentId}.jsonl`) };
}
