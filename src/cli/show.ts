import { builtinSkill, builtinSkills } from "../lib/builtin.ts";
import { CliError } from "../lib/cli.ts";
import { parseFlags } from "./args.ts";
import type { GlobalOpts } from "./index.ts";

/** `show <name>`: print a built-in skill's SKILL.md (built-ins are bundled, not on disk). */
export async function runShow(args: string[], _g: GlobalOpts): Promise<number> {
  const f = parseFlags(args, {});
  const names = builtinSkills().map((s) => s.name).join(", ");
  if (f.positionals.length !== 1) throw new CliError(1, `show takes one built-in skill name (${names})`);
  const name = f.positionals[0]!;
  const skill = builtinSkill(name);
  if (!skill) {
    throw new CliError(1, `'${name}' is not a built-in skill. Built-in skills: ${names}. Installed skills are files: read the path that skill-library query or skill-library list prints.`);
  }
  process.stdout.write(skill.content.endsWith("\n") ? skill.content : `${skill.content}\n`);
  return 0;
}
