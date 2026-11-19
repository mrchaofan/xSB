/**
 * One request to a stdio MCP server: start the server, ask, stop it. This is
 * how the hub runs a job on an agent's behalf (jobs.ts) and how it checks
 * that a role's servers work (acp-server.ts).
 *
 * Aborting `signal` cancels the request the way MCP does (`notifications/cancelled`).
 * The server then has `graceMs` to answer what became of the call: a tool that
 * started something outside (a generation that is billed) calls it off and says
 * so. Only after that is the server stopped.
 */
import spawn from "cross-spawn";
import { Connection } from "@xsb/protocol";
import type { McpServer } from "@xsb/protocol";
import { VERSION } from "./util.ts";

export async function mcpRequest(server: McpServer, method: string, params: unknown, cwd: string, signal: AbortSignal, graceMs = 0): Promise<any> {
  if (server.type !== "stdio") throw new Error(`MCP server "${server.name}" is not a stdio server`);
  const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value])) };
  const proc = spawn(server.command, server.args ?? [], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const conn = new Connection(proc.stdout!, proc.stdin!, `MCP server "${server.name}"`);
  proc.stdin!.on("error", () => {});

  let grace: NodeJS.Timeout | undefined;
  let giveUp = (): void => {};
  const stopped = new Promise<never>((_, reject) => {
    proc.on("error", (e) => reject(new Error(`cannot start MCP server "${server.name}" (${server.command}): ${e.message}`)));
    giveUp = () => void (grace = setTimeout(() => reject(new Error(signal.reason?.message ?? "cancelled")), graceMs));
  });
  signal.addEventListener("abort", giveUp, { once: true });
  const answer = (async () => {
    await conn.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "xsb", version: VERSION },
    });
    conn.notify("notifications/initialized");
    return conn.request(method, params, { signal, notify: "notifications/cancelled" });
  })();
  answer.catch(() => {}); // when `stopped` wins, the request fails with the closed pipe: nobody asks any more
  try {
    return await Promise.race([answer, stopped]);
  } finally {
    clearTimeout(grace);
    signal.removeEventListener("abort", giveUp);
    conn.close();
    proc.kill();
  }
}
