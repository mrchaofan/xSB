/**
 * A stdio MCP server that makes pictures: `generate_image` and
 * `generate_video`, each saving a file.
 *
 * The models are settings, not part of the tools: `IMAGE_PROVIDER` and
 * `VIDEO_PROVIDER` each name an entry of the registries below. An agent's prompts and files
 * stay the same when a model is replaced; only the limits it is told about
 * change (they are in the tools' descriptions).
 *
 * A video takes minutes and the call answers when the file is saved. An xsb
 * agent runs it in the background with `start_job` (the server keeps no state
 * between calls, which is what a job needs). When the call is cancelled, or
 * the server is told to stop, the generation is called off at the provider.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Connection, errorMessage } from "@xsb/protocol";
import { Ledger } from "./ledger.ts";
import type { Cost } from "./ledger.ts";
import type { ImageProvider, Usage, VideoProvider } from "./provider.ts";
import { seedance } from "./seedance.ts";
import { seedream } from "./seedream.ts";

const VIDEO_PROVIDERS: Record<string, VideoProvider> = { seedance };
const IMAGE_PROVIDERS: Record<string, ImageProvider> = { seedream };

/** How often in a row the state of a generation may fail to be read before it is given up. */
const POLL_RETRIES = 5;

function need(args: any, ...names: string[]): void {
  for (const name of names) if (typeof args[name] !== "string" || !args[name].trim()) throw new Error(`"${name}" is required`);
}

/** The images of a call: none, or a list of paths and URLs. Said here, before anything is submitted and billed. */
function imagesOf(args: any): string[] | undefined {
  const list = args.reference_images;
  if (list !== undefined && !(Array.isArray(list) && list.every((image) => typeof image === "string"))) {
    throw new Error(`"reference_images" must be an array of file paths or URLs, e.g. ["refs/lin_front.png"]`);
  }
  return list;
}

/**
 * The last frame of a saved video, taken from the file with the user's ffmpeg: for a provider that was asked for it
 * and handed none over. Answers whether there is one now.
 *
 *   FFMPEG   the program, when it is not `ffmpeg` on PATH
 */
function lastFrameOf(video: string, to: string): Promise<boolean> {
  fs.mkdirSync(path.dirname(path.resolve(to)), { recursive: true });
  // From a second before the end, every frame overwrites the image: what is left is the last one.
  const proc = spawn(process.env.FFMPEG || "ffmpeg", ["-y", "-loglevel", "error", "-sseof", "-1", "-i", video, "-update", "1", "-q:v", "2", to], { stdio: "ignore" });
  return new Promise((resolve) => {
    proc.on("error", () => resolve(false)); // no ffmpeg here
    proc.on("close", (code) => resolve(code === 0 && fs.existsSync(to)));
  });
}

/** Where an xsb project counts what generation costs (ledger.ts), and where the provider keeps its price list. */
type Accounts = { ledger: Ledger; prices: string } | undefined;

/** Write a generation down when there is a ledger; what to add to the tool's answer. */
async function account(accounts: Accounts, provider: { cost(usage: Usage, cache: string | undefined): Promise<Cost> }, tool: string, output: string, usage: Usage | undefined): Promise<string> {
  if (!accounts) return "";
  const cost: Cost = usage ? await provider.cost(usage, accounts.prices) : { amount: null, usage: "unknown", basis: "the provider reported no usage" };
  return `\n${accounts.ledger.record(tool, output, cost)}`;
}

async function generateImage(provider: ImageProvider, args: any, signal: AbortSignal, accounts: Accounts): Promise<string> {
  need(args, "prompt", "output");
  const usage = await provider.generate({ prompt: args.prompt, references: imagesOf(args), size: args.size, output: args.output }, signal);
  return `Saved ${path.resolve(args.output)}${await account(accounts, provider, "generate_image", args.output, usage)}`;
}

