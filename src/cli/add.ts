import * as p from "@clack/prompts";
import pc from "picocolors";
import { addSkills, type AddedSkill, type NameClash } from "../core/add.ts";
import { agentsArg, globalKindOf, type GlobalKind } from "../core/context.ts";
import { readSyncConfig } from "../core/sync.ts";
import { agentIds, displayName } from "../lib/agents.ts";
import { CliError, DIM, RESET, TEXT, formatError, note, sanitizeMetadata } from "../lib/cli.ts";
import { isRunningInAgent } from "../lib/detect-agent.ts";
import { placeGateway } from "../lib/gateway.ts";
import { gitSkillId } from "../lib/ids.ts";
import { loadProject } from "../lib/manifest.ts";
import { resolveStore } from "../lib/paths.ts";
import { parseSource } from "../lib/source.ts";
import type { AgentsValue } from "../lib/store.ts";
import { parseFlags } from "./args.ts";
import { afterGlobalChange } from "./sync.ts";
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

const KIND_LABEL: Record<GlobalKind, string> = { remote: "from a git repo", own: "your own skill, synced", "machine-only": "machine-only" };

function clashMessage(c: NameClash, e: NameClash["existing"][number], kind: GlobalKind): string {
  const files = e.sameContent ? "same files" : "different files";
  return `A global ${c.name} already exists (${KIND_LABEL[kind]}: ${e.source}; ${files}). Replace it with this one?`;
}

