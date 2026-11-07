import * as p from "@clack/prompts";
import pc from "picocolors";
import { addSkills, type AddedSkill } from "../core/add.ts";
import { agentsArg } from "../core/context.ts";
import { agentIds, displayName } from "../lib/agents.ts";
import { CliError, DIM, RESET, TEXT, formatError, note, sanitizeMetadata } from "../lib/cli.ts";
import { isRunningInAgent } from "../lib/detect-agent.ts";
import { placeGateway } from "../lib/gateway.ts";
import { loadProject } from "../lib/manifest.ts";
import type { AgentsValue } from "../lib/store.ts";
import { parseFlags } from "./args.ts";
import { oldCommandGuard } from "./legacy.ts";
import { showLogo } from "./ui.ts";
import type { GlobalOpts } from "./index.ts";

export function agentsDisplay(value: AgentsValue): string[] {
  return value === "all" ? agentIds().map(displayName) : value.map(displayName);
}

export function agentsLabel(value: AgentsValue): string {
  if (value === "all") return "all agents";
  const names = value.map(displayName);
  return names.length <= 5 ? names.join(", ") : `${names.slice(0, 5).join(", ")} +${names.length - 5} more`;
}

function jsonRow(r: AddedSkill): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    source: r.source,
    ref: r.ref,
    hash: r.hash,
    path: r.path,
    scope: r.scope,
    agents: agentsDisplay(r.agents),
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function runAdd(args: string[], g: GlobalOpts): Promise<number> {
  oldCommandGuard("add", args);
  const f = parseFlags(args, {
    booleans: {
      global: ["-g", "--global"],
      list: ["-l", "--list"],
      yes: ["-y", "--yes"],
      all: ["--all"],
      fullDepth: ["--full-depth"],
      copy: ["--copy"],
      json: ["--json"],
    },
    lists: { agent: ["-a", "--agent"], skill: ["-s", "--skill"] },
  });
  const json = f.booleans.has("json");
  const inAgent = isRunningInAgent();
  const yes = f.booleans.has("yes") || f.booleans.has("all") || inAgent;
  const fail = (err: CliError): number => {
    console.error(`Error: ${formatError(err)}`);
    if (json) console.log("[]");
    return 1;
  };
  if (f.missing.length > 0) return fail(new CliError(1, `${f.missing[0]} requires a value`));
  if (json && f.booleans.has("list")) return fail(new CliError(1, "--json cannot be combined with --list"));
  if (json && !yes) return fail(new CliError(1, "--json requires -y (or --all) so no prompt is needed"));
  const source = f.positionals[0];
  if (!source) return fail(new CliError(1, "Missing required argument: source", "Usage: skill-library add <package> [options]"));
  if (f.positionals.length > 1) note(`Only the first source is used: ${source}`);

  const agents = f.booleans.has("all") ? ["*"] : f.lists.get("agent");
  const skills = f.booleans.has("all") ? ["*"] : f.lists.get("skill");
  try {
    if (agents) agentsArg(agents);
  } catch (err) {
    return fail(err as CliError);
  }

  if (!json) showLogo();
  let global = f.booleans.has("global");
  const interactive = !yes && !!process.stdin.isTTY;
  if (!global && interactive && !f.booleans.has("list")) {
    const project = await loadProject(g.cwd);
    if (project) {
      const choice = await p.select({
        message: "Installation scope",
        options: [
          { value: "project", label: "Project", hint: `${project.root}/skill-library.json` },
          { value: "global", label: "Global", hint: "the whole library, every project" },
        ],
      });
      if (p.isCancel(choice)) {
        p.cancel("Installation cancelled");
        return 0;
      }
      global = choice === "global";
    }
  }

  const spinner = !json && process.stderr.isTTY ? p.spinner({ output: process.stderr }) : null;
  spinner?.start(`Fetching ${source}`);
  let result;
  try {
    result = await addSkills(source, {
      cwd: g.cwd,
      ...(g.store ? { store: g.store } : {}),
      global,
      ...(agents ? { agents } : {}),
      ...(skills ? { skills } : {}),
      fullDepth: f.booleans.has("fullDepth"),
      list: f.booleans.has("list"),
      selectSkills: async (found) => {
        if (yes) return found;
        if (!process.stdin.isTTY) {
          throw new CliError(1, "Interactive prompt required but stdin is not a TTY. Nothing was installed. Use --skill <name> (or --skill '*') and -y to run non-interactively.");
        }
        spinner?.stop(`Found ${found.length} skills`);
        const picked = await p.multiselect({
          message: "Select skills to add",
          options: found.map((s) => ({ value: s.name, label: s.name, hint: s.description.slice(0, 60) })),
          required: true,
        });
        if (p.isCancel(picked)) return [];
        return found.filter((s) => (picked as string[]).includes(s.name));
      },
    });
    spinner?.stop("Done");
  } catch (err) {
    spinner?.stop("Failed");
    if (err instanceof CliError) return fail(err);
    throw err;
  }

  if (f.booleans.has("list")) {
    console.log(`${pc.bold("Available Skills")}`);
    console.log();
    for (const s of result.discovered) {
      console.log(`  ${pc.cyan(sanitizeMetadata(s.name))}`);
      console.log(`    ${DIM}${sanitizeMetadata(s.description)}${RESET}`);
    }
    if (result.gatewayOnly) console.log(`  ${DIM}(only the skill-library gateway — it is placed by add, never stored)${RESET}`);
    console.log();
    console.log(`${DIM}Use --skill <name> to add specific skills${RESET}`);
    return 0;
  }

  const ok = result.skills.length > 0 && result.skills.every((r) => r.status !== "failed");
  const placeAgents = agents && !agents.includes("*") ? agents : [];
  if (result.gatewayOnly || result.skills.some((r) => r.status === "installed")) {
    const gw = await placeGateway(placeAgents);
    if (gw.updated.length > 0) note(`Updated skill-library gateway for ${gw.updated.join(", ")}`);
    if (gw.removedHelpers.length > 0) note(`Removed ${gw.removedHelpers.length} old skill-library helper skill(s) from agent folders`);
    for (const e of gw.errors) note(`gateway: ${e}`);
  }

  if (json) {
    console.log(JSON.stringify(result.skills.map(jsonRow), null, 2));
    return result.skills.some((r) => r.status === "failed") ? 1 : 0;
  }
  if (result.gatewayOnly) {
    console.log(`${TEXT}This source only contains the skill-library gateway; nothing was added to the library.${RESET}`);
    return 0;
  }
  if (result.skills.length === 0) {
    console.log("Installation cancelled");
    return 0;
  }
  const where = result.scope === "project" ? `project (${result.projectRoot}/skill-library.json)` : "global library";
  console.log();
  console.log(`${pc.bold("Installation Summary")} ${DIM}→ ${where}${RESET}`);
  for (const r of result.skills) {
    if (r.status === "failed") {
      console.log(`  ${pc.red("✗")} ${sanitizeMetadata(r.name)} ${DIM}→ library: ${r.error}${RESET}`);
      continue;
    }
    const verb = r.id.startsWith("local://") ? "Added" : "Stored";
    console.log(`  ${pc.green("✓")} ${verb} ${pc.cyan(sanitizeMetadata(r.name))} ${DIM}(${r.id})${RESET}`);
    console.log(`    ${DIM}path:${RESET} ${r.path}`);
    console.log(`    ${DIM}agents:${RESET} ${agentsLabel(r.agents)}`);
  }
  console.log();
  console.log(`${DIM}Agents find these skills with${RESET} skill-library query "<task>"`);
  return ok ? 0 : 1;
}
