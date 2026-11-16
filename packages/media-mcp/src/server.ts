/**
 * A stdio MCP server that makes pictures: `generate_image` and
 * `generate_video`, each saving a file.
 *
 * The models are settings, not part of the tools: `IMAGE_PROVIDER` and
 * `VIDEO_PROVIDER` each name an entry of the registries below, and a provider
 * reads its own settings from the environment. An agent's prompts and files
 * stay the same when a model is replaced; only the limits it is told about
 * change (they are in the tools' descriptions).
 *
 * A video takes minutes and the call answers when the file is saved. An xsb
 * agent runs it in the background with `start_job` (the server keeps no state
 * between calls, which is what a job needs). When the call is cancelled, or
 * the server is told to stop, the generation is called off at the provider.
 */
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Connection, errorMessage } from "@xsb/protocol";
import type { Factory, ImageProvider, VideoProvider } from "./provider.ts";
import { seedance } from "./seedance.ts";
import { seedream } from "./seedream.ts";

const VIDEO_PROVIDERS: Record<string, Factory<VideoProvider>> = { seedance };
const IMAGE_PROVIDERS: Record<string, Factory<ImageProvider>> = { seedream };

function need(args: any, ...names: string[]): void {
  for (const name of names) if (typeof args[name] !== "string" || !args[name].trim()) throw new Error(`"${name}" is required`);
}

async function generateImage(provider: ImageProvider, args: any, signal: AbortSignal): Promise<string> {
  need(args, "prompt", "output");
  await provider.generate({ prompt: args.prompt, references: args.reference_images, size: args.size, output: args.output }, signal);
  return `Saved ${path.resolve(args.output)}`;
}

async function generateVideo(provider: VideoProvider, args: any, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<string> {
  need(args, "prompt", "output");
  const id = await provider.submit({
    prompt: args.prompt,
    firstFrame: args.first_frame,
    lastFrame: args.last_frame,
    references: args.reference_images,
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
    throw new Error(`generation ${id} ${why}. ${stopped ? "It was cancelled at the provider and is not billed." : "The provider had already started it: it will finish and be billed, but its result is not fetched."}`);
  };
  const deadline = Date.now() + Number(env.VIDEO_TIMEOUT_S ?? 1800) * 1000;
  for (;;) {
    await sleep(Number(env.VIDEO_POLL_MS ?? 5000), undefined, { signal }).catch(() => {});
    if (signal.aborted) return callOff("was cancelled");
    const job = await provider.poll(id);
    if (job.status === "failed") throw new Error(`generation ${id} failed: ${job.error}`);
    if (job.status === "succeeded") {
      const { seed, lastFrame } = await provider.save(id, { video: args.output, lastFrame: args.last_frame_output });
      const lines = [`Saved ${path.resolve(args.output)}`];
      if (lastFrame) lines.push(`Last frame saved to ${path.resolve(args.last_frame_output)}`);
      if (seed !== undefined) lines.push(`seed: ${seed}`);
      return [...lines, `generation id: ${id}`].join("\n");
    }
    if (Date.now() > deadline) return callOff(`was not finished after ${env.VIDEO_TIMEOUT_S ?? 1800}s`);
  }
}

/** The provider a setting names, or why there is none: reported by the tool, where an agent and a person see it. */
function choose<Provider extends { about: string }>(registry: Record<string, Factory<Provider>>, setting: string, fallback: string, env: NodeJS.ProcessEnv): { provider?: Provider; about: string } {
  try {
    const name = env[setting] || fallback;
    if (!registry[name]) throw new Error(`unknown ${setting} "${name}". Known: ${Object.keys(registry).join(", ")}`);
    const provider = registry[name](env);
    return { provider, about: provider.about };
  } catch (e) {
    return { about: `NOT CONFIGURED: ${errorMessage(e)}` };
  }
}

const str = (description: string): object => ({ type: "string", description });
const images = (description: string): object => ({ type: "array", items: { type: "string" }, description });

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const image = choose(IMAGE_PROVIDERS, "IMAGE_PROVIDER", "seedream", env);
  const video = choose(VIDEO_PROVIDERS, "VIDEO_PROVIDER", "seedance", env);
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
        description: `Generate one image from a prompt and save it as a file: a character or location reference, a style frame, the first frame of a shot. Takes seconds. ${image.about}`,
        inputSchema: {
          type: "object",
          required: ["prompt", "output"],
          properties: {
            prompt: str("What the image shows: subject, setting, composition, light, style."),
            output: str("Path of the image file to write, e.g. refs/lin_front.png. Relative paths are relative to your working directory."),
            reference_images: images("Images to work from or stay consistent with: file paths or URLs."),
            size: str(`A tier such as "2K", or exact pixels such as "2560x1440".`),
          },
        },
      },
      {
        name: "generate_video",
        description: `Generate one video clip from a prompt and save it as a file. Takes minutes: run it in the background (start_job) rather than waiting in the call. Cancelling the call calls the generation off. ${video.about}`,
        inputSchema: {
          type: "object",
          required: ["prompt", "output"],
          properties: {
            prompt: str("What is seen and heard: subject, action, setting, camera, light, style. One continuous shot."),
            output: str("Path of the video file to write, e.g. shots/s01_01.mp4. Relative paths are relative to your working directory."),
            first_frame: str("Image the clip starts on: a file path or URL."),
            last_frame: str("Image the clip ends on (needs first_frame): a file path or URL."),
            reference_images: images("Images to stay consistent with (character, place): file paths or URLs. Not together with first_frame."),
            duration: { type: "integer", description: "Seconds." },
            resolution: str(`"480p", "720p" or "1080p". Draft at 480p, finish at a higher one.`),
            ratio: str(`"16:9", "9:16", "1:1", …`),
            seed: { type: "integer", description: "Repeat a result, or vary it on purpose." },
            audio: { type: "boolean", description: "Generate sound with the picture, where the model can." },
            last_frame_output: str("Also save the clip's last frame to this image path, to start the next shot on it. It is a JPEG: name the file .jpg."),
          },
        },
      },
    ],
  }));
  conn.onRequest("tools/call", (p, { signal }) => {
    const args = p.arguments ?? {};
    const call = (async () => {
      if (p.name === "generate_image") return generateImage(image.provider ?? fail(image.about), args, signal);
      if (p.name === "generate_video") return generateVideo(video.provider ?? fail(video.about), args, signal, env);
      throw new Error(`no tool "${p.name}"`);
    })().then(
      (text) => ({ content: [{ type: "text", text }] }),
      (e) => ({ content: [{ type: "text", text: errorMessage(e) }], isError: true }),
    );
    running.add(call);
    void call.finally(() => running.delete(call));
    return call;
  });

  // Told to stop (the hub does this to a cancelled job) or left alone: every call is cancelled, and each calls its generation off before the process ends.
  const stop = (): void => {
    conn.close();
    void Promise.allSettled([...running]).then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  void conn.closed.then(stop);
}

function fail(about: string): never {
  throw new Error(about.replace("NOT CONFIGURED: ", ""));
}
