/**
 * A stdio MCP server that stands in for a slow generation service.
 *
 *   render { prompt, ms }   takes `ms`, then answers "rendered: <prompt> (key <GEN_KEY>)";
 *                           the prompt "fail" answers an error
 */
import { setTimeout as sleep } from "node:timers/promises";
import { Connection } from "@xsb/protocol";

const conn = new Connection(process.stdin, process.stdout, "generator");
conn.onRequest("initialize", (p) => ({
  protocolVersion: p.protocolVersion,
  capabilities: { tools: {} },
  serverInfo: { name: "mock-generator", version: "0" },
}));
conn.onRequest("tools/list", () => ({
  tools: [{ name: "render", description: "Render a shot.", inputSchema: { type: "object", properties: {} } }],
}));
conn.onRequest("tools/call", async (p, { signal }) => {
  await sleep(Number(p.arguments?.ms ?? 0), undefined, { signal }).catch(() => {});
  if (signal.aborted) return { content: [{ type: "text", text: `render of ${p.arguments?.prompt} was called off and is not billed` }], isError: true };
  const failed = p.arguments?.prompt === "fail";
  const text = failed ? "the renderer refused" : `rendered: ${p.arguments?.prompt} (key ${process.env.GEN_KEY})`;
  return { content: [{ type: "text", text }], isError: failed };
});
