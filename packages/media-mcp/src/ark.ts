/**
 * What the two Ark providers (seedream.ts, seedance.ts) share: Doubao's
 * models are reached through Volcengine's CLI (`arkcli +gen`, see arkcli.ts),
 * which signs in, uploads reference files and saves results on its own.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `--flag value` for each setting that was given; one left out is the model's (or the signed-in profile's) default. */
export const flags = (settings: Record<string, string | number | boolean | undefined>): string[] =>
  Object.entries(settings).flatMap(([name, value]) => (value === undefined || value === "" ? [] : typeof value === "boolean" ? [`--${name}=${value}`] : [`--${name}`, String(value)]));

/** An image as arkcli takes it: a local file is `@<path>`, with the part it plays in front. */
export const input = (role: string, image: string): string[] => ["--input", `${role}:${/^[a-z][a-z0-9+.-]*:\/\//.test(image) ? image : `@${path.resolve(image)}`}`];

/** arkcli names the files it saves itself. It is given a directory of its own, and what it saved there is moved to where it was wanted. */
export async function saved(to: string, run: (dir: string) => Promise<{ local_path?: string }>): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-ark-"));
  try {
    const answer = await run(dir);
    if (!answer.local_path) throw new Error("arkcli saved no file");
    fs.mkdirSync(path.dirname(path.resolve(to)), { recursive: true });
    fs.copyFileSync(answer.local_path, to);
    return answer;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Never open a result in a window, never copy it into arkcli's gallery. */
export const QUIET = ["--no-open", "--no-gallery"];
