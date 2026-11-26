import type { NodeAgentConfig, WorkflowSkill } from "@xsb/protocol";
import { textTokens } from "./context.ts";

/** Bound the generated prefix and keep skill bodies out of it. Estimates use the shared planner. */
export const WORKFLOW_AGENT_LIMITS = { systemPromptTokens: 2048, skillIndexTokens: 1024, skillTokens: 8192, skills: 8 } as const;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim();

export function nodeAgent(value: unknown): NodeAgentConfig {
  if (!object(value) || Object.keys(value).some(k => !["systemPrompt", "skills"].includes(k))) throw Error("Expected agent configuration with systemPrompt and skills only");
  const result: NodeAgentConfig = {};
  if (value.systemPrompt !== undefined) {
    if (!nonempty(value.systemPrompt)) throw Error("Expected nonempty agent.systemPrompt");
    if (textTokens(value.systemPrompt) > WORKFLOW_AGENT_LIMITS.systemPromptTokens) throw Error("agent.systemPrompt exceeds 2048 estimated tokens; move procedures into skills");
    result.systemPrompt = value.systemPrompt;
  }
  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills) || value.skills.length > WORKFLOW_AGENT_LIMITS.skills) throw Error("agent.skills must be an array of at most 8 skills");
    const names = new Set<string>();
    result.skills = value.skills.map((skill): WorkflowSkill => {
      if (!object(skill) || Object.keys(skill).some(k => !["name", "description", "content"].includes(k)) ||
          !nonempty(skill.name) || !nonempty(skill.description) || !nonempty(skill.content)) throw Error("Each agent skill needs name, description and content");
      if (skill.name !== skill.name.trim() || /[\r\n]/.test(skill.name) || names.has(skill.name)) throw Error("Skill names must be unique, trimmed and single-line");
      names.add(skill.name);
      if (textTokens(skill.content) > WORKFLOW_AGENT_LIMITS.skillTokens) throw Error("Skill content exceeds 8192 estimated tokens");
      return { name: skill.name, description: skill.description, content: skill.content };
    });
    if (textTokens(skillIndex(result.skills)) > WORKFLOW_AGENT_LIMITS.skillIndexTokens) throw Error("Skill directory exceeds 1024 estimated tokens; shorten names and descriptions");
  }
  return result;
}

/** Deterministic names/descriptions only: content is retrieved through load_skill. */
export function skillIndex(skills: WorkflowSkill[]): string {
  return skills.map(({ name, description }) => JSON.stringify({ name, description })).join("\n");
}

export function agentInstructions(config: NodeAgentConfig | undefined): string {
  return [config?.systemPrompt && `# Task agent instructions\n${config.systemPrompt}`,
    config?.skills?.length && `# Assignment skills\nUse workflow load_skill({name}) to read a skill before applying it. These are fixed instructions for this task agent, not backend-native slash commands.\n${skillIndex(config.skills)}`]
    .filter(Boolean).join("\n\n");
}
