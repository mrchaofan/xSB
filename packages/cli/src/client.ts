/** The CLI's ACP connection to the hub. The CLI is an ACP client like any other. */
import { hubSocket } from "@xsb/hub";
import type { Paths } from "@xsb/hub";
import { Agents, Connection, LanguageExt, PROTOCOL_VERSION } from "@xsb/protocol";
import pkg from "../package.json" with { type: "json" };
import { language } from "./text.ts";

export async function connectHub(paths: Paths, observer: boolean): Promise<Connection> {
  const socket = await hubSocket(paths);
  const conn = new Connection(socket, socket, "hub");
  await conn.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      _meta: { [LanguageExt.key]: language, ...(observer ? { [Agents.capability]: {} } : {}) },
    },
    clientInfo: { name: "xsb-cli", version: pkg.version },
  });
  return conn;
}
