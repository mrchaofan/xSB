/**
 * Everything the `xsb` command says, once per language.
 *
 * The language is the terminal's (LC_ALL, LC_MESSAGES, LANG), as for any
 * command. What the hub refuses is worded from its reason in the same
 * language (`explain` in @xsb/protocol); what agents say is theirs.
 */
import { languageOf } from "@xsb/protocol";
import type { AgentState, Language, SteeringOutcome, TaskStatus } from "@xsb/protocol";

export const language: Language = languageOf([process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG]);

const en = {
  help: `xsb: a team of agents that talk to you and to each other

  xsb init                              create .xsb/ in this directory
  xsb agent add <id> [options]          add or change an agent
        --role <name>                   the role it is an instance of: .xsb/roles/<name>/
        --backend <name>                a name from 'xsb backends' (default: the role's, or claude)
        --name <text> --desc <text>     how the others see it
        --instructions <text|@file>     what it is and how it works
        --workspace <dir>               its working directory (default: the project's if the role says so, else .xsb/agents/<id>/workspace)
  xsb agent list | remove <id>
  xsb agent show <id>                   everything a new session of it is told (its system prompt)
  xsb agent restart <id>                restart its backend, so that changes apply now
  xsb role add <name> [--desc <text>] [--backend <name>] [--workspace project|own] [--instructions <text|@file>]
                                        create or change a role; its tools and skills are the
                                        files in .xsb/roles/<name>/
  xsb role list | show <name> | remove <name>
  xsb role check <name>                 start the role's MCP servers and list their tools
  xsb team list                         the preset teams (xsb's own and yours in ~/.xsb/presets), and which the project uses
  xsb team use <id> | drop <id>         use a team's roles in this project as they ship, or stop;
                                        nothing is copied, and 'xsb role add' makes a role the project's own
  xsb team check [<id>]                 what is wrong with the preset teams, as far as can be checked without running them
  xsb team new <id> --extends <base>    start a team of yours in ~/.xsb/presets that builds on <base>
  xsb team eval <id> [--backend <name>] [--runs <n>] [--only S1,S2] [--language en|zh-CN] [--timeout <s>]
                                        run the team's scenarios (evals/) on a real backend: costs model use
  xsb backends                          the backends of this machine, and whether each is installed

  xsb chat <agent> [--new] [--history]  talk to an agent
  xsb send <agent> <message> [--interject] [--new]
                                        one message, print the reply
  xsb watch                             follow every agent
  xsb status | tasks | sessions
  xsb assets [--type <type>]            the shared asset library

  xsb acp [--agent <id>]                serve ACP on stdio, for editors and other clients
  xsb hub start | stop | status | log   the background process (started on demand)

  --project <dir>                       use the .xsb in <dir> instead of searching upwards
`,
  noProject: (cwd: string) => `no .xsb found from ${cwd} upwards; run "xsb init"`,
  usage: (line: string) => `usage: ${line}`,
  noValue: (flag: string) => `${flag} needs a value`,
  created: (file: string) => `created ${file}`,
  initialized: (dir: string) => `initialized ${dir}\nnext: xsb agent add <id> --backend claude --desc "..." --instructions "..."`,
  installed: (yes: boolean): string => (yes ? "installed    " : "not installed"),
  backendsDefined: (file: string) => `defined in ${file} (built-ins unless replaced there)`,
  agentSaved: (id: string, role: string | undefined, backend: string, workspace: string) =>
    `agent ${id}: ${role ? `role ${role}, ` : ""}backend ${backend}, workspace ${workspace}`,
  instructionsAt: (file: string) => `instructions: ${file}`,
  removed: (name: string) => `removed ${name}`,
  restarted: (id: string) => `restarted ${id}`,
  noAgents: "no agents; add one with `xsb agent add`",
  state: { idle: "idle", running: "running", requires_action: "requires_action" } satisfies Record<AgentState, string>,
  roleSaved: (name: string, dir: string) => `role ${name}: ${dir}`,
  roleTeam: (team: string, own: boolean) => `team: ${team}${own ? " (replaced by the project's own)" : ""}`,
  roleFacts: (backend: string | undefined, workspace: string, agents: string[]) =>
    `backend: ${backend ?? "(default)"}\nworkspace: ${workspace}\nagents: ${agents.join(", ") || "none"}`,
  roleServer: (server: string, command: string) => `mcp ${server}: ${command}`,
  roleSkill: (name: string, produces: string | undefined, inputs: string[], description: string) =>
    `skill ${name}${produces ? ` (produces ${produces}${inputs.length ? ` from ${inputs.join(", ")}` : ""})` : ""}: ${description}`,
  serverOk: (server: string, tools: string[]) => `${server}: ok, tools: ${tools.join(", ") || "none"}`,
  serverFailed: (server: string, error: string) => `${server}: FAILED: ${error}`,
  noRoles: "no roles; add one with `xsb role add`",
  roleHas: (servers: number, skills: number, agents: string[]) => `${servers} mcp, ${skills} skills, agents: ${agents.join(", ") || "none"}`,
  teamUsed: (id: string) => `using team ${id}; its roles are in 'xsb role list'`,
  teamDropped: (id: string) => `dropped team ${id}`,
  used: (yes: boolean): string => (yes ? "used" : "    "),
  teamSource: (source: string): string => (source === "user" ? "yours" : "xsb"),
  teamExtends: (base: string): string => `extends ${base}`,
  problem: (severity: string): string => (severity === "error" ? "error" : "note"),
  noProblems: "no problems found",
  teamMade: (dir: string): string => `made ${dir}; put in it only the roles and skills that differ`,
  evalUsage: "usage: xsb team eval <team> [--backend <name>] [--runs <n>] [--only S1,S2]",
  noScenarios: (id: string): string => `the team ${id} has no scenarios (evals/*.json)`,
  evalStart: (n: number, runs: number, backend: string): string => `${n} scenarios, ${runs} runs each, on ${backend}. This uses the backend's model, which is billed; generation is stood in for and costs nothing.`,
  evalTotal: (passed: number, total: number): string => `passed ${passed} of ${total} runs`,
  asks: (who: string, what: string) => `[${who}] asks permission: ${what}`,
  useTool: "use a tool",
  choose: "choose> ",
  talking: (agent: string) => `talking to ${agent}. /i <text> interjects into the running turn, /cancel stops it, /quit leaves.`,
  steered: { injected: "(injected)", startedNewTurn: "(startedNewTurn)", promptRequired: "(promptRequired)" } satisfies Record<SteeringOutcome["outcome"], string>,
  steerFailed: (why: string) => `(steer failed: ${why})`,
  queued: "(queued behind the running turn)",
  stopped: (reason: string) => `(${reason})`,
  failed: (why: string) => `(error: ${why})`,
  agentRemoved: (id: string) => `[${id}] removed`,
  taskLine: (id: string, from: string, to: string, title: string, status: TaskStatus) => `[task ${id}] ${from} -> ${to} "${title}": ${status}`,
  taskStatus: { blocked: "blocked", queued: "queued", running: "running", completed: "completed", failed: "failed", cancelled: "cancelled", interrupted: "interrupted" } satisfies Record<TaskStatus, string>,
  watching: (count: number) => `watching ${count} agents; ctrl-c to stop`,
  project: (dir: string, pid: number | undefined) => `project ${dir}, hub pid ${pid}`,
  openTasks: "open tasks:",
  hubRunning: (pid: number | undefined, since?: string) => `hub running, pid ${pid}${since ? `, since ${since}` : ""}`,
  hubNotRunning: "hub is not running",
  hubStopped: "hub stopped",
  hubStuck: (pid: number) => `the hub (pid ${pid}) did not stop within 5s`,
  thinking: "thinking: ",
  tool: "tool",
  toolFailed: (title: string) => `${title} failed`,
  user: "user",
  interjected: " (interjected)",
};