async function generateVideo(provider: VideoProvider, args: any, signal: AbortSignal, env: NodeJS.ProcessEnv, accounts: Accounts): Promise<string> {
  need(args, "prompt", "output");
  const references = imagesOf(args);
  if (args.last_frame && !args.first_frame) throw new Error(`"last_frame" needs "first_frame"`);
  if (references?.length && args.first_frame) throw new Error(`"reference_images" cannot be combined with "first_frame": use one or the other`);
  const id = await provider.submit({
    prompt: args.prompt,
    firstFrame: args.first_frame,
    lastFrame: args.last_frame,
    references,
    duration: args.duration,
    resolution: args.resolution,
    ratio: args.ratio,
    seed: args.seed,
    audio: args.audio,
    wantLastFrame: !!args.last_frame_output,
  });
  /** Give the generation up, and say whether that saved its cost. */
  const callOff = async (why: string): Promise<never> => {
    const stopped = await provider.cancel(id);
    // Billed, and what it cost is not known: written down as such, so that what was spent is not taken for less than it is.
    if (!stopped) accounts?.ledger.record("generate_video", args.output, { amount: null, usage: "unknown", basis: `generation ${id} was given up after the provider had started it; it is billed, its usage was not read` });
    throw new Error(`generation ${id} ${why}. ${stopped ? "It was cancelled at the provider and is not billed." : "The provider had already started it: it will finish and be billed, but its result is not fetched."} Nothing was saved to ${args.output}.`);
  };
  const deadline = Date.now() + Number(env.VIDEO_TIMEOUT_S ?? 1800) * 1000;
  for (let misses = 0; ; ) {
    await sleep(Number(env.VIDEO_POLL_MS ?? 5000), undefined, { signal }).catch(() => {});
    if (signal.aborted) return callOff("was cancelled");
    // One state that could not be read is no reason to give up a generation that is being paid for.
    const job = await provider.poll(id).catch((e) => (++misses < POLL_RETRIES ? undefined : callOff(`could not be checked (${errorMessage(e)})`)));
    if (job) misses = 0;
    if (job?.status === "failed") throw new Error(`generation ${id} failed: ${job.error}. Nothing was saved. If the reason is the prompt or the images, change them and submit again; otherwise report it to the user.`);
    if (job?.status === "succeeded") {
      const { seed, lastFrame, usage } = await provider.save(id, { video: args.output, lastFrame: args.last_frame_output }).catch((e) => {
        throw new Error(`generation ${id} finished and is billed, but its file could not be saved: ${errorMessage(e)}`);
      });
      const lines = [`Saved ${path.resolve(args.output)}`];
      if (lastFrame) lines.push(`Last frame saved to ${path.resolve(args.last_frame_output)}`);
      else if (args.last_frame_output && (await lastFrameOf(args.output, args.last_frame_output))) lines.push(`Last frame saved to ${path.resolve(args.last_frame_output)} (taken from the video: the provider returned none)`);
      else if (args.last_frame_output) lines.push(`Last frame NOT saved: the provider returned none, and it could not be taken from the video (that needs ffmpeg on PATH). ${args.last_frame_output} does not exist; do not use it as a first_frame.`);
      if (seed !== undefined) lines.push(`seed: ${seed}`);
      return [...lines, `generation id: ${id}`].join("\n") + (await account(accounts, provider, "generate_video", args.output, usage));
    }
    if (Date.now() > deadline) return callOff(`was not finished after ${env.VIDEO_TIMEOUT_S ?? 1800}s`);
  }
}

/**
 * The provider a setting names. `use` answers it, or fails with why there is none; `about` is what the tool's
 * description says of it: the model's limits, or that the tool cannot be used, where an agent and a person see it.
 */
function choose<Provider extends { about: string }>(registry: Record<string, Provider>, setting: string, fallback: string, env: NodeJS.ProcessEnv): { use: () => Provider; about: string } {
  const name = env[setting] || fallback;
  const provider: Provider | undefined = registry[name];
  const error = `unknown ${setting} "${name}". Known: ${Object.keys(registry).join(", ")}`;
  const use = (): Provider => {
    if (!provider) throw new Error(error);
    return provider;
  };
  return { use, about: provider ? provider.about : `NOT AVAILABLE: ${error}. Every call fails until the user corrects the settings of this MCP server; tell the user instead of calling it.` };
}

const str = (description: string): object => ({ type: "string", description });
const images = (description: string): object => ({ type: "array", items: { type: "string" }, description });

