# 子智能体配置(Subagents)

> 最后核对:2026-07-07,commit `33df233`

## 一句话定位

子智能体用 `AgentDef`(名字+专属 prompt+工具白名单+可选模型)定义,内置 4 种类型 + 支持磁盘自定义;每次派发默认是全新隔离 Session、一次性跑到底,同时支持后台并行 + 异步消息回灌主循环。

## 定义方式(`src/agent/agent_defs.ts:8-15`)

```ts
interface AgentDef {
  name, description,
  tools?,          // 工具白名单
  toolsExclude?,   // "*, !x" 语法排除名
  model?,
  prompt,          // 专属 system prompt 正文
}
```

支持从 markdown(frontmatter + 正文)解析:`name`/`description`/`tools`(或 `allowed-tools`)/`model` 写在 frontmatter,正文即 `prompt`(`parseAgentDef`,28-46 行)。`tools` 省略 = 继承全部工具。

## 内置清单(`bundled_agents.ts:5-70`)

| 名字 | 用途 | 工具/模型限制 |
|---|---|---|
| `explore` | 只读彻底探查 | 限定 read/grep/list/search/fetch 等只读工具;默认继承当前主模型;`DAO_EXPLORE_MODEL` 可显式指定网关支持的完整模型 ID |
| `verify` | 对抗性验证 | 允许 `exec_shell*`;严格要求"判定:通过/不通过/部分"格式 |
| `general-purpose` | 通用兜底 | 不设 model(跟随主会话)、不设 tools(继承全部);`agent_type` 省略时的默认值(`tools/agent.ts:848`) |
| `plan` | 架构规划 | `toolsExclude` 排除写/执行类工具,不设 model |

## 自定义子代理

`loadAgentDefs(projectDir, userDir, pluginDirs)`(`agent_defs.ts:66-74`)从项目 `.dao/agents/*.md`、用户 `~/.dao/agents/*.md`、插件目录加载,同名时项目 > 用户 > 插件,且磁盘定义可覆盖同名内置(`bundled_agents.ts:3`)。

## 运行模型(`subagent.ts`)

`runSubagent`(33-68 行)每次是**全新隔离 Session**(独立 `new Session(systemPrompt, model)`),默认不带主对话历史,只塞一条 user 任务;唯一例外是 `forkMessages`(fork 模式,复用父会话已缓存前缀)。子代理有独立 `readFiles`/`readMeta`,不污染主代理"已读"护栏。

**防递归**:`subagentDepth = ctx.subagentDepth+1`(44 行),`tools/agent.ts:64` 硬限制 `subagentDepth>=2` 时拒绝再派发(最多两层嵌套);且 `depth>=1` 时并行度从 10 收紧到 3(`agent.ts:126-127`),防指数爆炸。

子代理跑在 `background:true` 模式(不重试 529)、默认 500 轮模型调用上限(调用级 `maxTurns` > agent 定义 `maxTurns` > `DAO_SUBAGENT_MAX_TURNS` > 500,与主会话 `DAO_MAX_TURNS` 独立),完成后转录写入 `.dao/subagents/*.jsonl`(`index.ts:873-880`)。

## `src/tools/agent.ts`(派发入口)

`agent` 工具入参:

- `task`/`tasks[]` —— 单个或最多 20 个并行任务
- `background` —— 是否显式转后台
- `agent_type` —— 选用哪个 `AgentDef`
- `isolate` —— git worktree 隔离改文件(见 [middleware.md](middleware.md) 的 `worktree.ts`)
- `fork` —— 继承父完整上下文、复用缓存前缀
- `model`/`mode` —— 调用级覆盖,与 `fork` 互斥

默认前台派发并返回最终文本;Ctrl+B 可将前台执行转后台。显式 `background:true` 立即返回 task id,结果由会话调度器异步投递。并行任务仍使用已有 worker 池限流。

## 父子通信:`task_send.ts` / `message_parent.ts` / `tasks.ts`

