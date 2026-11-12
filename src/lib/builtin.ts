// Built-in skills ship inside the skill-library package (assets/builtin, copied to dist/builtin by
// the build). `query` returns them like any other skill, with the path of their SKILL.md; they
// can't be removed or updated, and change only when skill-library itself is updated.
// find-skills is adapted from vercel-labs/skills skills/find-skills/SKILL.md (MIT).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.ts";

export interface BuiltinSkill {
  id: string;
  name: string;
  description: string;
  /** Absolute path of the skill folder inside the installed package. */
  dir: string;
}

/** dist/builtin next to the bundle; assets/builtin when running from src. */
function builtinRoot(): string | null {
  for (const rel of ["./builtin/", "../../assets/builtin/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(dir)) return dir;
  }
  return null;
}

let cache: readonly BuiltinSkill[] | undefined;

export function builtinSkills(): readonly BuiltinSkill[] {
  if (cache) return cache;
  const root = builtinRoot();
  const out: BuiltinSkill[] = [];
  if (root) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      let data: Record<string, unknown>;
      try {
        ({ data } = parseFrontmatter(readFileSync(path.join(dir, "SKILL.md"), "utf8")));
      } catch {
        continue;
      }
      if (typeof data.name !== "string" || typeof data.description !== "string") continue;
      out.push({ id: `builtin://${data.name}`, name: data.name, description: data.description, dir });
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  cache = out;
  return out;
}

export function isBuiltinName(name: string): boolean {
  return builtinSkills().some((s) => s.name === name || s.id === name);
}

/** The note `remove` and `update` print for a built-in skill. */
export function builtinNote(name: string): string {
  return `${name} is built into skill-library: it can't be removed or updated on its own, and updates with skill-library`;
}
