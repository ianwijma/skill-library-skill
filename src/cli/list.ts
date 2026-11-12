import path from "node:path";
import pc from "picocolors";
import { listSkills } from "../core/list.ts";
import { BOLD, CliError, DIM, RESET, YELLOW, formatError, sanitizeMetadata } from "../lib/cli.ts";
import { parseFlags } from "./args.ts";
import { agentsDisplay, agentsLabel } from "./add.ts";
import type { GlobalOpts } from "./index.ts";

function shorten(p: string, cwd: string): string {
  const home = process.env.HOME ?? "";
  if (p.startsWith(cwd + path.sep)) return `.${p.slice(cwd.length)}`;
  if (home && p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
  return p;
}

export async function runList(args: string[], g: GlobalOpts): Promise<number> {
  const f = parseFlags(args, {
    booleans: { global: ["-g", "--global"], json: ["--json"] },
    lists: { agent: ["-a", "--agent"] },
  });
  const json = f.booleans.has("json");
  if (f.missing.length > 0) {
    console.error(`Error: ${f.missing[0]} requires a value`);
    if (json) console.log("[]");
    return 1;
  }
  let result;
  try {
    result = await listSkills({ cwd: g.cwd, ...(g.store ? { store: g.store } : {}), global: f.booleans.has("global"), ...(f.lists.get("agent") ? { agents: f.lists.get("agent")! } : {}) });
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
    console.log(`${DIM}No ${label.toLowerCase()} skills found.${RESET}`);
    console.log(result.scope === "global" ? `${DIM}Try listing project skills without -g${RESET}` : `${DIM}Try listing global skills with -g${RESET}`);
    return 0;
  }
  console.log(`${BOLD}${label} Skills${RESET}`);
  console.log();
  const nameW = Math.max(...installed.map((s) => sanitizeMetadata(s.name).length), 0);
  for (const s of installed) {
    const tag = s.status === "untracked" ? ` ${YELLOW}(not global)${RESET}` : "";
    console.log(`${pc.cyan(sanitizeMetadata(s.name).padEnd(nameW))} ${DIM}${s.dir ? shorten(s.dir, g.cwd) : ""}${RESET}${tag}`);
    console.log(`  ${DIM}Agents:${RESET} ${agentsLabel(s.agents)}  ${DIM}Source:${RESET} ${sanitizeMetadata(s.source)}`);
  }
  console.log();
  if (missing.length > 0) {
    console.log(`${BOLD}Missing${RESET} ${DIM}(in skill-library.json, not installed — run skill-library install)${RESET}`);
    for (const s of missing) console.log(`  ${pc.cyan(sanitizeMetadata(s.name))}  ${DIM}Source:${RESET} ${sanitizeMetadata(s.source)}`);
    console.log();
  }
  return 0;
}
