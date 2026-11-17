/**
 * The hub, and what a client needs in order to find, start and configure one.
 * Clients talk to a running hub over ACP (see @xsb/protocol); nothing here is
 * a second way in.
 */
export { Hub } from "./hub.ts";
export { hubSocket, readHubInfo, stopHub } from "./daemon.ts";
export { Paths, findProject } from "./paths.ts";
export { COMMON_SERVERS_ENV } from "./mcp.ts";
export { describeBackends, findCommand, globalConfigPath, initProject } from "./config.ts";
export { catalog, lineage, presetRoots } from "./presets.ts";
