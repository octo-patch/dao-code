/** 子代理使用独立预算，不受主会话 DAO_MAX_TURNS 设置影响。 */
export function subagentMaxTurns(override?: number, definition?: number): number {
  const positiveInteger = (n: number | undefined): n is number =>
    n !== undefined && Number.isSafeInteger(n) && n > 0;
  return [override, definition, Number(process.env.DAO_SUBAGENT_MAX_TURNS)]
    .find(positiveInteger) ?? 500;
}
