/** Observe the owning Agent's turn boundaries. This channel never prompts a model. */
import net from "node:net";
import { Connection, ToolContext } from "@xsb/protocol";
import type { ToolContextState } from "@xsb/protocol";

export interface BrowserContextSource {
  snapshot(): Promise<ToolContextState>;
  watch(listener: (state: ToolContextState) => void): () => void;
  close(): void;
}

export class BrowserContext implements BrowserContextSource {
  private socketPath: string;
  private token: string;
  private conn?: Connection;
  private connecting?: Promise<Connection>;
  private listeners = new Set<(state: ToolContextState) => void>();
  private retry?: NodeJS.Timeout;
  private closed = false;
  private revoked = false;

  constructor(socketPath: string, token: string) { this.socketPath = socketPath; this.token = token; }
  private publish(state: ToolContextState): void { for (const listener of this.listeners) listener(state); }

  private async request(conn: Connection, method: string, params?: unknown): Promise<ToolContextState> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { conn.close(); reject(new Error("browser turn context timed out")); }, 3000);
    });
    try { return await Promise.race([conn.request(method, params), timeout]); }
    finally { clearTimeout(timer!); }
  }

  private async connection(): Promise<Connection> {
    if (this.closed || this.revoked) throw new Error("browser turn context is closed or revoked");
    if (this.conn && !this.conn.isClosed) return this.conn;
    if (!this.connecting) this.connecting = (async () => {
      const socket = net.connect(this.socketPath);
      const conn = new Connection(socket, socket, "tool-context");
      conn.onNotification(ToolContext.changed, (state) => this.publish(state));
      try {
        const state = await this.request(conn, ToolContext.attach, { token: this.token });
        if (this.closed) throw new Error("browser turn context closed");
        this.conn = conn;
        this.publish(state);
        void conn.closed.then(() => this.reconnect());
        return conn;
      } catch (e: any) {
        this.revoked = e?.code === -32602;
        conn.close();
        throw e;
      }
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private reconnect(): void {
    if (this.closed || this.revoked || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.connection().catch(() => this.reconnect());
    }, 1000).unref();
  }

  async snapshot(): Promise<ToolContextState> {
    const state = await this.request(await this.connection(), ToolContext.current);
    this.publish(state);
    return state;
  }

  watch(listener: (state: ToolContextState) => void): () => void {
    this.listeners.add(listener);
    void this.connection().catch(() => this.reconnect());
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.conn?.close();
    this.listeners.clear();
  }
}
