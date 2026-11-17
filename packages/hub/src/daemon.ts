/**
 * The hub as a background process: one per project, started on demand by
 * whichever client needs it first.
 *
 * One per project, because a hub is the single writer of the project's logs,
 * the owner of its agents' processes and the listener on its sockets: two of
 * them would each append to the same files, run the same mail twice and take
 * the socket from under the other. That there is only one is the kernel's
 * word, not a file's: the hub holds a lock on `.xsb/run/hub.lock` (lock.ts)
 * for as long as its process lives. `.xsb/run/hub.json` says who holds it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Hub } from "./hub.ts";
import { isLocked, lockFile } from "./lock.ts";
import { Paths } from "./paths.ts";
import { errorMessage, failure } from "@xsb/protocol";
import { now } from "./util.ts";

const BIN = fileURLToPath(new URL("../bin/xsb-hub", import.meta.url));

export type HubInfo = { pid: number; startedAt: string };

/** How long a starting hub waits for the lock: long enough for one that was just told to stop to be gone. */
const CLAIM_WAIT_MS = 3000;

/**
 * The running hub of a project, or null. Whether one runs is whether the lock is held; the file a dead hub left
 * says nothing, so its process id is never taken for a hub's (it may be another program's by now).
 */
export function readHubInfo(paths: Paths): HubInfo | null {
  try {
    return isLocked(paths.hubLock) ? JSON.parse(fs.readFileSync(paths.hubInfo, "utf8")) : null;
  } catch {
    return null; // a hub that holds the lock and has not said who it is yet: not there to be talked to
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
 * Claim the project for this process, and answer how to let it go. Of two hubs started at the same moment one
 * fails here, before it touches the sockets or the logs of the other.
 */
function claim(paths: Paths): () => void {
  const unlock = lockFile(paths.hubLock, CLAIM_WAIT_MS);
  if (!unlock) throw new Error(`a hub is already running for ${paths.project}${fs.existsSync(paths.hubInfo) ? ` (${fs.readFileSync(paths.hubInfo, "utf8")})` : ""}`);
  const info: HubInfo = { pid: process.pid, startedAt: now() };
  fs.writeFileSync(paths.hubInfo, JSON.stringify(info));
  return () => {
    fs.rmSync(paths.hubInfo, { force: true });
    unlock();
  };
}

/** Run the hub in this process until it is told to stop. */
async function runHub(project: string): Promise<void> {
  const paths = new Paths(project);
  if (!fs.existsSync(paths.dir)) throw new Error(`no ${paths.dir}: run "xsb init" first`);
  fs.mkdirSync(paths.run, { recursive: true });
  const release = claim(paths);

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
  // A socket that answers is a hub that lives. One started here while another is starting loses the claim and goes away.
  let socket = await tryConnect(path);
  if (socket) return socket;

  spawnHub(paths);
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if ((socket = await tryConnect(path))) return socket;
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
