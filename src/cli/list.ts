import path from "node:path";
import pc from "picocolors";
import { listSkills } from "../core/list.ts";
import { CliError, formatError, sanitizeMetadata } from "../lib/cli.ts";
import { agentsDisplay, agentsLabel } from "./add.ts";
import { type Ctx, examples, jsonOnError, list, newCommand, warnUnknownOptions } from "./command.ts";
import type { GlobalOpts } from "./index.ts";

function shorten(filePath: string, cwd: string): string {
  const home = process.env.HOME ?? "";

  if (filePath.startsWith(cwd + path.sep)) {
    return `.${filePath.slice(cwd.length)}`;
  }

  if (home && filePath.startsWith(home + path.sep)) {
    return `~${filePath.slice(home.length)}`;
  }

  return filePath;
}

interface ListOptions {
  global?: boolean;
  json?: boolean;
  agent?: string[];
}

async function runList(opts: ListOptions, globalOpts: GlobalOpts): Promise<number> {
  const json = !!opts.json;
  let result;

  try {
    result = await listSkills({
      cwd: globalOpts.cwd,
      ...(globalOpts.store ? { store: globalOpts.store } : {}),
      global: !!opts.global,
      ...(opts.agent ? { agents: opts.agent } : {}),
    });
  } catch (err) {
    if (err instanceof CliError) {
      // vercel prints the invalid-agents diagnostic on stdout; runtime errors go to stderr.
      if (err.exitCode === 1 && !json) {
        console.log(formatError(err));
      } else {
        console.error(json ? formatError(err) : `Error: ${formatError(err)}`);
      }

      if (json) {
        console.log("[]");
      }

      return err.exitCode;
    }

    throw err;
  }

  if (json) {
    const rows = result.skills.map((skill) => ({
      name: skill.name,
      path: skill.dir,
      scope: skill.scope,
      agents: skill.status === "untracked" ? [] : agentsDisplay(skill.agents),
      source: skill.source,
      sourceUrl: skill.sourceType === "git" ? skill.source : null,
      sourceType: skill.sourceType,
      status: skill.status === "installed" ? "tracked" : skill.status,
      id: skill.id,
    }));

    console.log(JSON.stringify(rows, null, 2));

    return 0;
  }

  const label = result.scope === "global" ? "Global" : "Project";
  const installed = result.skills.filter((skill) => skill.status !== "missing");
  const missing = result.skills.filter((skill) => skill.status === "missing");

  if (result.skills.length === 0) {
    console.log(pc.gray(`No ${label.toLowerCase()} skills found.`));
    console.log(pc.gray(result.scope === "global" ? "Try listing project skills without -g" : "Try listing global skills with -g"));

    return 0;
  }

  console.log(pc.bold(`${label} Skills`));
  console.log();
  const nameW = Math.max(...installed.map((skill) => sanitizeMetadata(skill.name).length), 0);

  for (const skill of installed) {
    const tag = skill.status === "untracked" ? ` ${pc.yellow("(not global)")}` : "";

    console.log(`${pc.cyan(sanitizeMetadata(skill.name).padEnd(nameW))} ${pc.gray(skill.dir ? shorten(skill.dir, globalOpts.cwd) : "")}${tag}`);
    console.log(`  ${pc.gray("Agents:")} ${agentsLabel(skill.agents)}  ${pc.gray("Source:")} ${sanitizeMetadata(skill.source)}`);
  }

  console.log();

  if (missing.length > 0) {
    console.log(`${pc.bold("Missing")} ${pc.gray("(in skill-library.json, not installed — run skill-library install)")}`);

    for (const skill of missing) {
      console.log(`  ${pc.cyan(sanitizeMetadata(skill.name))}  ${pc.gray("Source:")} ${sanitizeMetadata(skill.source)}`);
    }

    console.log();
  }

  return 0;
}

export function listCommand(ctx: Ctx) {
  return jsonOnError(warnUnknownOptions(newCommand("list")), ctx)
    .alias("ls")
    .summary("List skills")
    .description("List the project's skills (with a skill-library.json), or the whole library.")
    .option("-g, --global", "List the whole library (default: the project, if it has a skill-library.json)")
    .option("-a, --agent <agents...>", "Only skills for these agents", list)
    .option("--json", "Output as JSON (machine-readable, no ANSI codes)")
    .addHelpText("after", examples([["skill-library list", "project skills (global without skill-library.json)"], ["skill-library ls -g", "the whole library"], ["skill-library ls --json", "JSON output"]]))
    .action(async (opts) => {
      ctx.done(await runList(opts, ctx.globals()));
    });
}
