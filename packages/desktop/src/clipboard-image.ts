import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Content } from "./content.ts";
import { imageMimeType, isImageFileName } from "./image.ts";

/** Only whole local image paths are attachments; ordinary text, URLs and prompts stay text. */
export function imagesFromPaths(text: string, convert: (file: string) => Buffer): Content | null {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  const files: string[] = [];
  for (let line of lines) {
    if ((line.startsWith('"') && line.endsWith('"')) || (line.startsWith("'") && line.endsWith("'"))) line = line.slice(1, -1);
    try {
      if (line.startsWith("file:")) line = fileURLToPath(line);
      else if (line.startsWith("~/")) line = path.join(os.homedir(), line.slice(2));
    } catch { return null; }
    if (!path.isAbsolute(line) || !isImageFileName(line)) return null;
    files.push(line);
  }
  return files.map((file) => {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Image file not found: ${file}`);
    let bytes: Buffer = fs.readFileSync(file);
    let mimeType = imageMimeType(bytes);
    if (!mimeType) {
      bytes = convert(file);
      mimeType = imageMimeType(bytes);
      if (!mimeType) throw new Error(`Could not read image: ${file}`);
    }
    return { type: "image", mimeType, data: bytes.toString("base64") };
  });
}
