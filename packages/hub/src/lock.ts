/**
 * A lock on a file that the kernel holds for a process: taken in one step, and
 * gone the moment its holder is, however that ends. Nothing is left behind to
 * be judged stale, so there is no process id to probe and no lock to take over.
 *
 * Node has no flock of its own. The one file lock its standard library
 * reaches is SQLite's: an exclusive transaction on a database locks its file
 * (fcntl locks on POSIX, LockFileEx on Windows). The database stays empty; it
 * is the lock, and nothing else.
 */
import fs from "node:fs";
import { createRequire } from "node:module";

// Load SQLite only when taking or probing an existing lock; Node 22 warns on loading it.
const require = createRequire(import.meta.url);
const sqlite = (): typeof import("node:sqlite") => require("node:sqlite");

/** SQLite's "the file is locked by another connection". */
const isBusy = (e: unknown): boolean => (e as { errcode?: number }).errcode === 5;

/**
 * Take the lock, waiting up to `waitMs` for it: a look at it (`isLocked`) holds it off for a moment, a holder that
 * is on its way out for a little longer. Answers how to give it back, or null when another process still holds it.
 */
export function lockFile(file: string, waitMs: number): (() => void) | null {
  const db = new (sqlite().DatabaseSync)(file, { timeout: waitMs });
  try {
    db.exec("BEGIN EXCLUSIVE");
    return () => db.close();
  } catch (e) {
    db.close();
    if (isBusy(e)) return null;
    throw e;
  }
}

/** Whether a process holds the lock right now. */
export function isLocked(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const db = new (sqlite().DatabaseSync)(file, { timeout: 0, readOnly: true });
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get(); // reading needs the file shared, which its holder refuses
    return false;
  } catch (e) {
    if (isBusy(e)) return true;
    throw e;
  } finally {
    db.close();
  }
}
