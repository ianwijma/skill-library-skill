// `init`, following vercel-labs/skills v1.7.6 src/cli.ts runInit (MIT).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import pc from "picocolors";
import { showLogo } from "./ui.ts";
import { type Ctx, examples, newCommand, warnUnknownOptions } from "./command.ts";
import type { GlobalOpts } from "./index.ts";

export function runInit(name: string | undefined, opts: { always?: boolean }, g: GlobalOpts): number {
  showLogo();
  console.log();
  const always = !!opts.always;
  const cwd = g.cwd;
  const hasName = name !== undefined;
  const skillName = name || basename(cwd);
  const skillDir = hasName ? join(cwd, skillName) : cwd;
  const skillFile = join(skillDir, "SKILL.md");
  const displayPath = hasName ? `${skillName}/SKILL.md` : "SKILL.md";
  if (existsSync(skillFile)) {
    console.log(`Skill already exists at ${pc.gray(displayPath)}`);
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
  console.log(`Initialized skill: ${pc.gray(skillName)}`);
  console.log();
  console.log(pc.gray("Created:"));
  console.log(`  ${displayPath}`);
  console.log();
  console.log(pc.gray("Next steps:"));
  console.log(`  1. Edit ${displayPath} to define your skill instructions`);
  console.log("  2. Update the name and description in the frontmatter");
  if (always) console.log(`  ${pc.gray("metadata.always: true — every query returns this skill, without scoring")}`);
  console.log();
  console.log(pc.gray("Publishing:"));
  console.log(`  ${pc.gray("GitHub:")}  Push to a repo, then skill-library add <owner>/<repo>`);
  console.log(`  ${pc.gray("Local:")}   skill-library add ./${hasName ? skillName : "."}`);
  console.log();
  console.log("Browse existing skills for inspiration at https://skills.sh/");
  console.log();
  return 0;
}

export function initCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("init"))
    .summary("Create a new skill")
    .description("Create a skill: <name>/SKILL.md, or ./SKILL.md without a name.")
    .argument("[name]", "The skill's name (default: this folder's name)")
    .option("--always", "Every query returns this skill, without scoring")
    .addHelpText("after", examples([["skill-library init my-skill"], ["skill-library init house-rules --always", "always returned by query"]]))
    .action((name, opts) => {
      ctx.done(runInit(name, opts, ctx.globals()));
    });
}
