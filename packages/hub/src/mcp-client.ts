/**
 * One request to a stdio MCP server: start the server, ask, stop it. This is
 * how the hub runs a job on an agent's behalf (mailroom.ts) and how it checks
 * that a role's servers work (acp-server.ts).
 */
import { spawn } from "node:child_process";
import { Connection } from "@xsb/protocol";
import type { McpServer } from "@xsb/protocol";
import { VERSION } from "./util.ts";

export async function mcpRequest(server: McpServer, method: string, params: unknown, cwd: string, signal: AbortSignal): Promise<any> {
  if (!server.command) throw new Error(`MCP server "${server.name}" is not a stdio server`);
  const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value])) };
  const proc = spawn(server.command, server.args ?? [], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const conn = new Connection(proc.stdout, proc.stdin, `MCP server "${server.name}"`);
  proc.stdin.on("error", () => {});

  const stopped = new Promise<never>((_, reject) => {
    proc.on("error", (e) => reject(new Error(`cannot start MCP server "${server.name}" (${server.command}): ${e.message}`)));
    signal.addEventListener("abort", () => reject(new Error(signal.reason?.message ?? "cancelled")));
  });
  const answer = (async () => {
    await conn.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "xsb", version: VERSION },
    });
    conn.notify("notifications/initialized");
    return conn.request(method, params);
  })();
  answer.catch(() => {}); // when `stopped` wins, the request fails with the closed pipe: nobody asks any more
  try {
    return await Promise.race([answer, stopped]);
  } finally {
    conn.close();
    proc.kill();
  }
}
