/**
 * Errors a person has to read, as they cross ACP.
 *
 * Such an error carries `error.data.reason`, the stable thing to test for,
 * and next to it the facts of the case. Its `message` is the English wording;
 * a client that knows the reader's language words it again from the reason
 * and the facts (`explain`), so the hub never has to know who reads it.
 * Errors about a caller's mistake in the protocol carry no reason and stay
 * as they are.
 *
 * The numbers are for convenience: -32000 is ACP's own `auth_required`; the
 * -331xx block is xsb's and has no reservation in ACP, so another extension
 * may one day share it. Every other reason is ACP's "invalid params".
 */
import type { Language } from "./ext.ts";
import { RpcError } from "./jsonrpc.ts";

/** Reasons about backends -> error code, and exit code of the CLI. */
export const REASONS = {
  auth_required: { code: -32000, exit: 10 },
  backend_not_installed: { code: -33101, exit: 11 },
  backend_start_failed: { code: -33102, exit: 12 },
  backend_unknown: { code: -33103, exit: 13 },
  backend_incompatible: { code: -33104, exit: 14 },
} as const;

type Facts = Record<string, any>;
const list = (items: string[] | undefined, none: string): string => (items?.length ? items.join(", ") : none);

/** What each reason says, from the facts carried with it. */
const en = {
  auth_required: (d: Facts) =>
    `${d.detail}: agent "${d.agent}" (${d.info}) is not signed in. xsb does not handle credentials; sign in with that agent's own CLI or settings, then run \`xsb hub stop\` so the next start picks it up.${d.authMethods?.length ? ` It offers: ${d.authMethods.join(", ")}.` : ""}`,
  backend_not_installed: (d: Facts) =>
    `agent "${d.agent}": backend "${d.backend}" needs the command "${d.command}", which is not installed or not on PATH. xsb does not install backends${d.hint ? `; install it yourself, e.g. \`${d.hint}\`` : ""}.`,
  backend_start_failed: (d: Facts) =>
    `agent "${d.agent}": backend "${d.backend}" (${d.command}) ${d.exit} before it answered${d.stderr?.length ? `: ${d.stderr.join(" | ")}` : ""}`,
  backend_unknown: (d: Facts) =>
    `agent "${d.agent}": no backend named "${d.backend}". Known: ${list(d.known, "none")}. Backends are defined in ${d.config}.`,
  backend_incompatible: (d: Facts) => `agent "${d.agent}": backend "${d.backend}" speaks ACP v${d.backendVersion}, xsb needs v${d.hubVersion}`,
  no_such_backend: (d: Facts) => `no backend named "${d.backend}". Known: ${list(d.known, "none")}`,
  no_agents: () => "there are no agents yet; add one with `xsb agent add`",
  agent_unknown: (d: Facts) => `unknown agent "${d.agent}" (agents: ${list(d.known, "none")})`,
  agent_id_invalid: () => "agent id must be letters, digits, '-' or '_', and start with a letter or a digit",
  role_unknown: (d: Facts) =>
    `no role "${d.role}" (roles: ${list(d.known, "none")}). A role is the directory ${d.dir} with a role.json, or a role of a team the project uses.`,
  role_name_invalid: () => "role name must be letters, digits, '-' or '_'",
  role_of_team: (d: Facts) => `role "${d.role}" is the team "${d.team}"'s, not the project's own; it goes when the project drops the team`,
  role_in_use: (d: Facts) => `role "${d.role}" is in use by ${list(d.agents, "")}`,
  role_no_server: (d: Facts) => `role "${d.role}" has no MCP server "${d.server}"`,
  server_invalid: (d: Facts) => `MCP server "${d.server}" needs a name of letters, digits, '-' or '_' and a command`,
  skill_name_invalid: (d: Facts) => `skill name "${d.skill}" must be letters, digits, '-' or '_'`,
  team_unknown: (d: Facts) => `no team "${d.team}". Teams: ${list(d.known, "none")}`,
  team_in_use: (d: Facts) => `team "${d.team}" is in use by ${list(d.agents, "")}`,
  team_clash: (d: Facts) => `teams "${d.team}" and "${d.other}" both give a role "${d.role}"; a project cannot use both unless one extends the other`,
  session_busy: (d: Facts) => `agent "${d.agent}" is still working; stop it before clearing its context`,
  invalid_json: (d: Facts) => `${d.file} is not valid JSON: ${d.detail}`,
  not_a_project: (d: Facts) => `no .xsb here (${d.project}); run "xsb init" first`,
  hub_not_started: (d: Facts) => `the hub did not start; see ${d.log}`,
  hub_gone: () => "the hub stopped before this was done",
};

export type Reason = keyof typeof en;

const zh: Record<Reason, (d: Facts) => string> = {
  auth_required: (d) =>
    `${d.detail}：智能体“${d.agent}”（${d.info}）尚未登录。xsb 不处理凭据；请用该后端自己的命令行或设置登录，然后执行 \`xsb hub stop\`，下次启动时生效。${d.authMethods?.length ? `它支持的登录方式：${d.authMethods.join("、")}。` : ""}`,
  backend_not_installed: (d) =>
    `智能体“${d.agent}”：后端“${d.backend}”需要命令“${d.command}”，但它没有安装，或不在 PATH 中。xsb 不安装后端${d.hint ? `；请自行安装，例如 \`${d.hint}\`` : ""}。`,
  backend_start_failed: (d) =>
    `智能体“${d.agent}”：后端“${d.backend}”（${d.command}）还没有应答就退出了（${d.exit}）${d.stderr?.length ? `：${d.stderr.join(" | ")}` : ""}`,
  backend_unknown: (d) => `智能体“${d.agent}”：没有名为“${d.backend}”的后端。已有：${list(d.known, "无")}。后端在 ${d.config} 中定义。`,
  backend_incompatible: (d) => `智能体“${d.agent}”：后端“${d.backend}”使用 ACP 第 ${d.backendVersion} 版，xsb 需要第 ${d.hubVersion} 版`,
  no_such_backend: (d) => `没有名为“${d.backend}”的后端。已有：${list(d.known, "无")}`,
  no_agents: () => "还没有智能体；用 `xsb agent add` 添加一个",
  agent_unknown: (d) => `没有标识为“${d.agent}”的智能体（已有：${list(d.known, "无")}）`,
  agent_id_invalid: () => "智能体的标识只能用字母、数字、- 和 _，并以字母或数字开头",
  role_unknown: (d) => `没有角色“${d.role}”（已有：${list(d.known, "无")}）。角色是带有 role.json 的目录 ${d.dir}，或项目所用团队里的角色。`,
  role_name_invalid: () => "角色名只能用字母、数字、- 和 _",
  role_of_team: (d) => `角色“${d.role}”属于团队“${d.team}”，不是项目自己的；项目不再使用该团队时它才会消失`,
  role_in_use: (d) => `角色“${d.role}”正在被 ${list(d.agents, "")} 使用`,
  role_no_server: (d) => `角色“${d.role}”没有名为“${d.server}”的工具服务`,
  server_invalid: (d) => `工具服务“${d.server}”需要一个只含字母、数字、- 和 _ 的名称，以及启动命令`,
  skill_name_invalid: (d) => `技能名“${d.skill}”只能用字母、数字、- 和 _`,
  team_unknown: (d) => `没有团队“${d.team}”。已有：${list(d.known, "无")}`,
  team_in_use: (d) => `团队“${d.team}”正在被 ${list(d.agents, "")} 使用`,
  team_clash: (d) => `团队“${d.team}”和“${d.other}”都有角色“${d.role}”；除非其中一个基于另一个，否则不能同时使用`,
  session_busy: (d) => `智能体“${d.agent}”还在工作，先停下它再清除上下文`,
  invalid_json: (d) => `${d.file} 不是合法的 JSON：${d.detail}`,
  not_a_project: (d) => `这里没有 .xsb（${d.project}）；请先执行 "xsb init"`,
  hub_not_started: (d) => `中枢没有启动；详见 ${d.log}`,
  hub_gone: () => "中枢在这件事做完之前停止了",
};

const TEXT: Record<Language, Record<Reason, (d: Facts) => string>> = { en, "zh-CN": zh };

/** The error for a reason and the facts of the case. */
export function failure(reason: Reason, facts: Facts = {}): RpcError {
  const code = reason in REASONS ? REASONS[reason as keyof typeof REASONS].code : -32602;
  return new RpcError(code, en[reason](facts), { ...facts, reason });
}

/** The reason carried by an error, if it has one. A backend error that lost its tag is recognised by its code. */
export function reasonOf(e: unknown): Reason | undefined {
  if (!(e instanceof RpcError)) return undefined;
  const tagged = (e.data as { reason?: string } | undefined)?.reason;
  if (tagged) return tagged in en ? (tagged as Reason) : undefined;
  return (Object.keys(REASONS) as (keyof typeof REASONS)[]).find((r) => REASONS[r].code === e.code);
}

/** What an error says to a reader of `language`: worded from its reason where it has one, its own message otherwise. */
export function explain(e: unknown, language: Language): string {
  const reason = reasonOf(e);
  const facts = (e as RpcError).data as Facts | undefined;
  return reason && facts?.reason ? TEXT[language][reason](facts) : e instanceof Error ? e.message : String(e);
}

/** Process exit code of the CLI for an error. */
export function exitCode(e: unknown): number {
  const reason = reasonOf(e);
  return reason && reason in REASONS ? REASONS[reason as keyof typeof REASONS].exit : 1;
}
