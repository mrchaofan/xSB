export const Workflow = {
  get: "_dev.xsb/workflow/get",
  list: "_dev.xsb/workflow/list",
  update: "_dev.xsb/workflow/update",
  pause: "_dev.xsb/workflow/pause",
  resume: "_dev.xsb/workflow/resume",
  backend: "dev.xsb/backend",
  target: "dev.xsb/workflow-target",
} as const;

export type AssetRef = { name: string; version: string };
export type NodeDef = {
  node: string;
  kind: "task" | "end";
  prompt?: string;
  input: Record<string, unknown>;
  model?: string;
  schema?: object;
  multi: boolean;
};
export type Edge = { from: string; to: string; case?: string };
export type WorkflowGraph = { nodes: NodeDef[]; edges: Edge[] };
/** A node as a view shows it: its definition's name and kind, where its work stands, and who did it. */
export type WorkflowNodeView = {
  name: string;
  kind: NodeDef["kind"];
  status: string;
  paused: boolean;
  /** The user's interruption of it got to its agent and is not handled yet (its turn failed or stopped): it holds the node until resumed. */
  interrupted?: boolean;
  agentId?: string;
  sessionId?: string;
  target?: string;
  summary?: string;
  additionalResults?: { id: string; summary: string }[];
  controls?: { pause: boolean; resume: boolean };
};

/**
 * A version that was active and was replaced: its graph and its nodes as they stood then. Kept to be looked at;
 * the conversations of its nodes can be read, not continued.
 */
export type WorkflowHistory = { version: string; retiredAt: string; nodes: WorkflowNodeView[]; edges: Edge[] };

export type WorkflowView = {
  /** Authoritative runtime state and actions; clients need not infer them from node labels. */
  state?: "empty" | "proposed" | "running" | "paused" | "completed";
  controls?: { pause: boolean; resume: boolean };
  /** Earlier active versions, the latest first. */
  history?: WorkflowHistory[];
  sessionId: string;
  version?: string;
  candidate?: { version: string; graph: WorkflowGraph };
  edges: Edge[];
  paused: boolean;
  /** An interruption from the main conversation holds the whole graph until it is handled, or the workflow resumed. */
  interrupted?: boolean;
  error?: string;
  nodes: WorkflowNodeView[];
};
