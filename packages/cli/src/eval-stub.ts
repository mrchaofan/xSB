/**
 * Stand-ins for the tool servers a scenario must not really use (`xsb team eval`): each answers its tools as the
 * real one would in shape, does nothing, and costs nothing. Which one it is, is its argument:
 *
 *   browser   the side-panel browser of the app (browser_navigate, browser_snapshot)
 *   desktop   a tool that operates applications of the user's computer, to compete with the browser for a request
 *   media     image and video generation (generate_image, generate_video): answers "Saved <output>"
 *
 * The descriptions are those of the real tools where there are real ones, so that what the model chooses by is
 * what it would choose by in the app.
 */
import { Connection } from "@xsb/protocol";

const str = (description: string) => ({ type: "string", description });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

const TOOLS: Record<string, { name: string; description: string; inputSchema: unknown }[]> = {
  browser: [
    {
      name: "browser_navigate",
      description:
        "Open a web page in the browser of the xsb app's side panel, where the user watches and can take over. This is the browser the user means by \"the browser\", \"the built-in browser\", \"the side-panel browser\" or \"IAB\" (in Chinese 浏览器, 内置浏览器, 右栏浏览器); use another browser or a computer-use tool only when the user names an application of their own computer. Returns a snapshot of the page.",
      inputSchema: object({ url: str("The address to load.") }, ["url"]),
    },
    { name: "browser_snapshot", description: "Read the page as it is now.", inputSchema: object({}) },
  ],
  desktop: [
    {
      name: "open_in_app",
      description: "Control native apps and browsers on the user's computer: open an application, a file or a web address in it.",
      inputSchema: object({ app: str("The application, e.g. Microsoft Edge."), target: str("What to open in it.") }, ["target"]),
    },
  ],
  media: [
    { name: "generate_image", description: "xsb's image generation, billed per image. Generate one image from a prompt and save it as a file.", inputSchema: object({ prompt: str("What the image shows."), output: str("The file to write.") }, ["prompt", "output"]) },
    { name: "generate_video", description: "xsb's video generation, billed by usage. Generate one video clip from a prompt and save it as a file; submit it with start_job.", inputSchema: object({ prompt: str("What is seen and heard."), output: str("The file to write.") }, ["prompt", "output"]) },
  ],
};

const kind = process.argv[2] ?? "";
if (!TOOLS[kind]) {
  process.stderr.write(`xsb eval stub: unknown kind "${kind}"\n`);
  process.exit(2);
}
const conn = new Connection(process.stdin, process.stdout, `stub-${kind}`);
conn.onRequest("initialize", (p) => ({ protocolVersion: p.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: `xsb-eval-${kind}`, version: "0" } }));
conn.onRequest("tools/list", () => ({ tools: TOOLS[kind] }));
conn.onRequest("tools/call", (p) => {
  const args = p.arguments ?? {};
  const said = p.name === "browser_navigate" ? `Example page\n${args.url}\n[1] link "Example"` : args.output ? `Saved ${args.output}` : "Done.";
  return { content: [{ type: "text", text: said }] };
});
void conn.closed.then(() => process.exit(0));
