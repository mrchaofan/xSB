/**
 * `xsb-browser-mcp`: the stdio MCP server a role names to let its agents use
 * the browser in the app's side panel. It holds no logic: it tells the app
 * where its agent works and from then on is a pipe between the agent and the
 * app, which is the MCP server (browser.ts).
 */
import net from "node:net";
import { ATTACH, SOCKET_ENV } from "./browser.ts";

const fail = (message: string): never => {
  process.stderr.write(`xsb-browser-mcp: ${message}\n`);
  process.exit(1);
};
const socketPath = process.env[SOCKET_ENV] ?? fail("started through the launcher the xsb app puts on PATH, not by hand");

const socket = net.connect(socketPath);
socket.on("error", () => fail("the xsb app is not running: its browser is used through the app"));
socket.on("close", () => process.exit(0));
socket.write(JSON.stringify({ jsonrpc: "2.0", method: ATTACH, params: { cwd: process.cwd() } }) + "\n");
socket.pipe(process.stdout);
process.stdin.pipe(socket);