/** At most `n` at a time; the others wait their turn. */
function limiter(n: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (work) => {
    if (running >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** Images asked for at once beyond this wait here: the provider would queue them anyway, slower and out of sight. */
const IMAGES_AT_ONCE = 3;

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const image = choose(IMAGE_PROVIDERS, "IMAGE_PROVIDER", "seedream", env);
  const video = choose(VIDEO_PROVIDERS, "VIDEO_PROVIDER", "seedance", env);
  // XSB_SPEND: the ledger of the xsb project this server works for; XSB_AGENT: the agent it works for.
  const accounts: Accounts = env.XSB_SPEND ? { ledger: new Ledger(env.XSB_SPEND, env.XSB_AGENT), prices: path.join(path.dirname(env.XSB_SPEND), "run", "prices.json") } : undefined;
  const oneOfFew = limiter(IMAGES_AT_ONCE);
  /** Calls that are running: the server does not exit before each has called its generation off. */
  const running = new Set<Promise<unknown>>();

  const conn = new Connection(process.stdin, process.stdout, "media");
  conn.onRequest("initialize", (p) => ({
    protocolVersion: p.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "xsb-media-mcp", version: "0.1.0" },
  }));
  conn.onRequest("tools/list", () => ({
    tools: [
      {
        name: "generate_image",
        description: `xsb's image generation, billed per image. Generate one image from a prompt and save it as a file: a character or location reference, a style frame, the first frame of a shot. Takes seconds: call it directly. ${image.about}`,
        inputSchema: {
          type: "object",
          required: ["prompt", "output"],
          properties: {
            prompt: str("What the image shows: subject, setting, composition, light, style."),
            output: str("Path of the image file to write; name it .png or .jpg, the extension decides the format. E.g. refs/lin_front.png. Relative paths are relative to your working directory; missing folders are created, an existing file is overwritten."),
            reference_images: images("Images to work from or stay consistent with: file paths or URLs, in the order the prompt refers to them."),
            size: str("Output size, in a form the model accepts (see above). Leave it out for the model's default."),
          },
        },
      },
      {
        name: "generate_video",
        description: `xsb's video generation, billed by usage. Generate one video clip from a prompt and save it as a file. It takes minutes and answers only when the file is saved, so do not wait in the call: submit it with start_job and collect the result with await_tasks. To give a clip up, cancel that job (cancel_task): a generation still queued at the provider is called off and not billed, one the provider has started finishes and is billed. Every call costs money: draft at a low resolution, and run a shot again only when its prompt or inputs changed. ${video.about}`,
        inputSchema: {
          type: "object",
          required: ["prompt", "output"],
          properties: {
            prompt: str("What is seen and heard: subject, action, setting, camera, light, style. One continuous shot."),
            output: str("Path of the video file to write; name it .mp4, e.g. shots/s01_01.mp4. Relative paths are relative to your working directory; missing folders are created, an existing file is overwritten."),
            first_frame: str("Image the clip starts on: a file path or URL."),
            last_frame: str("Image the clip ends on (needs first_frame): a file path or URL."),
            reference_images: images("Images the clip should stay consistent with (a character, a place): file paths or URLs, in the order the prompt refers to them. Cannot be combined with first_frame."),
            duration: { type: "integer", description: "Length of the clip in whole seconds, within the model's range (see above). Leave it out for the model's default." },
            resolution: str(`A resolution the model offers (see above), e.g. "480p" for a draft, "720p" or higher for the final. Leave it out for the model's default.`),
            ratio: str(`Aspect ratio, e.g. "16:9" or "9:16". Leave it out when you give first_frame: the clip takes the image's.`),
            seed: { type: "integer", description: "The same seed with the same prompt and inputs repeats a result, where the model honours seeds; another one varies it." },
            audio: { type: "boolean", description: "Generate sound with the picture, where the model can." },
            last_frame_output: str("Also save the clip's last frame to this path (a JPEG: name it .jpg), to start the next shot on it. When the model returns none it is taken from the video itself; the result says whether it was saved."),
          },
        },
      },
    ],
  }));
  conn.onRequest("tools/call", (p, { signal }) => {
    const args = p.arguments ?? {};
    const call = (async () => {
      if (p.name === "generate_image") return oneOfFew(() => generateImage(image.use(), args, signal, accounts));
      if (p.name === "generate_video") return generateVideo(video.use(), args, signal, env, accounts);
      throw new Error(`no tool "${p.name}"`);
    })().then(
      (text) => ({ content: [{ type: "text", text }] }),
      (e) => ({ content: [{ type: "text", text: errorMessage(e) }], isError: true }),
    );
    running.add(call);
    void call.finally(() => running.delete(call));
    return call;
  });

  // Told to stop or left alone: every call is cancelled, and each calls its generation off before the process ends.
  const stop = (): void => {
    conn.close();
    void Promise.allSettled([...running]).then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  void conn.closed.then(stop);
}
