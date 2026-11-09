// `init`, following vercel-labs/skills v1.7.6 src/cli.ts runInit (MIT).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { DIM, RESET, TEXT } from "../lib/cli.ts";
import { parseFlags } from "./args.ts";
import { showLogo } from "./ui.ts";
import type { GlobalOpts } from "./index.ts";

export function runInit(args: string[], g: GlobalOpts): number {
  showLogo();
  console.log();
  const f = parseFlags(args, { booleans: { always: ["--always"] } });
  const always = f.booleans.has("always");
  const cwd = g.cwd;
  const name = f.positionals[0];
  const hasName = name !== undefined;
  const skillName = name || basename(cwd);
  const skillDir = hasName ? join(cwd, skillName) : cwd;
  const skillFile = join(skillDir, "SKILL.md");
  const displayPath = hasName ? `${skillName}/SKILL.md` : "SKILL.md";
  if (existsSync(skillFile)) {
    console.log(`${TEXT}Skill already exists at ${DIM}${displayPath}${RESET}`);
    return 0;
  }
  if (hasName) mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    skillFile,
    `---
name: ${stringifyYaml(skillName).trimEnd()}
description: A brief description of what this skill does
${always ? "metadata:\n  always: true\n" : ""}---

# ${skillName}

Instructions for the agent to follow when this skill is activated.

## When to use

Describe when this skill should be used.

## Instructions

1. First step
2. Second step
3. Additional steps as needed
`,
  );
  console.log(`${TEXT}Initialized skill: ${DIM}${skillName}${RESET}`);
  console.log();
  console.log(`${DIM}Created:${RESET}`);
  console.log(`  ${displayPath}`);
  console.log();
  console.log(`${DIM}Next steps:${RESET}`);
  console.log(`  1. Edit ${TEXT}${displayPath}${RESET} to define your skill instructions`);
  console.log(`  2. Update the ${TEXT}name${RESET} and ${TEXT}description${RESET} in the frontmatter`);
  if (always) console.log(`  ${DIM}metadata.always: true — every query returns this skill, without scoring${RESET}`);
  console.log();
  console.log(`${DIM}Publishing:${RESET}`);
  console.log(`  ${DIM}GitHub:${RESET}  Push to a repo, then ${TEXT}skill-library add <owner>/<repo>${RESET}`);
  console.log(`  ${DIM}Local:${RESET}   ${TEXT}skill-library add ./${hasName ? skillName : "."}${RESET}`);
  console.log();
  console.log(`Browse existing skills for inspiration at ${TEXT}https://skills.sh/${RESET}`);
  console.log();
  return 0;
}
