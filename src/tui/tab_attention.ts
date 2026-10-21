export interface TabAttention {
  mark(): void;
  clear(): void;
  dispose(): void;
}

// 只改标题,不发响铃或桌面通知。OSC 的结束符也用 ST,避免混入 BEL。
// 标题栈用于退出后恢复原名;不支持标题栈的终端至少会清掉圆点。
export function createTabAttention(
  title: string,
  stdout: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): TabAttention {
  const enabled = stdout.isTTY === true && env.TERM !== "dumb";
  // 工作目录可以含控制字符,不能让目录名注入额外的终端指令。
  const base = title.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim() || "dao";
  let marked = false;
  let disposed = false;
  const write = (value: string) => { if (enabled) stdout.write(value); };
  const setTitle = (value: string) => write(`\x1b]0;${value}\x1b\\`);

  write("\x1b[22;0t");
  setTitle(base);
  write("\x1b[?1004h"); // 支持的终端会发送 ESC[I / ESC[O 焦点事件。
  return {
    mark() {
      if (disposed || marked) return;
      marked = true;
      setTitle(`● ${base}`);
    },
    clear() {
      if (disposed || !marked) return;
      marked = false;
      setTitle(base);
    },
    dispose() {
      if (disposed) return;
      if (marked) setTitle(base);
      write("\x1b[?1004l\x1b[23;0t");
      disposed = true;
    },
  };
}