const zh: typeof en = {
  help: `xsb：一支能和你对话、也能互相对话的智能体团队

  xsb init                              在当前目录创建 .xsb/
  xsb agent add <标识> [选项]           添加或修改一个智能体
        --role <名称>                   它所属的角色：.xsb/roles/<名称>/
        --backend <名称>                'xsb backends' 列出的名称（默认：角色指定的，否则 claude）
        --name <文字> --desc <文字>     其他智能体看到的名字和描述
        --instructions <文字|@文件>     它是谁、怎么工作
        --workspace <目录>              它的工作目录（默认：角色指定时用项目目录，否则 .xsb/agents/<标识>/workspace）
  xsb agent list | remove <标识>
  xsb agent show <标识>                 它的新会话会被告知的全部内容（系统说明）
  xsb agent restart <标识>              重启它的后端，让改动立即生效
  xsb role add <名称> [--desc <文字>] [--backend <名称>] [--workspace project|own] [--instructions <文字|@文件>]
                                        创建或修改角色；它的工具和技能是
                                        .xsb/roles/<名称>/ 下的文件
  xsb role list | show <名称> | remove <名称>
  xsb role check <名称>                 启动角色的工具服务并列出各自的工具
  xsb team list                         预设团队（xsb 自带的，和你放在 ~/.xsb/presets 里的），以及项目用了哪些
  xsb team use <标识> | drop <标识>     在项目里原样使用一支团队的角色，或停止使用；
                                        不复制任何文件，'xsb role add' 会把角色变成项目自己的
  xsb team check [<标识>]               不运行就能查出的预设团队的问题
  xsb team new <标识> --extends <基础>  在 ~/.xsb/presets 里新建一支基于 <基础> 的团队
  xsb team eval <标识> [--backend <名称>] [--runs <次数>] [--only S1,S2] [--language en|zh-CN] [--timeout <秒>]
                                        用真实后端跑团队的场景评估（evals/），会产生模型费用
  xsb backends                          这台机器上的后端，以及各自是否已安装

  xsb chat <智能体> [--new] [--history] 与一个智能体对话
  xsb send <智能体> <消息> [--interject] [--new]
                                        发一条消息并打印回复
  xsb watch                             跟随所有智能体
  xsb status | tasks | sessions         状态 | 任务 | 会话
  xsb assets [--type <类型>]            共享的资产库

  xsb acp [--agent <标识>]              在标准输入输出上提供 ACP，供编辑器等客户端使用
  xsb hub start | stop | status | log   后台进程（按需启动）

  --project <目录>                      使用 <目录> 里的 .xsb，而不是向上查找
`,
  noProject: (cwd) => `从 ${cwd} 向上没有找到 .xsb；请先执行 "xsb init"`,
  usage: (line) => `用法：${line}`,
  noValue: (flag) => `${flag} 后面要跟一个值`,
  created: (file) => `已创建 ${file}`,
  initialized: (dir) => `已初始化 ${dir}\n下一步：xsb agent add <标识> --backend claude --desc "..." --instructions "..."`,
  installed: (yes) => (yes ? "已安装" : "未安装"),
  backendsDefined: (file) => `在 ${file} 中定义（未在其中替换的为内置后端）`,
  agentSaved: (id, role, backend, workspace) => `智能体 ${id}：${role ? `角色 ${role}，` : ""}后端 ${backend}，工作目录 ${workspace}`,
  instructionsAt: (file) => `说明文件：${file}`,
  removed: (name) => `已删除 ${name}`,
  restarted: (id) => `已重启 ${id}`,
  noAgents: "还没有智能体；用 `xsb agent add` 添加一个",
  state: { idle: "空闲", running: "工作中", requires_action: "等待批准" },
  roleSaved: (name, dir) => `角色 ${name}：${dir}`,
  roleTeam: (team, own) => `团队：${team}${own ? "（已被项目自己的角色取代）" : ""}`,
  roleFacts: (backend, workspace, agents) => `后端：${backend ?? "（默认）"}\n工作目录：${workspace === "project" ? "项目目录" : "各自的目录"}\n智能体：${agents.join("、") || "无"}`,
  roleServer: (server, command) => `工具服务 ${server}：${command}`,
  roleSkill: (name, produces, inputs, description) =>
    `技能 ${name}${produces ? `（产出 ${produces}${inputs.length ? `，依据 ${inputs.join("、")}` : ""}）` : ""}：${description}`,
  serverOk: (server, tools) => `${server}：正常，工具：${tools.join("、") || "无"}`,
  serverFailed: (server, error) => `${server}：失败：${error}`,
  noRoles: "还没有角色；用 `xsb role add` 添加一个",
  roleHas: (servers, skills, agents) => `${servers} 个工具服务，${skills} 个技能，智能体：${agents.join("、") || "无"}`,
  teamUsed: (id) => `已使用团队 ${id}；它的角色见 'xsb role list'`,
  teamDropped: (id) => `已停用团队 ${id}`,
  used: (yes) => (yes ? "在用" : "　　"),
  teamSource: (source) => (source === "user" ? "我的" : "自带"),
  teamExtends: (base) => `基于 ${base}`,
  problem: (severity) => (severity === "error" ? "错误" : "提醒"),
  noProblems: "没有发现问题",
  teamMade: (dir) => `已新建 ${dir}；只把不同的角色和技能放进去`,
  evalUsage: "用法：xsb team eval <团队> [--backend <名称>] [--runs <次数>] [--only S1,S2]",
  noScenarios: (id) => `团队 ${id} 没有场景（evals/*.json）`,
  evalStart: (n, runs, backend) => `${n} 个场景，每个跑 ${runs} 次，后端 ${backend}。会用到后端的模型并计费；生成工具是替身，不花钱。`,
  evalTotal: (passed, total) => `共 ${total} 次，通过 ${passed} 次`,
  asks: (who, what) => `[${who}] 请求许可：${what}`,
  useTool: "使用一个工具",
  choose: "请选择> ",
  talking: (agent) => `正在与 ${agent} 对话。/i <内容> 插话到正在进行的这一轮，/cancel 停止它，/quit 退出。`,
  steered: { injected: "（已插入正在进行的这一轮）", startedNewTurn: "（智能体空闲，已另起一轮）", promptRequired: "（智能体空闲，没有可插入的一轮）" },
  steerFailed: (why) => `（插话失败：${why}）`,
  queued: "（已排在正在进行的这一轮之后）",
  stopped: (reason) => `（已停止：${reason === "cancelled" ? "已取消" : reason}）`,
  failed: (why) => `（出错：${why}）`,
  agentRemoved: (id) => `[${id}] 已删除`,
  taskLine: (id, from, to, title, status) => `[任务 ${id}] ${from} -> ${to}“${title}”：${zh.taskStatus[status]}`,
  taskStatus: { blocked: "等待前置任务", queued: "排队中", running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" },
  watching: (count) => `正在跟随 ${count} 个智能体；按 ctrl-c 停止`,
  project: (dir, pid) => `项目 ${dir}，中枢进程号 ${pid}`,
  openTasks: "未完成的任务：",
  hubRunning: (pid, since) => `中枢正在运行，进程号 ${pid}${since ? `，启动于 ${since}` : ""}`,
  hubNotRunning: "中枢没有在运行",
  hubStopped: "中枢已停止",
  hubStuck: (pid) => `中枢（进程号 ${pid}）在 5 秒内没有停止`,
  thinking: "思考：",
  tool: "工具",
  toolFailed: (title) => `${title} 失败`,
  user: "用户",
  interjected: "（插话）",
};

export const t: typeof en = { en, "zh-CN": zh }[language];
