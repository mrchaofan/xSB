/**
 * The hub as a background process: one per project, found through
 * `.xsb/run/hub.json`, started on demand by whichever client needs it first.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Hub } from "./hub.ts";
import { Paths } from "./paths.ts";
import { errorMessage, failure } from "@xsb/protocol";
import { now } from "./util.ts";

const BIN = fileURLToPath(new URL("../bin/xsb-hub", import.meta.url));

export type HubInfo = { pid: number; startedAt: string };

/** The running hub of a project, or null. A file left by a dead process does not count. */
export function readHubInfo(paths: Paths): HubInfo | null {
  try {
    const info: HubInfo = JSON.parse(fs.readFileSync(paths.hubInfo, "utf8"));
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

/**
 * Tell the project's hub to stop; whether one was running. It stops in its own time: what it was in the middle
 * of is not acknowledged, so an agent's turn runs again on the next start, and a job does not (see mailroom.ts).
 *
 * With `abandon`, the next start does not pick that up either: everything unfinished is given up
 * (`Mailroom.abandon`). That is a mark left for the next hub, not something asked of this one, so it holds
 * however this one ends.
 */
export function stopHub(paths: Paths, abandon = false): boolean {
  const info = readHubInfo(paths);
  if (!info) return false;
  if (abandon) fs.writeFileSync(paths.abandonMark, "");
  process.kill(info.pid, "SIGTERM");
  return true;
}

/**
 * Claim the project for this process. `hub.json` is created exclusively, so
 * of two hubs started at the same moment one fails here, before it touches
 * the sockets or the logs of the other.
 */
function claim(paths: Paths): void {
  const info: HubInfo = { pid: process.pid, startedAt: now() };
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.writeFileSync(paths.hubInfo, JSON.stringify(info), { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw e;
      const running = readHubInfo(paths);
      if (running) throw new Error(`a hub is already running for ${paths.project} (pid ${running.pid})`);
      fs.rmSync(paths.hubInfo, { force: true }); // left behind by a hub that died
    }
  }
}

/** Run the hub in this process until it is told to stop. */
async function runHub(project: string): Promise<void> {
  const paths = new Paths(project);
  if (!fs.existsSync(paths.dir)) throw new Error(`no ${paths.dir}: run "xsb init" first`);
  fs.mkdirSync(paths.run, { recursive: true });
  claim(paths);
  const release = (): void => fs.rmSync(paths.hubInfo, { force: true });

  let hub: Hub;
  try {
    hub = new Hub(project);
    await hub.start();
  } catch (e) {
    release();
    throw e;
  }
  const stop = (): void => {
    void hub.shutdown().finally(() => {
      release();
      process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("uncaughtException", (e) => hub.log(`uncaught: ${e.stack ?? e}`));
  process.on("unhandledRejection", (e) => hub.log(`unhandled: ${e instanceof Error ? e.stack : e}`));
}

function tryConnect(path: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => resolve(null));
  });
}

/** A socket to the project's hub, for a client to speak ACP on. Starts the hub in the background if there is none. */
export async function hubSocket(paths: Paths): Promise<net.Socket> {
  if (!fs.existsSync(paths.dir)) throw failure("not_a_project", { project: paths.project });
  const path = paths.socket("acp");
  let socket = readHubInfo(paths) ? await tryConnect(path) : null;
  if (socket) return socket;

  spawnHub(paths);
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (readHubInfo(paths) && (socket = await tryConnect(path))) return socket;
  }
  throw failure("hub_not_started", { log: paths.hubLog });
}

/** Start a hub for the project in the background, logging to `.xsb/run/hub.log`. */
function spawnHub(paths: Paths): void {
  fs.mkdirSync(paths.run, { recursive: true });
  const log = fs.openSync(paths.hubLog, "a");
  // A client that is an Electron app has Electron's binary as its execPath; this makes it run as Node. Node ignores it.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  spawn(process.execPath, [BIN, paths.project], { detached: true, stdio: ["ignore", log, log], env }).unref();
  fs.closeSync(log);
}

/** Entry point of `bin/xsb-hub <project dir>`. */
export async function main(argv: string[]): Promise<void> {
  try {
    if (!argv[0]) throw new Error("usage: xsb-hub <project dir>");
    await runHub(argv[0]);
  } catch (e) {
    process.stderr.write(`${now()} xsb-hub: ${errorMessage(e)}\n`);
    process.exit(1);
  }
}
