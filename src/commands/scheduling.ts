/** Queries and display-only commands must not cancel a background wait. */
const NON_INTERRUPTING_COMMANDS = new Set([
  "help", "cost", "tasks", "status", "context", "session", "diff", "files",
  "audit", "copy", "export", "theme",
]);

export function commandNeedsPause(input: string): boolean {
  const match = /^\/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return false;
  const [, name, args] = match;
  if (NON_INTERRUPTING_COMMANDS.has(name!)) return false;
  if ((name === "resume" || name === "recovery") && !args?.trim()) return false;
  return true;
}
