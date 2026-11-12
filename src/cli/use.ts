// `use`, following vercel-labs/skills v1.7.6 src/use.ts (MIT): generate a prompt for one
// skill without adding it; with -a, start that agent with the prompt.
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentIds, displayName } from "../lib/agents.ts";
import { CliError, formatError } from "../lib/cli.ts";
import { discoverSkills, filterSkills, type DiscoveredSkill } from "../lib/discover.ts";
import { cleanup, cloneRepo } from "../lib/git.ts";
import { parseSource } from "../lib/source.ts";
import { copySkill } from "../lib/store.ts";
import { safeSlug } from "../lib/ids.ts";
import type { GlobalOpts } from "./index.ts";

const USE_AGENTS: Record<string, { command: string; args: string[] }> = {
  "claude-code": { command: "claude", args: [] },
  codex: { command: "codex", args: [] },
  "sarvam-code": { command: "sarvam-code", args: [] },
};

export function buildUsePrompt(input: { skillMd: string; supportDir?: string; hasSupportingFiles: boolean }): string {
  const sections = [
    "You are being given a Skill to execute for the user's next request.",
    "Use the following SKILL.md as your instructions:",
    `<SKILL.md>\n${input.skillMd}\n</SKILL.md>`,
  ];
  if (input.hasSupportingFiles && input.supportDir) {
    sections.push(`Supporting files for this skill were downloaded to:\n${input.supportDir}\n\nWhen the SKILL.md references relative paths, read them from that directory.`);
  }
  return sections.join("\n\n") + "\n";
}

/** The agents `use --agent` can start. */
export const USE_AGENT_IDS = Object.keys(USE_AGENTS);

async function hasSupportingFiles(dir: string): Promise<boolean> {
  const entries = await fsp.readdir(dir, { withFileTypes: true, recursive: true });
  return entries.some((e) => e.isFile() && !(e.name.toLowerCase() === "skill.md" && path.resolve(e.parentPath ?? dir) === path.resolve(dir)));
}

export interface UseOptions {
  fullDepth?: boolean;
  skill?: string;
  /** A list so that `-a one two` can be rejected with a clear message. */
  agent?: string[];
}

/** `use <source>[@<skill>]`: `sources` are the positionals (exactly one is allowed). */
export async function runUse(sources: string[], opts: UseOptions, g: GlobalOpts): Promise<number> {
  const errors: string[] = [];
  const agentVals = opts.agent;
  if (agentVals) {
    if (agentVals.includes("*")) errors.push("skill-library use --agent does not support '*'; specify exactly one agent.");
    if (agentVals.length > 1) errors.push("skill-library use --agent accepts exactly one agent.");
    const invalid = agentVals.filter((a) => a !== "*" && !agentIds().includes(a));
    if (invalid.length > 0) errors.push(`Invalid agents: ${invalid.join(", ")}\nValid agents: ${agentIds().join(", ")}`);
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    return 1;
  }
  if (sources.length === 0) {
    console.error("Missing required argument: source\nRun skill-library use --help for usage.");
    return 1;
  }
  if (sources.length > 1) {
    console.error(`Expected one source, received ${sources.length}: ${sources.join(", ")}`);
    return 1;
  }
  const agent = agentVals?.[0];
  if (agent && !USE_AGENTS[agent]) {
    console.error(`Running ${displayName(agent)} is not supported yet.\nSupported agents for skill-library use --agent: ${Object.keys(USE_AGENTS).join(", ")}`);
    return 1;
  }

  const source = sources[0]!;
  let clone: string | null = null;
  try {
    const parsed = parseSource(source, g.cwd);
    const fromOption = opts.skill;
    if (parsed.skillFilter && fromOption && parsed.skillFilter.toLowerCase() !== fromOption.toLowerCase()) {
      throw new CliError(1, `Conflicting skill selectors: source selects "${parsed.skillFilter}" but --skill selects "${fromOption}". Provide one selector.`);
    }
    const selector = fromOption ?? parsed.skillFilter;
    let base: string;
    if (parsed.type === "git") {
      const c = await cloneRepo(parsed.url, parsed.ref);
      clone = c.dir;
      base = c.dir;
    } else {
      try {
        await fsp.access(parsed.url);
      } catch {
        throw new CliError(1, `Local path does not exist: ${parsed.url}`);
      }
      base = parsed.url;
    }
    const { skills } = await discoverSkills(base, parsed.subpath, { fullDepth: !!opts.fullDepth, includeReserved: true });
    const chosen = select(skills, selector, source);
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "skill-library-use-"));
    const skillDir = path.join(tempRoot, safeSlug(chosen.name));
    await copySkill(chosen.path, skillDir, "folder");
    await cleanup(clone);
    clone = null;
    const skillMd = await fsp.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const support = await hasSupportingFiles(skillDir);
    if (!support) await cleanup(tempRoot);
    const prompt = buildUsePrompt({ skillMd, supportDir: skillDir, hasSupportingFiles: support });
    if (agent) return await launch(agent, prompt);
    process.stdout.write(prompt);
    return 0;
  } catch (err) {
    await cleanup(clone);
    console.error(formatError(err));
    return 1;
  }
}

function select(skills: DiscoveredSkill[], selector: string | undefined, source: string): DiscoveredSkill {
  if (skills.length === 0) throw new CliError(1, "No valid skills found. Skills require a SKILL.md with name and description.");
  if (!selector) {
    if (skills.length === 1) return skills[0]!;
    const names = skills.map((s) => s.name);
    throw new CliError(
      1,
      ["This source contains multiple skills. Specify exactly one skill:", ...names.map((n) => `  - ${n}`)].join("\n"),
      `Examples:\n  skill-library use ${source}@${names[0]}\n  skill-library use ${source} --skill ${names[0]}`,
    );
  }
  const hit = filterSkills(skills, [selector]);
  if (hit.length === 0) {
    throw new CliError(1, `No matching skill found for: ${selector}`, `Available skills:\n${skills.map((s) => `  - ${s.name}`).join("\n")}`);
  }
  if (hit.length > 1) throw new CliError(1, `Skill selector "${selector}" matched multiple skills.`);
  return hit[0]!;
}

function launch(agent: string, prompt: string): Promise<number> {
  const cfg = USE_AGENTS[agent]!;
  return new Promise((resolve) => {
    const child = spawn(cfg.command, [...cfg.args, prompt], { stdio: "inherit" });
    let settled = false;
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (err.code === "ENOENT") console.error(`Could not launch ${displayName(agent)}: command not found: ${cfg.command}`);
      else console.error(err.message);
      resolve(1);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    });
  });
}
