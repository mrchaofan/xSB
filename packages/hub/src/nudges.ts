/**
 * Nudges: words xsb says because nothing else would. Not the kernel's business; a hook on what the user says, posting
 * through the kernel like any other message.
 *
 *   carbon  the user writes to an agent that works on someone else's task: that someone is told, once for what is
 *           said within a short while, so that two people do not steer the same work apart.
 *
 * (A task left open at the end of its executor's turn needs no reminder: the turn's end ends it, kernel.ts.)
 */
import { isTerminal, textOf } from "@xsb/protocol";
import type { Addr, ContentBlock } from "@xsb/protocol";
import type { Hub } from "./hub.ts";

export class Nudges {
  private hub: Hub;
  /** How long what the user writes to one agent is gathered before its dispatchers are told, in one message. */
  ccDelayMs = 20_000;
  private ccs = new Map<string, { to: Addr; topic: string; titles: Set<string>; said: string[] }>();

  constructor(hub: Hub) {
    this.hub = hub;
  }

  /** The user wrote to an agent directly, past whoever gave it the work it has open. Only who the tasks came from is asked. */
  userWrote(agentId: string, prompt: ContentBlock[]): void {
    const line = textOf(prompt).trim().replace(/\s+/g, " ");
    if (!line) return;
    const open = [...this.hub.state.tasks.values()].filter((t) => !t.tool && t.from && t.to.agentId === agentId && t.from.agentId !== agentId && !isTerminal(t.status));
    for (const task of open) {
      const from = task.from!;
      const key = `${from.sessionId}|${agentId}`;
      let cc = this.ccs.get(key);
      if (!cc) {
        const gathered = (cc = { to: from, topic: task.topic, titles: new Set<string>(), said: [] as string[] });
        this.ccs.set(key, gathered);
        setTimeout(() => {
          this.ccs.delete(key);
          if (this.hub.stopping) return;
          const quoted = gathered.said.map((s) => `"${s.length > 300 ? `${s.slice(0, 300)}…` : s}"`).join("\n");
          const titles = [...gathered.titles].map((t) => `"${t}"`).join(", ");
          this.hub.kernel.tell(gathered.to, gathered.topic, `The user wrote directly to ${agentId}, which works on your task ${titles}:\n${quoted}\nIf this changes what you decided, settle it with the user and ${agentId}; otherwise nothing for you to do.`);
        }, this.ccDelayMs);
      }
      cc.titles.add(task.title);
      if (!cc.said.includes(line)) cc.said.push(line);
    }
  }
}
