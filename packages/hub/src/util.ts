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
