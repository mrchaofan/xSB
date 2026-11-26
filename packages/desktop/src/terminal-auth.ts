/** Launch the configured agent in an OS interactive terminal; never collect terminal output. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { RpcError } from "@xsb/protocol";
import type { AuthMethod } from "@xsb/protocol";
export type TerminalAuthRequest = { agentId: string; method: AuthMethod; command: string; args: string[]; cwd: string };
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
export async function terminalAuth(request: TerminalAuthRequest, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ exitCode: number | null }> {
  if (request.method.type !== "terminal" || signal.aborted) throw RpcError.cancelled();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-auth-"));
  const config = path.join(folder, "request.json");
  const result = path.join(folder, "result.json");
  const cancel = path.join(folder, "cancel");
  const runner = fileURLToPath(new URL("../bin/xsb-auth-terminal", import.meta.url));
  fs.writeFileSync(config, JSON.stringify({ command: request.command, args: [...request.args, ...(request.method.args ?? [])], cwd: request.cwd,
    env: { ...env, ...Object.fromEntries((request.method.env ?? []).map(e => [e.name, e.value])) }, result, cancel }), { mode: 0o600 });
  let launch: string;
  let opener: ReturnType<typeof spawn>;
  if (process.platform === "win32") {
    launch = path.join(folder, "launch.ps1");
    fs.writeFileSync(launch, `$env:ELECTRON_RUN_AS_NODE='1'\n& ${psQuote(process.execPath)} ${psQuote(runner)} ${psQuote(config)}\n`, { mode: 0o700 });
    const args = `-NoProfile -ExecutionPolicy Bypass -File "${launch}"`;
    opener = spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process powershell.exe -ArgumentList ${psQuote(args)}`], { stdio: "ignore", env });
  } else {
    launch = path.join(folder, process.platform === "darwin" ? "launch.command" : "launch.sh");
    fs.writeFileSync(launch, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(runner)} ${quote(config)}\n`, { mode: 0o700 });
    opener = process.platform === "darwin" ? spawn("open", ["-a", "Terminal", launch], { stdio: "ignore", env }) : spawn("x-terminal-emulator", ["-e", launch], { stdio: "ignore", env });
  }
  const abort = () => { try { fs.writeFileSync(cancel, ""); } catch {} };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await new Promise((resolve, reject) => {
      let cancelledAt: number | undefined;
      const started = Date.now();
      let done = false;
      const finish = (error?: unknown, answer?: { exitCode: number | null }) => {
        if (done) return; done = true; clearInterval(poll);
        if (error) reject(error); else resolve(answer!);
      };
      const poll = setInterval(() => {
        if (fs.existsSync(result)) {
          try { finish(undefined, JSON.parse(fs.readFileSync(result, "utf8"))); } catch (e) { finish(e); }
        } else if (signal.aborted || Date.now() - started > 15 * 60_000) {
          cancelledAt ??= Date.now(); abort();
          if (Date.now() - cancelledAt > 5000) finish(RpcError.cancelled());
        }
      }, 150);
      opener.once("error", e => finish(e));
      opener.once("exit", code => { if (code && code !== 0) finish(new Error("Could not open an interactive terminal")); });
    });
  } finally { signal.removeEventListener("abort", abort); fs.rmSync(folder, { recursive: true, force: true }); }
}
