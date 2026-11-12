import * as p from "@clack/prompts";
import pc from "picocolors";
import { addSkills, type AddedSkill, type NameClash } from "../core/add.ts";
import { agentsArg, globalKindOf, type GlobalKind } from "../core/context.ts";
import { readSyncConfig } from "../core/sync.ts";
import { agentIds, displayName } from "../lib/agents.ts";
import { CliError, formatError, note, sanitizeMetadata } from "../lib/cli.ts";
import { isRunningInAgent } from "../lib/detect-agent.ts";
import { placeGateway } from "../lib/gateway.ts";
import { gitSkillId } from "../lib/ids.ts";
import { loadProject } from "../lib/manifest.ts";
import { resolveStore } from "../lib/paths.ts";
import { parseSource } from "../lib/source.ts";
import type { AgentsValue } from "../lib/store.ts";
import { afterGlobalChange } from "./sync/shared.ts";
import { showLogo } from "./ui.ts";
import { Option, type Command, type OptionValues } from "@commander-js/extra-typings";
import { type Ctx, examples, given, jsonOnError, list, newCommand, warnUnknownOptions } from "./command.ts";
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

interface AddOptions {
  global?: boolean;
  project?: boolean;
  list?: boolean;
  yes?: boolean;
  all?: boolean;
  fullDepth?: boolean;
  json?: boolean;
  /** true for --share, false for --no-share. */
  share?: boolean;
  /** Both --share and --no-share were given. */
  shareConflict?: boolean;
  agent?: string[];
  skill?: string[];
}

