/** Read-only runtime identity for tool services. No model prompts or task dispatch. */
export const ToolContext = {
  socketEnv: "XSB_TOOL_CONTEXT_SOCKET",
  tokenEnv: "XSB_TOOL_CONTEXT_TOKEN",
  attach: "_xsb/tool-context/attach",
  current: "_xsb/tool-context/current",
  changed: "_xsb/tool-context/changed",
};
export type TurnWindow = { id: string; startedAt: number; endedAt?: number };
export type ToolContextState = { agentId: string; sessionId: string; turnId: string | null; active: boolean; turns: TurnWindow[] };
