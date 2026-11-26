/** Projection of ACP display-only terminals into their referring tool cards. */
import type { SessionUpdate } from "@xsb/protocol";
export class TerminalViews {
  private values = new Map<string, { text: string; decoder: TextDecoder }>();
  private tools = new Map<string, Set<string>>();
  private readers = new Map<string, Set<string>>();
  attach(tool: string, sessionId: string, content: unknown): string | undefined {
    if (Array.isArray(content)) for (const ref of content) if (ref?.type === "terminal" && typeof ref.terminalId === "string") {
      const key = `${sessionId}:${ref.terminalId}`;
      const refs = this.tools.get(tool) ?? new Set(); refs.add(key); this.tools.set(tool, refs);
      const readers = this.readers.get(key) ?? new Set(); readers.add(tool); this.readers.set(key, readers);
    }
    return this.read(tool);
  }
  read(tool: string): string | undefined {
    const values = [...(this.tools.get(tool) ?? [])].flatMap(key => this.values.has(key) ? [this.values.get(key)!.text] : []);
    return values.length ? values.join("\n") : undefined;
  }
  update(sessionId: string, update: SessionUpdate): string[] {
    const key = `${sessionId}:${update.terminalId}`;
    const value = this.values.get(key) ?? { text: "", decoder: new TextDecoder() };
    if (update.sessionUpdate === "terminal_update" && typeof update.output?.data === "string") {
      value.decoder = new TextDecoder(); value.text = value.decoder.decode(Buffer.from(update.output.data, "base64"), { stream: true });
    } else if (update.sessionUpdate === "terminal_output_chunk" && typeof update.data === "string") value.text += value.decoder.decode(Buffer.from(update.data, "base64"), { stream: true });
    if (update.exitStatus) value.text += value.decoder.decode();
    this.values.set(key, value);
    return [...(this.readers.get(key) ?? [])];
  }
  refers(tool: string, sessionId: string, terminalId: string): boolean { return this.tools.get(tool)?.has(`${sessionId}:${terminalId}`) ?? false; }
}
