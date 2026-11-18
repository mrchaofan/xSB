/**
 * An agent that does not speak ACP, wrapped with @xsb/adapter: the hub runs it
 * as it runs any backend. It has no steering (the wrapper holds what comes
 * while it works) and cannot resume (the hub hands its sessions over). It answers every prompt with what it heard; "wait <ms>"
 * in a prompt makes it take that long (a cancel ends the wait).
 */
import { serveAdapter } from "@xsb/adapter";
import type { AgentAdapter } from "@xsb/adapter";
import { textOf } from "@xsb/protocol";

const sessions = new Map<string, { instructed: boolean; stop?: () => void }>();

const adapter: AgentAdapter = {
  info: { name: "third-party", version: "0" },
  capabilities: { resume: false, systemPrompt: true, steering: false },

  async newSession({ systemPrompt }) {
    const id = `tp_${sessions.size + 1}`;
    sessions.set(id, { instructed: !!systemPrompt?.includes("You are e.") });
    return id;
  },

  async prompt(id, prompt, emit) {
    const session = sessions.get(id)!;
    const heard = textOf(prompt);
    const wait = /wait (\d+)/.exec(heard);
    let cancelled = false;
    if (wait) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Number(wait[1]));
        session.stop = () => {
          cancelled = true;
          clearTimeout(timer);
          resolve();
        };
      });
    }
    if (cancelled) return "cancelled";
    const text = `third party (${session.instructed ? "instructed" : "bare"}) heard: ${heard}\n`;
    emit({ sessionUpdate: "agent_message_chunk", messageId: `${id}_${Date.now()}`, content: { type: "text", text } });
    return "end_turn";
  },

  cancel(id) {
    sessions.get(id)?.stop?.();
  },
};

serveAdapter(adapter);
