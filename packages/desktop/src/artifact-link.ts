import path from "node:path";
import { fileURLToPath } from "node:url";

/** Markdown uses URL escapes and optional source-line suffixes for local files. */
export function artifactPath(href: string, baseDirectory: string): string {
  if (typeof href !== "string" || !href.trim()) throw new Error("a file path is required");
  const given = href.trim();
  let file: string;
  if (/^file:/i.test(given)) {
    const url = new URL(given);
    url.hash = "";
    url.search = "";
    file = fileURLToPath(url);
  } else if (/^xsb-artifact:/i.test(given)) {
    const url = new URL(given);
    if (url.hostname !== "file") throw new Error("invalid artifact address");
    file = decodeURIComponent(url.pathname.slice(1));
  } else {
    if (given.startsWith("//") || (!path.isAbsolute(given) && /^[a-z][a-z0-9+.-]*:/i.test(given))) throw new Error("only local files can be previewed");
    file = decodeURIComponent(given.split(/[?#]/, 1)[0]);
  }
  file = file.replace(/:\d+(?::\d+)?$/, "");
  if (!file || file.includes("\0")) throw new Error("invalid file path");
  return path.resolve(baseDirectory, file);
}
