/**
 * Seedream (Doubao's image model): `arkcli +gen <prompt> --modality image`,
 * which answers when the image is saved.
 *
 * Which Seedream is the user's: the image resource their arkcli profile has
 * (`arkcli profile set-default <id> --modality image`). None is named from here.
 */
import path from "node:path";
import { arkcli } from "./arkcli.ts";
import { QUIET, flags, input, saved } from "./ark.ts";
import type { Factory, ImageProvider } from "./provider.ts";

/** The file is what its name says: without this the model answers a JPEG whatever the output is called. */
const format = (output: string): string | undefined => ({ ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg" })[path.extname(output).toLowerCase()];

export const seedream: Factory<ImageProvider> = () => ({
  about: `Model: Doubao Seedream (the image model set in the user's arkcli), through arkcli. Size is a tier such as "2K" or exact pixels such as "2560x1440"; say the aspect ratio in the prompt when you give a tier or none. Up to 10 reference images; in the prompt call them 图1, 图2, … in their order. Keep the prompt under 300 Chinese characters.`,

  async generate(request, signal): Promise<void> {
    const references = (request.references ?? []).flatMap((image) => input("reference_image", image));
    await saved(request.output, (dir) =>
      // --inline-local: reference files travel in the request itself, so no storage bucket is needed.
      arkcli(["+gen", request.prompt, "--modality", "image", ...flags({ size: request.size, "output-format": format(request.output), watermark: false, "save-to": dir }), ...references, "--inline-local", ...QUIET], { signal }),
    );
  },
});
