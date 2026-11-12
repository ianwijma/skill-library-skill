import path from "node:path";
import pc from "picocolors";
import { listSkills } from "../core/list.ts";
import { CliError, formatError, sanitizeMetadata } from "../lib/cli.ts";
import { agentsDisplay, agentsLabel } from "./add.ts";
import { type Ctx, examples, jsonOnError, list, newCommand, warnUnknownOptions } from "./command.ts";
import type { GlobalOpts } from "./index.ts";

function shorten(p: string, cwd: string): string {
  const home = process.env.HOME ?? "";
  if (p.startsWith(cwd + path.sep)) return `.${p.slice(cwd.length)}`;
  if (home && p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
  return p;
}

export interface ListOptions {
  global?: boolean;
  json?: boolean;
  agent?: string[];
}

export async function runList(opts: ListOptions, g: GlobalOpts): Promise<number> {
  const json = !!opts.json;
  let result;
  try {
    result = await listSkills({ cwd: g.cwd, ...(g.store ? { store: g.store } : {}), global: !!opts.global, ...(opts.agent ? { agents: opts.agent } : {}) });
  } catch (err) {
    if (err instanceof CliError) {
      // vercel prints the invalid-agents diagnostic on stdout; runtime errors go to stderr.
      if (err.exitCode === 1 && !json) console.log(formatError(err));
      else console.error(json ? formatError(err) : `Error: ${formatError(err)}`);
      if (json) console.log("[]");
      return err.exitCode;
    }
    throw err;
  }
  if (json) {
    const rows = result.skills.map((s) => ({
      name: s.name,
      path: s.dir,
      scope: s.scope,
      agents: s.status === "untracked" ? [] : agentsDisplay(s.agents),
      source: s.source,
      sourceUrl: s.sourceType === "git" ? s.source : null,
      sourceType: s.sourceType,
      status: s.status === "installed" ? "tracked" : s.status,
      id: s.id,
    }));
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  const label = result.scope === "global" ? "Global" : "Project";
  const installed = result.skills.filter((s) => s.status !== "missing");
  const missing = result.skills.filter((s) => s.status === "missing");
  if (result.skills.length === 0) {
    console.log(pc.gray(`No ${label.toLowerCase()} skills found.`));
    console.log(pc.gray(result.scope === "global" ? "Try listing project skills without -g" : "Try listing global skills with -g"));
    return 0;
  }
  console.log(pc.bold(`${label} Skills`));
  console.log();
  const nameW = Math.max(...installed.map((s) => sanitizeMetadata(s.name).length), 0);
  for (const s of installed) {
    const tag = s.status === "untracked" ? ` ${pc.yellow("(not global)")}` : "";
    console.log(`${pc.cyan(sanitizeMetadata(s.name).padEnd(nameW))} ${pc.gray(s.dir ? shorten(s.dir, g.cwd) : "")}${tag}`);
    console.log(`  ${pc.gray("Agents:")} ${agentsLabel(s.agents)}  ${pc.gray("Source:")} ${sanitizeMetadata(s.source)}`);
  }
  console.log();
  if (missing.length > 0) {
    console.log(`${pc.bold("Missing")} ${pc.gray("(in skill-library.json, not installed — run skill-library install)")}`);
    for (const s of missing) console.log(`  ${pc.cyan(sanitizeMetadata(s.name))}  ${pc.gray("Source:")} ${sanitizeMetadata(s.source)}`);
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