export async function runAdd(args: string[], g: GlobalOpts): Promise<number> {
  const f = parseFlags(args, {
    booleans: {
      global: ["-g", "--global"],
      project: ["-p", "--project"],
      list: ["-l", "--list"],
      yes: ["-y", "--yes"],
      all: ["--all"],
      fullDepth: ["--full-depth"],
      copy: ["--copy"],
      json: ["--json"],
      share: ["--share"],
      noShare: ["--no-share"],
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
  if (f.booleans.has("global") && f.booleans.has("project")) return fail(new CliError(1, "--global cannot be combined with --project"));
  if (f.booleans.has("share") && f.booleans.has("noShare")) return fail(new CliError(1, "--share cannot be combined with --no-share"));
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
  // Global by default. With a skill-library.json here, ask; without a prompt (-y, no TTY, inside an
  // agent) the scope must be explicit (-p / -g), as for remove. -y never picks the scope.
  let projectScope = f.booleans.has("project");
  if (!projectScope && !f.booleans.has("global") && !f.booleans.has("list")) {
    const project = await loadProject(g.cwd);
    if (project?.exists) {
      if (!yes && process.stdin.isTTY) {
        const choice = await p.select({
          message: "Add to",
          options: [
            { value: "global", label: "Global", hint: "the whole library, every project" },
            { value: "project", label: "Project", hint: project.file },
          ],
        });
        if (p.isCancel(choice)) {
          p.cancel("Installation cancelled");
          return 0;
        }
        projectScope = choice === "project";
      } else {
        return fail(
          new CliError(
            1,
            `This folder has a project (${project.file}); say where to add to.`,
            "Use -p to pin in the project's skill-library.json, or -g to add to the global library.",
          ),
        );
      }
    }
  }
  const global = !projectScope;

  // With sync on, a global skill from a local folder is machine-only unless shared: the CLI can't
  // tell a skill you wrote from a copy of someone else's, so sharing is the user's call.
  const sync = await readSyncConfig(resolveStore(g.store)).catch(() => null);
  const syncUrl = sync?.enabled ? sync.url : null;
  let isLocal = false;
  try {
    isLocal = parseSource(source, g.cwd).type === "local";
  } catch {
    // addSkills reports a bad source.
  }
  let share: boolean | undefined = f.booleans.has("share") ? true : f.booleans.has("noShare") ? false : undefined;
  if (share !== undefined && !(global && syncUrl)) note("--share/--no-share only apply to global adds while sync is enabled");

  const spinner = !json && process.stderr.isTTY ? p.spinner({ output: process.stderr }) : null;
  spinner?.start(`Fetching ${source}`);
  let result;
  try {
    result = await addSkills(source, {
      cwd: g.cwd,
      ...(g.store ? { store: g.store } : {}),
      project: projectScope,
      ...(agents ? { agents } : {}),
      ...(skills ? { skills } : {}),
      fullDepth: f.booleans.has("fullDepth"),
      list: f.booleans.has("list"),
      confirm: async (picked, scope, kind) => {
        if (yes) return true;
        if (!process.stdin.isTTY) {
          throw new CliError(1, "Interactive prompt required but stdin is not a TTY. Nothing was installed. Use -y to run non-interactively.");
        }
        spinner?.stop(`Found ${picked.length} skill(s)`);
        const message =
          kind === "gateway"
            ? "This source only contains the skill-library gateway. Install it into your agents' skills folders?"
            : `Add ${picked.map((s) => s.name).join(", ")} to the ${scope === "project" ? "project" : "global library"}?`;
        const ok = await p.confirm({ message });
        if (p.isCancel(ok) || ok !== true) return false;
        if (kind !== "gateway" && scope === "global" && syncUrl && isLocal && share === undefined) {
          const s = await p.confirm({ message: `Share ${picked.length === 1 ? "it" : "them"} across your devices (through ${syncUrl})?`, initialValue: true });
          if (p.isCancel(s)) return false;
          share = s === true;
        }
        return true;
      },
      resolveClashes: async (clashes) => {
        const replace: string[] = [];
        for (const c of clashes) {
          for (const e of c.existing) {
            // Sharing a folder skill over your own skill of the same name updates that skill in the repo.
            if (share && syncUrl && e.id === gitSkillId(syncUrl, c.name)) continue;
            if (yes) {
              replace.push(e.id); // safe: the old copy stays in the store, listed as not global
              continue;
            }
            spinner?.stop("Found a skill with the same name");
            const ok = await p.confirm({ message: clashMessage(c, e, globalKindOf(e, syncUrl)), initialValue: true });
            if (!p.isCancel(ok) && ok === true) replace.push(e.id);
          }
        }
        return replace;
      },
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
  if (!result.cancelled && (result.gatewayOnly || result.skills.some((r) => r.status === "installed"))) {
    const gw = await placeGateway(placeAgents);
    if (gw.updated.length > 0) note(`Updated skill-library gateway for ${gw.updated.join(", ")}`);
    for (const e of gw.errors) note(`gateway: ${e}`);
  }

  const addedGlobal = result.scope === "global" && !result.cancelled ? result.skills.filter((r) => r.status === "installed").map((r) => r.id) : [];
  const shareIds = share && isLocal ? addedGlobal : [];
  if (addedGlobal.length > 0) {
    await afterGlobalChange({ added: addedGlobal, share: shareIds, removed: result.replaced.map((r) => r.id) }, g);
  }
  if (syncUrl && isLocal && shareIds.length === 0) {
    for (const r of result.skills.filter((x) => x.status === "installed" && x.scope === "global")) {
      note(`${sanitizeMetadata(r.name)} is machine-only (not synced). To share it: skill-library sync share ${sanitizeMetadata(r.name)}`);
    }
  }

  if (json) {
    console.log(JSON.stringify(result.skills.map(jsonRow), null, 2));
    return result.skills.some((r) => r.status === "failed") ? 1 : 0;
  }
  if (result.cancelled) {
    console.log("Installation cancelled");
    return 0;
  }
  if (result.gatewayOnly) {
    console.log(`${TEXT}This source only contains the skill-library gateway; nothing was added to the library.${RESET}`);
    return 0;
  }
  if (result.cancelled || result.skills.length === 0) {
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
  for (const r of result.replaced) {
    console.log(`  ${pc.yellow("↺")} Replaced ${pc.cyan(sanitizeMetadata(r.name))} ${DIM}(${r.id}; kept in the store, not global)${RESET}`);
  }
  console.log();
  console.log(`${DIM}Agents find these skills with${RESET} skill-library query "<task>"`);
  return ok ? 0 : 1;
}
