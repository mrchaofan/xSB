import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Flush directory entries on platforms that support it. */
export function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function ensureDirectory(dir: string): void {
  dir = path.resolve(dir);
  const first = fs.mkdirSync(dir, { recursive: true });
  if (!first) return;
  for (let current = dir;; current = path.dirname(current)) {
    syncDirectory(current);
    if (current === first) { syncDirectory(path.dirname(current)); break; }
  }
}

/** Publish a complete, durable file. Temporary names also isolate concurrent writes. */
export function atomicWrite(file: string, data: string | Buffer, mode = 0o600): void {
  ensureDirectory(path.dirname(file));
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", mode);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}
