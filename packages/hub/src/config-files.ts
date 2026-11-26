import fs from "node:fs";
import path from "node:path";
import { atomicWrite, ensureDirectory } from "@xsb/store";
import { lockFile } from "./lock.ts";

/** Every program writer, including first creation, shares this read/modify/publish lock. */
export function updateJsonFile<T>(file: string, read: () => T, change: (value: T) => T, validate: (value: T) => void): T {
  ensureDirectory(path.dirname(file));
  const release = lockFile(`${file}.lock`, 5000);
  if (!release) throw new Error(`Configuration is busy: ${file}`);
  try {
    const value = change(read());
    validate(value);
    atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
    atomicWrite(`${file}.last-good`, JSON.stringify(value) + "\n");
    return value;
  } finally { release(); }
}

export function lastGoodJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(`${file}.last-good`, "utf8")); } catch { return undefined; }
}
