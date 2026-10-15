export type ExecutionStatus = "running" | "canceling" | "completed" | "failed" | "canceled";
export type MessageKind = "progress" | "attention";
export interface ExecutionSnapshot {
  taskId: string;
  runId: string;
  kind: "agent" | "shell";
  background: boolean;
  description: string;
  status: ExecutionStatus;
  result?: string;
  progress?: string;
}
export interface ExecutionEvent {
  type: "started" | "progress" | "completed" | "failed" | "canceled" | "message";
  snapshot: ExecutionSnapshot;
  message?: string;
  requiresAttention?: boolean;
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
export type SessionState = "idle" | "running" | "waiting" | "paused" | "closed";
export const isTerminal = (status: ExecutionStatus) => status !== "running" && status !== "canceling";
export interface ExecutionSource {
  subscribe(listener: (event: ExecutionEvent) => void): () => void;
}
