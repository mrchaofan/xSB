import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact } from "./bridge.ts";

const PREVIEW_KINDS: Record<string, Artifact["kind"]> = {
  ".md": "markdown", ".markdown": "markdown", ".html": "html", ".htm": "html",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image",
  ".mp4": "video", ".webm": "video", ".mov": "video", ".m4v": "video",
};
const TEXT_EXTENSIONS = new Set((
  "txt log csv tsv json jsonl ndjson yaml yml xml toml ini env conf cfg properties lock " +
  "js jsx mjs cjs ts tsx mts cts py rb go rs java kt kts swift c h cc cpp hpp cs php sh zsh bash fish ps1 " +
  "css scss sass less sql lua vue svelte mdx tex bib rst diff patch gitignore gitattributes editorconfig"
).split(" "));
const TEXT_NAMES = new Set(["readme", "license", "licence", "changelog", "authors", "makefile", "dockerfile", "gemfile", "rakefile"]);

/** Only send formats the sidebar can display to its media, Markdown, HTML or source viewers. */
export function artifactKind(file: string): Artifact["kind"] {
  const name = path.basename(file).toLowerCase();
  const ext = path.extname(name);
  if (PREVIEW_KINDS[ext]) return PREVIEW_KINDS[ext];
  const suffix = (ext || name).replace(/^\./, "");
  return TEXT_EXTENSIONS.has(suffix) || TEXT_NAMES.has(name) ? "text" : "unsupported";
}

/** Markdown uses URL escapes and optional source-line suffixes for local files. */
export function artifactPath(href: string, baseDirectory: string): string {
  if (typeof href !== "string" || !href.trim()) throw new Error("a file path is required");
  const given = href.trim();
  let file: string;
  if (/^file:/i.test(given)) {
    const url = new URL(given);
    if (url.hostname) throw new Error("only local files can be previewed");
    url.hash = "";
    url.search = "";
    file = fileURLToPath(url);
  } else if (/^xsb-artifact:/i.test(given)) {
    const url = new URL(given);
    if (url.hostname !== "file") throw new Error("invalid artifact address");
    file = decodeURIComponent(url.pathname.slice(1));
  } else {
    file = decodeURIComponent(given.split(/[?#]/, 1)[0]);
    const sourceLine = /^[\w.+-]+\.[\w-]+:\d+(?::\d+)?$/.test(file);
    if (file.startsWith("//") || (!path.isAbsolute(file) && /^[a-z][a-z0-9+.-]*:/i.test(file) && !sourceLine)) throw new Error("only local files can be previewed");
  }
  file = file.replace(/:\d+(?::\d+)?$/, "");
  if (!file || file.includes("\0")) throw new Error("invalid file path");
  return path.resolve(baseDirectory, file);
}