`tasks.ts` 的 `TaskManager` 管理任务及执行状态,通过可解除的 `subscribe` 发布结构化事件;`BackgroundRuntime` 聚合这些事件和 Shell 事件。每次执行或 resume 都有独立 runId。旧 `drainNotifications` 仅用于兼容未接入调度器的调用方,生产入口不消费它。

- `task_send`(**父→子**):父代理调用 `task_send(id, message)` 追加指令,子代理在下一个工具回合边界通过 `drainPending` 消费(`subagent.ts:56`)。
- `MessageParent`(**子→父**):`kind=progress` 更新进度,不唤醒主模型;`kind=attention`(默认)表示需要处理的问题,在安全边界投递。
- 子代理结果经 `BackgroundDelivery` 作为带 eventId/taskId/runId 的数据消息追加,不经过 `UserPromptSubmit`。消息保存成功后才从收件箱确认消费;保存失败暂停会话,重试不会重复追加同批消息。

## 权限/审批模型

子代理与主代理**共用同一个 `ApprovalGate`/`PermissionGate` 实例**(`index.ts:866`),不是独立沙箱;`mode` 默认继承主会话 `session.mode`(`index.ts:853: subMode = mode ?? session.mode`),可按调用覆盖为 `plan`。已批准的操作(alwaysApproved 存储)、plan 只读限制对子代理同样生效,工具集只是通过 `tools`/`toolsExclude` 白名单在注册表层面裁剪,并非另一套审批策略。

## 后台并行 + 异步回灌

`SessionScheduler` 是 TTY、REPL 和一次性 CLI 启动主回合、消费后台结果的唯一入口。同一会话至多有一个主回合;执行期间到达的结果只在工具调用/结果配对完整后的安全边界注入。

主会话做完独立工作后,单独调用 `TaskWait({ids:["agent-a","proc-1"],mode:"all"})`。`any` 等任一完成,`all` 等全部成功;任一失败、取消确认或 attention 可提前解除等待。非目标任务的普通成功结果在显式等待期间暂存。手动 TaskCreate 待办和前台任务不能等待;子代理不暴露 TaskWait。

工具立即返回 ready 或 waiting,不会占用一个等待后台结束的工具 Promise。`runTurn` 先保存配对结果,再返回 `TurnOutcome.waiting`;调度器重新检查完成条件,避免保存期间发生完成导致漏唤醒。等待期间没有模型请求或结果查询定时器。未显式等待的一次性/非 TTY 入口在尚有后台执行时建立兼容性等待,维持进程存活。

- 用户输入解除原等待,优先处理新意图;后台工作继续。
- Esc 暂停自动续跑,保留未消费的结果;新输入恢复。暂停不等于取消后台任务。
- TaskStop/KillShell 发出取消请求;真实执行先进入 canceling,执行器退出后才确认 canceled。无法取消的 adopt Promise 不伪报停止。
- TaskUpdate 只允许手动待办改变终态;真实执行由生命周期结算。
- V2 会话通过 `dao -c [id]`、TTY/REPL `/resume <id>` 恢复原 sessionId。SQLite WAL/FULL 保存任务、事件、等待和工具检查点；消息追加与事件确认同事务提交。已有活 owner 时拒绝并发恢复。
- 显式后台 Bash 由独立 runner 执行。DAO 被 SIGKILL 后命令继续，重启可认证接回；离线完成依靠持久终态收据导入，不重跑命令。普通退出/SIGTERM 请求取消；`/quit --keep-background` 保留 runner。Ctrl+B 接管的旧式进程标记 `legacy-adopted`，不承诺跨进程恢复。
- 有效 waiting 自动恢复；paused、运行中的中断回合、unknown 和未决工具保持暂停。暂停不是终态，不产生自动模型请求。连接断开只做有限次数本地 I/O 重连，耗尽后需核实。
- 子代理仍在 DAO 进程内执行。崩溃后显示 interrupted，检查点按 run 保存；`/recovery continue <taskId> <指令>` 显式创建新 run。旧运行的工具不自动重放。
- `/recovery` 展示未决操作和任务。先只读核实，再由用户 `/recovery resolve <scope> <toolCallId> <具体核实决定>` 处理工具结果；未知 Shell 用 `/recovery decide <taskId> <completed|failed|canceled> <证据>`。普通“继续”不解除副作用阻塞。
- JSON 旧存档只迁移历史，不能接回旧任务；V2 JSON 导出标记为历史快照，SQLite 损坏、版本不兼容不静默回退。新恢复机制支持本地 macOS/Linux，Windows 和网络文件系统不支持。