/** `add <package>`: `sources` are the positionals (only the first is used). */
export async function runAdd(sources: string[], opts: AddOptions, g: GlobalOpts): Promise<number> {
  const json = !!opts.json;
  const inAgent = isRunningInAgent();
  const yes = !!opts.yes || !!opts.all || inAgent;
  const fail = (err: CliError): number => {
    console.error(`Error: ${formatError(err)}`);
    if (json) console.log("[]");
    return 1;
  };
  if (json && opts.list) return fail(new CliError(1, "--json cannot be combined with --list"));
  if (json && !yes) return fail(new CliError(1, "--json requires -y (or --all) so no prompt is needed"));
  if (opts.global && opts.project) return fail(new CliError(1, "--global cannot be combined with --project"));
  if (opts.shareConflict) return fail(new CliError(1, "--share cannot be combined with --no-share"));
  const source = sources[0];
  if (!source) return fail(new CliError(1, "Missing required argument: source", "Usage: skill-library add <package> [options]"));
  if (sources.length > 1) note(`Only the first source is used: ${source}`);

  const agents = opts.all ? ["*"] : opts.agent;
  const skills = opts.all ? ["*"] : opts.skill;
  try {
    if (agents) agentsArg(agents);
  } catch (err) {
    return fail(err as CliError);
  }

  if (!json) showLogo();
  // Global by default. With a skill-library.json here, ask; without a prompt (-y, no TTY, inside an
  // agent) the scope must be explicit (-p / -g), as for remove. -y never picks the scope.
  let projectScope = !!opts.project;
  if (!projectScope && !opts.global && !opts.list) {
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
  let share: boolean | undefined = opts.share;
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
      fullDepth: !!opts.fullDepth,
      list: !!opts.list,
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

  if (opts.list) {
    console.log(`${pc.bold("Available Skills")}`);
    console.log();
    for (const s of result.discovered) {
      console.log(`  ${pc.cyan(sanitizeMetadata(s.name))}`);
      console.log(`    ${pc.gray(sanitizeMetadata(s.description))}`);
    }
    if (result.gatewayOnly) console.log(`  ${pc.gray("(only the skill-library gateway — it is placed by add, never stored)")}`);
    console.log();
    console.log(pc.gray("Use --skill <name> to add specific skills"));
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
    console.log("This source only contains the skill-library gateway; nothing was added to the library.");
    return 0;
  }
  if (result.cancelled || result.skills.length === 0) {
    console.log("Installation cancelled");
    return 0;
  }
  const where = result.scope === "project" ? `project (${result.projectRoot}/skill-library.json)` : "global library";
  console.log();
  console.log(`${pc.bold("Installation Summary")} ${pc.gray(`→ ${where}`)}`);
  for (const r of result.skills) {
    if (r.status === "failed") {
      console.log(`  ${pc.red("✗")} ${sanitizeMetadata(r.name)} ${pc.gray(`→ library: ${r.error}`)}`);
      continue;
    }
    const verb = r.id.startsWith("local://") ? "Added" : "Stored";
    console.log(`  ${pc.green("✓")} ${verb} ${pc.cyan(sanitizeMetadata(r.name))} ${pc.gray(`(${r.id})`)}`);
    console.log(`    ${pc.gray("path:")} ${r.path}`);
    console.log(`    ${pc.gray("agents:")} ${agentsLabel(r.agents)}`);
  }
  for (const r of result.replaced) {
    console.log(`  ${pc.yellow("↺")} Replaced ${pc.cyan(sanitizeMetadata(r.name))} ${pc.gray(`(${r.id}; kept in the store, not global)`)}`);
  }
  console.log();
  console.log(`${pc.gray("Agents find these skills with")} skill-library query "<task>"`);
  return ok ? 0 : 1;
}

/** add's options; `install <package>` takes them too, without listing them in its help. */
export function withAddOptions<A extends unknown[], O extends OptionValues, G extends OptionValues>(cmd: Command<A, O, G>, hidden = false) {
  const opt = <F extends string>(flags: F, description: string) => new Option(flags, description).hideHelp(hidden);
  return cmd
    .addOption(opt("-p, --project", "Pin in this project's skill-library.json (created if missing)"))
    .addOption(opt("-g, --global", "Add to the global library (the default; skips the scope prompt). With a skill-library.json and no prompt (-y, no TTY, agent): pass -p or -g"))
    .addOption(opt("-a, --agent <agents...>", "Agents the skills are for ('*' for all agents; default: all)").argParser(list))
    .addOption(opt("-s, --skill <skills...>", "Skill names to add ('*' for all skills)").argParser(list))
    .addOption(opt("-l, --list", "List the skills in the source without adding them"))
    .addOption(opt("-y, --yes", "Skip confirmation prompts"))
    .addOption(opt("--all", "Shorthand for --skill '*' --agent '*' -y"))
    .addOption(opt("--full-depth", "Search all subdirectories even when a root SKILL.md exists"))
    .addOption(opt("--json", "Output results as JSON (machine-readable, no ANSI codes)"))
    .addOption(opt("--copy", "Accepted for compatibility (skills are always copied into the library)"))
    .addOption(opt("--share", "With sync on: sync a skill from a local folder to your other devices"))
    .addOption(opt("--no-share", "With sync on: keep a skill from a local folder on this machine only (default: asks; machine-only with -y or inside an agent)"));
}

export function addCommand(ctx: Ctx) {
  const add = withAddOptions(
    newCommand("add")
      .alias("a")
      .summary("Add skills to the library")
      .description("Add skills to the global library, or pin them in this project's skill-library.json with -p.")
      .argument("<package>", "owner/repo, a git URL or a local path (e.g. anthropics/skills, https://github.com/anthropics/skills, ./path/to/skills)"),
  ).addHelpText(
    "after",
    examples([
      ["skill-library add anthropics/skills", "add to the global library"],
      ["skill-library add anthropics/skills -p", "pin in this project's skill-library.json"],
      ["skill-library add anthropics/skills --agent claude-code", "only for Claude Code"],
      ["skill-library add anthropics/skills --skill pdf docx"],
      ["skill-library add anthropics/skills --list", "see what is in it"],
      ["skill-library add anthropics/skills --json -y", "JSON output"],
    ]),
  );
  const share = given(add, "share", "no-share");
  return warnUnknownOptions(jsonOnError(add, ctx)).action(async (_pkg, opts, cmd) => {
    ctx.done(await runAdd(cmd.args, { ...opts, shareConflict: share.size === 2 }, ctx.globals()));
  });
}
