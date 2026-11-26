/**
 * `xsb-mcp-bridge`: the stdio MCP server a backend starts to reach the hub's
 * tools. It holds no logic: it presents its session's token to the hub (see
 * mcp.ts) and from then on is a pipe between the backend and the hub.
 */
import net from "node:net";
import { BRIDGE_ATTACH, BRIDGE_SERVER_ENV, BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV } from "./mcp.ts";

export function main(): void {
  const fail = (message: string): never => {
    process.stderr.write(`xsb-mcp-bridge: ${message}\n`);
    process.exit(1);
  };
  const socketPath = process.env[BRIDGE_SOCKET_ENV];
  const token = process.env[BRIDGE_TOKEN_ENV];
  if (!socketPath || !token) return fail("started by the hub, not by hand");

  const socket = net.connect(socketPath);
  socket.on("error", (e) => fail(e.message));
  socket.on("close", () => process.exit(0));
  socket.write(JSON.stringify({ jsonrpc: "2.0", id: "attach", method: BRIDGE_ATTACH, params: { token, server: process.env[BRIDGE_SERVER_ENV] } }) + "\n");
  let head = "";
  const onData = (chunk: Buffer): void => {
    head += chunk.toString("utf8");
    const nl = head.indexOf("\n");
    if (nl < 0) return;
    socket.off("data", onData);
    if (JSON.parse(head.slice(0, nl)).error) fail("the hub does not know this session");
    process.stdout.write(head.slice(nl + 1));
    socket.pipe(process.stdout);
    process.stdin.pipe(socket);
  };
  socket.on("data", onData);
}
