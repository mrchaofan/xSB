import { RpcError } from "@xsb/protocol";
import type { ContentBlock } from "@xsb/protocol";
/** Apply the native skill positioning contract after Hub context assembly. */
export function skillPrompt(content: ContentBlock[], caps: { skill?: boolean; inlineSkill?: boolean }): ContentBlock[] {
  const skills = content.filter(b => b.type === "skill");
  if (!skills.length) return content;
  if (!caps.skill) throw RpcError.invalidParams("This agent does not support native skill references");
  if (caps.inlineSkill) return content;
  if (skills.length !== 1) throw RpcError.invalidParams("This agent accepts only one skill reference per prompt");
  return [skills[0], ...content.filter(b => b.type !== "skill")];
}
