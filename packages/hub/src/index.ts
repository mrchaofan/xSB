/**
 * The hub, and what a client needs in order to find, start and configure one.
 * Clients talk to a running hub over ACP (see @xsb/protocol); nothing here is
 * a second way in.
 */
export { Hub } from "./hub.ts";
export { hubSocket, readHubInfo, stopHub } from "./daemon.ts";
export { Paths, findProject } from "./paths.ts";
export { consultationSettings, setConsultation, describeBackends, findCommand, globalConfigPath, initProject, limitSettings, projectLanguageSetting, setLimit, setProjectLanguage } from "./config.ts";
export { approvePlugin, ensurePluginRoot, listPlugins, setPluginEnabled } from "./plugins.ts";
export { WITHHELD_ENV, withhold } from "./util.ts";
export type { PluginProblem, PluginScope, PluginView } from "./plugins.ts";
export { pluginApprovals, revokePluginApproval } from "./trust.ts";
export { atomicWrite } from "@xsb/store";
export { updateJsonFile } from "./config-files.ts";

export { Hooks, isVeto } from "./hooks.ts";
export { Lifecycle } from "./lifecycle.ts";
export type { LifecycleEvent, LifecyclePoint } from "./lifecycle.ts";
export type { KernelHooks } from "./kernel.ts";
