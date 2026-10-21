export type ExecutionStatus = "running" | "canceling" | "completed" | "failed" | "canceled" | "interrupted" | "unknown";
export type MessageKind = "progress" | "attention";
export interface ExecutionSnapshot {
  taskId: string;
  runId: string;
  kind: "agent" | "shell";
  background: boolean;
  description: string;
  status: ExecutionStatus;
  result?: string;
  recovery?: "runner" | "in-process" | "legacy-adopted";
  runnerDir?: string;
  progress?: string;
}
export interface ExecutionEvent {
  type: "started" | "progress" | "completed" | "failed" | "canceled" | "message" | "interrupted" | "unknown";
  snapshot: ExecutionSnapshot;
  message?: string;
  requiresAttention?: boolean;
  eventId?: string;
}
export interface BackgroundEvent extends ExecutionEvent {
  sessionId: string;
  eventId: string;
  seq: number;
}
export interface WaitRequest { ids: string[]; mode: "any" | "all" }
export interface WaitHandle {
  waitId: string;
  sessionId: string;
  targets: { taskId: string; runId: string }[];
  mode: "any" | "all";
  observedSeq: number;
}
export type TurnOutcome =
  | { kind: "completed" }
  | { kind: "waiting"; wait: WaitHandle }
  | { kind: "interrupted"; reason: "user" | "shutdown" }
  | { kind: "failed"; error: Error };
export type SessionState = "idle" | "running" | "waiting" | "paused" | "closed" | "recovering";
export const isTerminal = (status: ExecutionStatus) => ["completed", "failed", "canceled", "interrupted"].includes(status);
export interface ExecutionSource {
  subscribe(listener: (event: ExecutionEvent) => void): () => void;
}
