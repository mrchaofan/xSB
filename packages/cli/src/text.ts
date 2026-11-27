/**
 * Everything the `xsb` command says, once per language.
 *
 * The language is the terminal's (LC_ALL, LC_MESSAGES, LANG), as for any
 * command. What the hub refuses is worded from its reason in the same
 * language (`explain` in @xsb/protocol); what agents say is theirs.
 */
import { languageOf } from "@xsb/protocol";
import type { AgentState, Language, TaskStatus } from "@xsb/protocol";

/** How a task's state is shown: its status, except that one replaced by a new task of its dispatcher says so. */
export type Shown = TaskStatus | "superseded";

export const language: Language = languageOf([process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]);

const en = {
  help: `xsb: conversations and workflows

  xsb init [--project DIR]
  xsb session new [TITLE] [--backend NAME]
  xsb sessions
  xsb chat [SESSION] [--backend NAME] [--history]
  xsb send SESSION MESSAGE [--history-only | --workflow-target]
  xsb workflow show|pause|resume SESSION [NODE ...]
  xsb backends | status | watch
  xsb hub start|stop|log|status
  xsb acp

Use a task session ID from workflow show to talk to that task. /cancel stops the current conversation's work.
`,
  noProject: (cwd: string) => `no .xsb2 found from ${cwd} upwards; run "xsb init"`,
  usage: (line: string) => `usage: ${line}`,
  noValue: (flag: string) => `${flag} needs a value`,
  created: (file: string) => `created ${file}`,
  initialized: (dir: string) => `initialized ${dir}\nnext: xsb chat`,
  installed: (yes: boolean): string => (yes ? "installed    " : "not installed"),
  backendsDefined: (file: string) => `defined in ${file} (built-ins unless replaced there)`,
  noAgents: "No conversations. Start one with xsb chat.",
  state: { idle: "idle", running: "running", requires_action: "requires_action" } satisfies Record<AgentState, string>,
  asks: (who: string, what: string) => `[${who}] asks permission: ${what}`,
  useTool: "use a tool",
  choose: "choose> ",
  talking: (agent: string) => `talking to ${agent}. What you write while it works goes into the running turn. /cancel stops it, /quit leaves.`,
  interjecting: "(into the running turn)",
  taskCancelled: (id: string, also: string[]) => `task ${id} cancelled${also.length ? `, and with it: ${also.join(", ")}` : ""}`,
  stopped: (reason: string) => `(${reason})`,
  failed: (why: string) => `(error: ${why})`,
  agentRemoved: (id: string) => `[${id}] removed`,
  taskLine: (id: string, from: string, to: string, title: string, status: Shown) => `[task ${id}] ${from} -> ${to} "${title}": ${status}`,
  taskStatus: { blocked: "blocked", queued: "queued", running: "running", completed: "completed", failed: "failed", cancelled: "cancelled", interrupted: "interrupted", superseded: "replaced" } satisfies Record<Shown, string>,
  watching: (count: number) => `watching ${count} agents; ctrl-c to stop`,
  project: (dir: string, pid: number | undefined) => `project ${dir}, hub pid ${pid}`,
  openTasks: "open tasks:",
  hubRunning: (pid: number | undefined, since?: string) => `hub running, pid ${pid}${since ? `, since ${since}` : ""}`,
  hubNotRunning: "hub is not running",
  hubStopped: "hub stopped",
  hubStuck: (pid: number) => `the hub (pid ${pid}) did not stop within 5s`,
  thinking: "thinking: ",
  toolFailed: (title: string) => `${title} failed`,
  user: "user",
  interjected: " (interjected)",
  discarded: " (discarded: stopped before the model saw it)",
};

const zh: typeof en = {
  help: `xsb 会话与工作流

  xsb init [--project DIR]
  xsb session new [TITLE] [--backend NAME]
  xsb sessions
  xsb chat [SESSION] [--backend NAME] [--history]
  xsb send SESSION MESSAGE [--history-only | --workflow-target]
  xsb workflow show|pause|resume SESSION [NODE ...]
  xsb backends | status | watch
  xsb hub start|stop|log|status
  xsb acp

使用 workflow show 中的任务会话 ID 可直接向该任务提问。对话中输入 /cancel 停止当前工作。
`,
  noProject: (cwd) => `从 ${cwd} 向上没有找到 .xsb2；请先执行 "xsb init"`,
  usage: (line) => `用法：${line}`,
  noValue: (flag) => `${flag} 后面要跟一个值`,
  created: (file) => `已创建 ${file}`,
  initialized: (dir) => `已初始化 ${dir}\n下一步：xsb chat`,
  installed: (yes) => (yes ? "已安装" : "未安装"),
  backendsDefined: (file) => `在 ${file} 中定义（未在其中替换的为内置后端）`,
  noAgents: "还没有会话。运行 xsb chat 开始对话。",
  state: { idle: "空闲", running: "工作中", requires_action: "等待批准" },
  asks: (who, what) => `[${who}] 请求许可：${what}`,
  useTool: "使用一个工具",
  choose: "请选择> ",
  talking: (agent) => `正在与 ${agent} 对话。它工作时你说的话会插进正在进行的这一轮。/cancel 停止它，/quit 退出。`,
  interjecting: "（已插进正在进行的这一轮）",
  taskCancelled: (id, also) => `任务 ${id} 已取消${also.length ? `，一并取消：${also.join("、")}` : ""}`,
  stopped: (reason) => `（已停止：${reason === "cancelled" ? "已取消" : reason}）`,
  failed: (why) => `（出错：${why}）`,
  agentRemoved: (id) => `[${id}] 已删除`,
  taskLine: (id, from, to, title, status) => `[任务 ${id}] ${from} -> ${to}“${title}”：${zh.taskStatus[status]}`,
  taskStatus: { blocked: "等待前置任务", queued: "排队中", running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", superseded: "已改派" },
  watching: (count) => `正在跟随 ${count} 个智能体；按 ctrl-c 停止`,
  project: (dir, pid) => `项目 ${dir}，中枢进程号 ${pid}`,
  openTasks: "未完成的任务：",
  hubRunning: (pid, since) => `中枢正在运行，进程号 ${pid}${since ? `，启动于 ${since}` : ""}`,
  hubNotRunning: "中枢没有在运行",
  hubStopped: "中枢已停止",
  hubStuck: (pid) => `中枢（进程号 ${pid}）在 5 秒内没有停止`,
  thinking: "思考：",
  toolFailed: (title) => `${title} 失败`,
  user: "用户",
  interjected: "（插话）",
  discarded: "（已丢弃：停止时模型还没看到）",
};

export const t: typeof en = { en, "zh-CN": zh }[language];
