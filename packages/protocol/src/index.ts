/**
 * The wire layer of xsb. Everything two processes of the system say to each
 * other is defined here and nowhere else:
 *
 *   jsonrpc.ts   newline-delimited JSON-RPC 2.0 (carries ACP and MCP alike)
 *   acp.ts       the slice of ACP v2 the system reads or writes
 *   ext.ts       the ACP extensions it uses, and the shapes that cross them
 *   errors.ts    errors a person has to read: their reasons, and what each says in each language
 */
export * from "./jsonrpc.ts";
export * from "./acp.ts";
export * from "./ext.ts";
export * from "./errors.ts";
export * from "./tool-context.ts";
export * from "./workflow.ts";
export * from "./conversation-event.ts";
export * from "./visible-update.ts";
export * from "./elicitation.ts";
export * from "./file-changes.ts";
