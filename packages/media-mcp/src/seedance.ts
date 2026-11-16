/**
 * Seedance (Doubao's video model), as arkcli's asynchronous tasks:
 *
 *   arkcli +gen <prompt> --modality video     -> { task_id }
 *   arkcli gen get <id> --save-to=""          -> { status: { phase } }
 *   arkcli gen get <id> --save-to <dir>       saves the finished video, -> { local_path }
 *   arkcli gen delete <id> --yes              cancels a task that is still queued
 *
 * Which Seedance is the user's: the video resource their arkcli profile has
 * (`arkcli profile set-default <id> --modality video`). None is named from here.
 */
import fs from "node:fs";
import path from "node:path";
import { arkcli } from "./arkcli.ts";
import { QUIET, flags, input, saved } from "./ark.ts";
import type { Factory, VideoProvider, VideoRequest, VideoStatus } from "./provider.ts";

export const seedance: Factory<VideoProvider> = () => ({
  about: `Model: Doubao Seedance (the video model set in the user's arkcli), through arkcli. One clip is one continuous shot. Limits depend on the model version: the 2.0 series makes 4-15 second clips, the 2.5 series 4-30; 480p and 720p everywhere, higher on some. Ratios: 16:9, 9:16, 1:1, 4:3, 3:4, 21:9; with first_frame leave ratio out, the clip takes the image's. reference_images and first_frame cannot be combined. Reference images: at most 9 on the 2.0 series, 30 on the 2.5 series (10 on its flash model). Images travel inside the request: each under 30 MB, 300-6000 pixels a side, width/height between 0.4 and 2.5, and all the images of one call together under about 45 MB, or the request is refused; a JPEG copy of a large PNG is the way to stay under it. The last frame comes back as a JPEG. In the prompt, call the reference images 【图片1】, 【图片2】, … in their order and say what to take from each. Spoken lines go in quotation marks. A seed is honoured by some versions only.`,

  async submit(request: VideoRequest): Promise<string> {
    const images = [
      ...(request.firstFrame ? input("first_frame", request.firstFrame) : []),
      ...(request.lastFrame ? input("last_frame", request.lastFrame) : []),
      ...(request.references ?? []).flatMap((image) => input("reference_image", image)),
    ];
    const settings = flags({
      duration: request.duration,
      resolution: request.resolution,
      ratio: request.ratio,
      seed: request.seed,
      "generate-audio": request.audio,
      watermark: false,
      "return-last-frame": request.wantLastFrame || undefined,
    });
    // --save-to="": nothing to save yet; without --wait the task id comes back at once.
    const { task_id } = await arkcli(["+gen", request.prompt, "--modality", "video", ...settings, ...images, "--inline-local", "--save-to=", ...QUIET]);
    if (!task_id) throw new Error("arkcli +gen answered no task id");
    return task_id;
  },

  async poll(id: string): Promise<VideoStatus> {
    const { status } = await arkcli(["gen", "get", id, "--save-to=", "--no-open"]);
    const phase = status?.phase ?? status;
    if (phase === "queued" || phase === "running") return { status: "pending" };
    if (phase === "succeeded") return { status: "succeeded" };
    return { status: "failed", error: status?.message ?? `the task ended as "${phase}"` };
  },

  async save(id, to) {
    const task = await saved(to.video, (dir) => arkcli(["gen", "get", id, "--save-to", dir, "--no-open"]));
    // The last frame is not among the files arkcli saves; it comes as a link.
    const link = to.lastFrame && (task.last_frame_url ?? task.content?.last_frame_url);
    if (link) {
      fs.mkdirSync(path.dirname(path.resolve(to.lastFrame!)), { recursive: true });
      fs.writeFileSync(to.lastFrame!, Buffer.from(await (await fetch(link)).arrayBuffer()));
    }
    return { seed: task.seed, lastFrame: !!link };
  },

  /** Ark cancels only what has not started: a task that is already running finishes and is billed. */
  cancel: (id: string): Promise<boolean> => arkcli(["gen", "delete", id, "--yes"]).then(() => true, () => false),
});