主要实现位于 `src/agent/background_runtime.ts`、`background_delivery.ts`、`session_scheduler.ts` 和 `src/tools/task_wait.ts`。`--obs` 可记录等待登记/激活/解除、唤醒原因、投递和去重事件,不附带任务正文;Runtime diagnostics 提供请求数、等待期请求数、累计等待时长、队列及订阅数。

确定性验收命令:

```sh
npx vitest run src/agent/background_runtime.test.ts src/agent/session_scheduler.test.ts src/agent/background_wait.integration.test.ts
node scripts/verify-background-wait.mjs
node scripts/verify-background-wait.mjs --repl
```

CLI 脚本使用脚本化模型响应及真实 Shell/FIFO,验证等待期零请求与一次唤醒,不访问模型服务。真实模型是否遵循 TaskWait 指引需另行回放验收。


第二期验收入口（真实进程测试需要本机子进程、文件通知与本地 socket 权限）：

```sh
npx vitest run src/session/durable_store.test.ts src/tools/managed_shell.test.ts
node --import tsx scripts/verify-background-recovery.ts
bun build src/index.ts --compile --outfile /tmp/dao-recovery
DAO_RECOVERY_TEST_BINARY=/tmp/dao-recovery node --import tsx scripts/verify-background-recovery.ts
node --import tsx scripts/verify-background-recovery-live.mjs running
# 其他真实 GLM 场景：offline、all、paused、agent、unknown
```

真实模型验收脚本使用当前 GLM-5.3-joybuilder 配置，创建隔离临时工作区；记录请求计数、稳定 runId、启动次数和恢复状态，不记录 API 密钥。`running/offline/all` 应正常处理结果，`paused/agent/unknown` 恢复后保持暂停且主模型请求为零。

交互模式按 `Ctrl+T` 查看已登记子代理的本地实时记录,`↑/↓` 选任务、`PgUp/PgDn` 翻历史、`Esc` 关闭且不中断任务;面板不消费通知或 TaskOutput 游标。

## 模型选择与网关

- 内置 general-purpose / explore / plan / verify 和 fork 默认继承当前主模型；explore 的 `DAO_EXPLORE_MODEL` 属于显式配置。
- 自定义与插件定义的 `model` 保留完整 ID。优先级为调用级 `model` > agent 定义 > 当前主模型；调用级 `inherit` 可覆盖定义。缺少可继承模型时明确报配置错误，不猜测 DeepSeek。
- 前台、后台和 worktree 使用同一模型解析。后台支持调用级 `model` / `mode`；fork 仍禁止调用级换模型。remote 当前复用 worktree 路径，没有独立的模型配置链路。
- 恢复持久任务时保留已保存的模型 ID。旧转录缺少模型时，按 agent 定义与当前主模型解析；显示和执行使用同一结果。
- WebFetch 提取、分类器、技能转换与非 fork 反思只在已知官方端点且主模型属于对应模型族时选择便宜档；自定义端点默认沿用主模型。压缩摘要和网页提取每次调用读取当前模型，避免切换账号后沿用旧值。
- 技能转换不再将外来模型档固定映射到 DeepSeek，旧适配缓存通过新的缓存键失效。
