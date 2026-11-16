import { randomBytes } from "node:crypto";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

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
