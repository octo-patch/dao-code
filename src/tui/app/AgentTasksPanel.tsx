import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { stripVTControlCharacters } from "node:util";
import type { BgTask } from "../../agent/tasks.js";
import { getLang } from "../../i18n/i18n.js";

const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f]/g, " ");

export function AgentTasksPanel({ listTasks }: { listTasks: () => BgTask[] }) {
  const [, refresh] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [offset, setOffset] = useState(0);
  const { stdout } = useStdout();
  const zh = getLang() === "zh";
  // 只读取本地内存，不调用模型工具、不消费游标、不唤醒调度器。
  useEffect(() => {
    const timer = setInterval(() => refresh((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const tasks = listTasks();
  const index = Math.max(0, tasks.findIndex((task) => task.id === selected));
  const task = tasks[index];
  const listSize = Math.min(5, tasks.length);
  const start = Math.max(0, Math.min(index - 2, tasks.length - listSize));
  const logSize = Math.max(1, Math.min(12, (stdout.rows || 24) - listSize - 13));
  const messages = task?.messages ?? [];
  const entries: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      if (message.content) entries.push(message.content);
      for (const call of message.tool_calls ?? []) entries.push(`${call.function.name} ${call.function.arguments}`);
    } else if (message.role === "tool") {
      const text = typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join(" ");
      entries.push(`↳ ${text}`);
    }
  }
  // 按条目翻页，避免同一消息中的并行工具调用超过一页时丢失历史。
  const end = Math.max(0, entries.length - Math.min(offset, Math.max(0, entries.length - logSize)));
  const lines = entries.slice(Math.max(0, end - logSize), end).map(clean);
  useInput((_ch, key) => {
    if (key.upArrow || key.downArrow) {
      const next = Math.max(0, Math.min(tasks.length - 1, index + (key.upArrow ? -1 : 1)));
      setSelected(tasks[next]?.id); setOffset(0);
    }
    if (key.pageUp) setOffset(Math.min(Math.max(0, entries.length - logSize), offset + logSize));
    if (key.pageDown) setOffset(Math.max(0, offset - logSize));
  });
  const tools = messages.reduce((count, message) => count + (message.role === "assistant" ? message.tool_calls?.length ?? 0 : 0), 0);
  const elapsed = task ? Math.max(0, Math.floor(((task.endedAt ?? Date.now()) - task.startedAt) / 1000)) : 0;
  return <Box flexDirection="column" borderStyle="round" paddingX={1}>
    <Text bold>{zh ? "子 agent 执行情况" : "Subagent activity"} ({tasks.length})</Text>
    <Text dimColor>{zh ? "↑↓ 选择 · PgUp/PgDn 历史 · Ctrl+T / Esc 关闭" : "↑↓ select · PgUp/PgDn history · Ctrl+T / Esc close"}</Text>
    {tasks.slice(start, start + listSize).map((item, n) => <Text key={item.id} wrap="truncate">
      {start + n === index ? "❯ " : "  "}{item.id} · {item.status} · {clean(item.description)}
    </Text>)}
    {!task ? <Text>{zh ? "暂无子 agent 任务" : "No subagent tasks"}</Text> : <>
      <Text>{elapsed}s · {tools} {zh ? "次工具调用" : "tool calls"} · {offset ? (zh ? "历史消息" : "history") : (zh ? "实时更新" : "live")}</Text>
      {lines.length ? lines.slice(-logSize).map((line, n) => <Text key={n} wrap="truncate">{line}</Text>) : <Text dimColor>{zh ? "暂无中间输出" : "No intermediate output yet"}</Text>}
      {task.summary && <Text wrap="truncate">{clean(task.summary)}</Text>}
      {(task.error || task.result) && <Text wrap="truncate">{clean(task.error || task.result || "")}</Text>}
    </>}
  </Box>;
}
