/**
 * What an agent without an ACP entry point has to provide.
 *
 * `serveAdapter` (serve.ts) turns an implementation of this into "a command
 * that speaks ACP on stdio", which is the only thing xsb knows a backend to
 * be. What differs between such agents belongs in the implementation and its
 * configuration; nothing upstream of it changes.
 */
import type { ContentBlock, McpServer, SessionUpdate, StopReason } from "@xsb/protocol";

export type AdapterSession = {
  cwd: string;
  /** Tools the agent must be able to reach, among them xsb's collaboration tools. */
  mcpServers: McpServer[];
  /** Standing instructions. Only given when the adapter reports `systemPrompt`. */
  systemPrompt?: string;
};

export type AdapterCapabilities = {
  /** `resume` can bring a session back after the process restarted. */
  resume: boolean;
  /** `systemPrompt` of a session is honoured. */
  systemPrompt: boolean;
  /** `steer` is implemented. */
  steering: boolean;
};

export interface AgentAdapter {
  readonly info: { name: string; version: string };
  readonly capabilities: AdapterCapabilities;

  /** Start a conversation. Returns its id. */
  newSession(session: AdapterSession): Promise<string>;

  /** Reopen a conversation by id. Only called when `capabilities.resume`. */
  resume?(sessionId: string, session: AdapterSession): Promise<void>;

  /**
   * Run one turn. Everything the agent says or does is reported through
   * `emit` as ACP session updates; the promise settles when the turn ends.
   */
  prompt(sessionId: string, prompt: ContentBlock[], emit: (update: SessionUpdate) => void): Promise<StopReason>;

  /** Stop the running turn; `prompt` then settles with "cancelled". */
  cancel(sessionId: string): void;

  /**
   * Put a message into the running turn. Returns false when it could not.
   * Only called while a turn runs and when `capabilities.steering`.
   */
  steer?(sessionId: string, prompt: ContentBlock[]): Promise<boolean>;
}
