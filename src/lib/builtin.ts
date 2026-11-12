// Built-in skills: bundled with the CLI, never written to disk. `query` scores them alongside the
// library's skills and the agent reads them with `skill-library show <name>`.
// find-skills is adapted from vercel-labs/skills skills/find-skills/SKILL.md (MIT).
import findSkills from "../../assets/builtin/find-skills.md";
import { parseFrontmatter } from "./frontmatter.ts";

export interface BuiltinSkill {
  name: string;
  description: string;
  /** The full SKILL.md text. */
  content: string;
}

function fromMarkdown(content: string): BuiltinSkill {
  const { data } = parseFrontmatter(content);
  if (typeof data.name !== "string" || typeof data.description !== "string") throw new Error("built-in skill without name/description");
  return { name: data.name, description: data.description, content };
}

const BUILTINS: readonly BuiltinSkill[] = [fromMarkdown(findSkills)];

export function builtinSkills(): readonly BuiltinSkill[] {
  return BUILTINS;
}

export function builtinSkill(name: string): BuiltinSkill | undefined {
  return BUILTINS.find((s) => s.name === name);
}

/** What the agent runs to read a built-in skill (printed by `query` in place of a path). */
export function builtinCommand(name: string): string {
  return `skill-library show ${name}`;
}
