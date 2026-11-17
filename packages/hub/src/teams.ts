/**
 * Preset teams: sets of roles xsb ships for a kind of work (software
 * development, film production). A team is a directory, once per language:
 *
 *   presets/<language>/<team>/team.json      { title, description, roles: [{ role, name, requires? }], assets }: which
 *                                            roles, in order, what to call an agent of each, the programs of the
 *                                            machine a role works with (`requires`: [{ command, install }], where
 *                                            `install` tells the user how to get it; xsb installs nothing), and
 *                                            what to call each asset type the team makes (`assets`: type -> name), the ones its
 *                                            skills register on the way included
 *   presets/<language>/<team>/roles/<role>/  a role, exactly as a project has it in .xsb/roles/
 *
 * The languages differ in their words only: the same teams, roles, skills,
 * contracts and tools in each (the tests hold them to it). Which one is read
 * is the project's language.
 *
 * A project uses a team by naming it in its config (`teams`). Nothing is
 * copied: the team's roles are then among the project's (roles.ts looks them
 * up here), so a newer xsb brings newer roles to every project that uses them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Language } from "@xsb/protocol";

/** Next to the code, in the sources and in a bundle alike (as the hub's programs are, see daemon.ts). */
const PRESETS = fileURLToPath(new URL("../presets/", import.meta.url));

export type Team = {
  id: string;
  title: string;
  description: string;
  roles: { role: string; name: string; requires?: { command: string; install: string }[] }[];
  assets?: Record<string, string>;
};

export function teams(language: Language): Team[] {
  const dir = path.join(PRESETS, language);
  return fs
    .readdirSync(dir)
    .filter((id) => fs.existsSync(path.join(dir, id, "team.json")))
    .map((id) => ({ id, ...JSON.parse(fs.readFileSync(path.join(dir, id, "team.json"), "utf8")) }));
}

/** Where a team's roles are. */
export const teamRoles = (id: string, language: Language): string => path.join(PRESETS, language, id, "roles");
