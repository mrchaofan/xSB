/** A real stdio MCP plugin used by the ACP end-to-end test. Its business data becomes Markdown here. */
import net from "node:net";
import { Connection, PluginPublication, ToolContext } from "@xsb/protocol";

const mcp = new Connection(process.stdin, process.stdout, "audit-output");
mcp.onRequest("initialize", () => ({
  protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "audit-output", version: "1" },
}));
mcp.onRequest("tools/list", () => ({ tools: [{
  name: "inspection", description: "Publish the inspection findings.",
  inputSchema: { type: "object", properties: { id: { type: "string" }, project: { type: "string" },
    checks: { type: "array", items: { type: "string" } }, probe: { type: "string" } }, required: ["id", "project", "checks"] },
}] }));
mcp.onRequest("tools/call", async ({ name, arguments: args }) => {
  if (name !== "inspection") throw Error("Unknown inspection tool");
  const socket = net.connect(process.env[ToolContext.socketEnv]!);
  const host = new Connection(socket, socket, "audit-publisher");
  const markdown = "## " + args.project + " inspection\n\n" + args.checks.map((check: string) => "- " + check).join("\n");
  const token = process.env[args.probe === "readOnly" ? ToolContext.tokenEnv : PluginPublication.tokenEnv];
  const extra = args.probe && args.probe !== "readOnly" ? { [args.probe]: "unused field" } : {};
  try {
    const response = await host.request(PluginPublication.publish, { token, idempotencyKey: args.id, markdown, ...extra });
    return { content: [{ type: "text", text: "published " + response.id }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: "rejected " + args.probe + ": " + (error as Error).message }] };
  } finally {
    host.close();
  }
});
