/** Shared admission and retrieval for content the hub puts in model context. Original data stays on disk. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { errorMessage } from "@xsb/protocol";
import type { ContentBlock } from "@xsb/protocol";
import { loadProjectConfig } from "./config.ts";
import type { Paths } from "./paths.ts";

export function contextOverflow(error: unknown): boolean {
  const kind = (error as { data?: { errorKind?: string } } | null)?.data?.errorKind;
  return kind === "context_length_exceeded" || kind === "prompt_too_long" ||
    /\bprompt is too long\b|\bcontext (?:window|length)(?: is)? (?:exceeded|too (?:long|large))\b|\bmaximum context length\b/i.test(errorMessage(error));
}

/** Conservative estimate, not a claim about the backend tokenizer. Images have a separate allowance. */
export const textTokens = (value: string): number => Math.ceil(Buffer.byteLength(value, "utf8") / 2);
export function contentTokens(content: ContentBlock[]): number {
  return content.reduce((sum, block) => sum + (block.type === "image" ? 8192 : block.type === "text" ? textTokens(block.text ?? "") : textTokens(JSON.stringify(block))), 0);
}

const positive = (value: unknown, fallback: number): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
export function contextPolicy(paths: Paths) {
  const limits = loadProjectConfig(paths).limits;
  return {
    promptTokens: positive(limits?.promptTokens, 32_000),
    outputTokens: positive(limits?.toolOutputTokens, 4000),
    reserveTokens: positive(limits?.contextReserveTokens, 8192),
    recoveryAttempts: typeof limits?.contextRecoveryAttempts === "number" && Number.isSafeInteger(limits.contextRecoveryAttempts) && limits.contextRecoveryAttempts >= 0 ? Math.min(limits.contextRecoveryAttempts, 3) : 1,
  };
}

/** Content-addressed, scoped to the receiving agent. Never overwrite or delete the original during compaction. */
export function contextRef(paths: Paths, agentId: string, value: string): { ref: string; file: string } {
  const ref = createHash("sha256").update(value).digest("hex");
  const dir = path.join(paths.dir, "agents", agentId, "context");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ref}.txt`);
  if (fs.existsSync(file)) return { ref, file };
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  // Windows cannot open/fsync a directory. The file itself is already flushed before the atomic rename.
  if (process.platform !== "win32") {
    const directory = fs.openSync(dir, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  return { ref, file };
}

/** A valid envelope even if the original was JSON; preserves both the opening and final result/receipt. */
export function boundedText(paths: Paths, agentId: string, value: string, tokens: number): string {
  if (textTokens(value) <= tokens) return value;
  const { ref } = contextRef(paths, agentId, value);
  // Two excerpts, each code unit can occupy six JSON bytes (e.g. a NUL escaped as \\u0000).
  const take = Math.max(0, Math.floor((tokens * 2 - 700) / 12));
  return JSON.stringify({ excerpt: value.slice(0, take), ending: take ? value.slice(-take) : "", context_ref: ref, total_chars: value.length,
    notice: "Excerpt only; the full content is preserved. Use read_context with this ref and offset to read the required details before relying on omitted content." });
}

/** Read a bounded UTF-8 page without loading the entire stored result. Offsets are bytes, not JS characters. */
export function readContext(paths: Paths, agentId: string, ref: string, offset = 0, bytes = 6000): string {
  if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error("Invalid context reference.");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 12000) throw new Error("Invalid page: offset >= 0, bytes between 1 and 12000.");
  const file = path.join(paths.dir, "agents", agentId, "context", `${ref}.txt`);
  const fd = fs.openSync(file, "r");
  try {
    const total = fs.fstatSync(fd).size;
    if (offset > total) throw new Error("Offset is past the end of the content.");
    const data = Buffer.alloc(Math.min(bytes + 4, total - offset));
    const count = fs.readSync(fd, data, 0, data.length, offset);
    if (count && (data[0] & 0xc0) === 0x80) throw new Error("Offset splits a UTF-8 character. Continue at next_offset from the previous page.");
    let end = Math.min(bytes, count);
    // Include the remainder of a code point at a page boundary. Sequential pages never lose UTF-8 bytes.
    while (end < count && (data[end] & 0xc0) === 0x80) end++;
    return JSON.stringify({ ref, offset, next_offset: offset + end, total_bytes: total, text: data.subarray(0, end).toString("utf8"), done: offset + end >= total });
  } finally { fs.closeSync(fd); }
}
