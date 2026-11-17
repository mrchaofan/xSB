/** Normalize the addresses accepted by both the address bar and browser tools. */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i;

/** An address that cannot be opened: the user's to correct, in the words of whoever shows it. */
export class BadAddress extends Error {}

export function address(given: string): string {
  const text = given.trim();
  if (!text) throw new BadAddress("an address is required");
  if (path.isAbsolute(text)) return pathToFileURL(text).href;
  const hostPort = /^[^/:]+\.[^/:]+:\d+(?:[/?#]|$)/.test(text);
  const explicit = /^[a-z][a-z0-9+.-]*:/i.test(text) && !LOCAL.test(text) && !hostPort;
  let url: URL;
  try {
    url = new URL(explicit ? text : `${LOCAL.test(text) ? "http" : "https"}://${text}`);
    if (url.protocol === "file:") fileURLToPath(url); // reject malformed or non-local file URLs
  } catch (e) {
    throw new BadAddress(`${text} is not an address: ${(e as Error).message}`);
  }
  if (!["http:", "https:", "file:"].includes(url.protocol) || (url.protocol !== "file:" && !url.hostname)) {
    throw new BadAddress("only http, https and local files can be opened");
  }
  return url.href;
}
