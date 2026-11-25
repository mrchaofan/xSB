import { randomBytes } from "node:crypto";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

/**
 * Variables of the environment that xSB does not hand down to what it starts. `NODE_OPTIONS` would be loaded into
 * every program that runs on Node or on Electron as Node (the hub, its MCP bridges and plugins, the agents' ACP
 * wrappers) and into the agents' own programs, whatever the user set it for.
 */
export const WITHHELD_ENV = ["NODE_OPTIONS"] as const;

/** `env` without the withheld variables (`WITHHELD_ENV`), changed in place. */
export function withhold<T extends Record<string, string | undefined>>(env: T): T {
  for (const name of WITHHELD_ENV) delete env[name];
  return env;
}

export const now = (): string => new Date().toISOString();

export const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A turn nobody awaits (a peer message, a detached steer) must not crash the hub.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * What changed from one text to another, line by line: the lines taken out ("- ") and put in ("+ "), each run of
 * them under the number of the line it starts at in the new text ("@@ line n"). Undefined when it would be longer
 * than `limit` characters, or the texts are too long to compare (the whole new text is better then).
 */
export function lineDiff(before: string, after: string, limit = 4000): string | undefined {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) return undefined;
  // Longest common subsequence, from the end: lcs[i][j] is that of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  let open = false;
  const mark = (): void => {
    if (!open) out.push(`@@ line ${j + 1}`);
    open = true;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      open = false;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      mark();
      out.push(`+ ${b[j++]}`);
    } else {
      mark();
      out.push(`- ${a[i++]}`);
    }
  }
  const text = out.join("\n");
  return text.length <= limit ? text : undefined;
}
