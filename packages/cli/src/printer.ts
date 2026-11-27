/** Turns `session/update` notifications into terminal output. */
import { stripVTControlCharacters } from "node:util";
import { Discarded, OriginExt, conversationEntry, textOf } from "@xsb/protocol";
import type { OriginMeta, SessionUpdate } from "@xsb/protocol";
import { t } from "./text.ts";

const tty = process.stdout.isTTY;
const dim = (s: string): string => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string): string => (tty ? `\x1b[1m${s}\x1b[0m` : s);
/** Keep Markdown lines and indentation. Published text cannot move the terminal cursor or set its modes. */
const terminalText = (value: string): string =>
  stripVTControlCharacters(value).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

export class Printer {
  /** sessionId -> agent id, shown in front of output when several sessions are on screen. */
  readonly labels = new Map<string, string>();
  /** Tool calls by id, and what each is called. */
  private tools = new Map<string, string>();
  private publications = new Set<string>();
  showLabels = false;
  /** The stream that owns the current, unfinished line. */
  private open: string | null = null;

  line(text: string): void {
    this.endLine();
    process.stdout.write(text + "\n");
  }

  endLine(): void {
    if (this.open) process.stdout.write("\n");
    this.open = null;
  }

  private stream(key: string, prefix: string, text: string, style: (s: string) => string = (s) => s): void {
    if (this.open !== key) {
      this.endLine();
      process.stdout.write(prefix);
      this.open = key;
    }
    process.stdout.write(style(text));
  }

  update(sessionId: string, update: SessionUpdate): void {
    const who = this.labels.get(sessionId) ?? sessionId;
    const label = this.showLabels ? bold(`[${who}] `) : "";
    const body = update.content?.type === "text" ? (update.content.text as string) : `[${update.content?.type}]`;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.stream(`${sessionId}:message`, label, body);
      case "agent_thought_chunk":
        return this.stream(`${sessionId}:thought`, label + dim(t.thinking), body, dim);
      case "tool_call_update": {
        // ACP v2 reports a tool call as patches of one record: the first one that names it opens it.
        const title = update.title ?? update.name;
        if (title && !this.tools.has(update.toolCallId)) {
          this.tools.set(update.toolCallId, title);
          this.line(`${label}${dim(`  ⚙ ${title}`)}`);
        }
        if (update.status === "failed") this.line(`${label}${dim(`  ✗ ${t.toolFailed(this.tools.get(update.toolCallId) ?? update.toolCallId)}`)}`);
        return;
      }
      case "user_message_chunk": {
        const origin = update._meta?.[OriginExt.key] as OriginMeta | undefined;
        return this.line(`${label}${dim(`← ${from(origin)}${origin?.steered ? t.interjected : ""}: ${body}`)}`);
      }
      case "session_info_update": {
        const entry = conversationEntry(update, sessionId);
        if (entry) {
          const key = JSON.stringify([sessionId, entry.source.id, entry.id]);
          if (this.publications.has(key)) return;
          this.publications.add(key);
          const source = terminalText(entry.source.label).replace(/\s+/g, " ").trim();
          const markdown = terminalText(entry.markdown).replace(/\n$/, "");
          return this.line(`${label}${bold(`[${source}]`)}\n${markdown}`);
        }
        const discarded = update._meta?.[Discarded.key] as Discarded | undefined;
        if (discarded) this.line(`${label}${dim(`← ${from(discarded.origin)}${t.discarded}: ${textOf(discarded.content)}`)}`);
        return;
      }
    }
  }
}

function from(origin: OriginMeta | undefined): string {
  return origin?.kind === "agent" ? origin.agentId : origin?.kind === "system" ? "xsb" : t.user;
}
