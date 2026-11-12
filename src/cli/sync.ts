import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  initSync,
  recordGlobalChange,
  runSync,
  setSyncEnabled,
  shareableSkills,
  shareSkills,
  updateSyncUrl,
  syncStatus,
  type GlobalChange,
  type ReadmeOptions,
  type ReadmeOutcome,
  type SyncResult,
} from "../core/sync.ts";
import { isRunningInAgent } from "../lib/detect-agent.ts";
import { CliError, DIM, RESET, formatError, msgOf, note, sanitizeMetadata } from "../lib/cli.ts";
import { placeGateway } from "../lib/gateway.ts";
import { formatTimestamp } from "../lib/time.ts";
import { parseFlags } from "./args.ts";
import type { GlobalOpts } from "./index.ts";

const USAGE = "Usage: skill-library sync [init <git-url> [--share <skill...>] [--no-readme] | update <git-url> [--no-readme] | share <skill...> | enable | disable | status]";

function shadowLine(name: string): string {
  return `${sanitizeMetadata(name)} from the sync repo now shadows another global ${sanitizeMetadata(name)}; see skill-library list -g and remove the one you don't want`;
}

function readmeLine(r: NonNullable<ReadmeOutcome>): string {
  return `${DIM}${r.action === "created" ? "Added" : "Replaced"} the repository's ${r.file}.${RESET}`;
}

function printResult(r: SyncResult): void {
  for (const n of r.added) console.log(`  ${pc.green("+")} ${sanitizeMetadata(n)}`);
  for (const n of r.removed) console.log(`  ${pc.red("-")} ${sanitizeMetadata(n)}`);
  for (const n of r.updated) console.log(`  ${pc.green("↑")} ${sanitizeMetadata(n)}`);
  for (const e of r.errors) console.log(`  ${pc.red("✗")} ${e}`);
  for (const n of r.shadowed) console.log(`  ${pc.yellow("!")} ${shadowLine(n)}`);
  const changes = r.added.length + r.removed.length + r.updated.length;
  console.log(`${changes === 0 ? "Global skills are in sync" : "Synced global skills"} with ${r.url}${r.pushed ? " (pushed)" : ""}`);
}

export async function runSyncCommand(args: string[], g: GlobalOpts): Promise<number> {
  const f = parseFlags(args, { booleans: { background: ["--background"], json: ["--json"], noReadme: ["--no-readme"] }, lists: { share: ["--share"] } });
  if (f.missing.length > 0) {
    console.error(`Error: ${f.missing[0]} requires a value`);
    return 1;
  }
  const base = { cwd: g.cwd, ...(g.store ? { store: g.store } : {}) };
  const [sub, ...rest] = f.positionals;
  const json = f.booleans.has("json");
  const tty = !json && !!process.stdin.isTTY && !isRunningInAgent();
  // init / update: a repo without a README gets ours; one with a README is replaced only when you
  // say so (no terminal to ask in: kept). --no-readme leaves the README alone either way.
  const readmeOpts: ReadmeOptions = f.booleans.has("noReadme")
    ? { readme: false }
    : {
        confirmReadme: async (files) => {
          if (!tty) return false;
          const ok = await p.confirm({ message: `The repository already has ${files.join(", ")}. Replace it with the Skill Library README?`, initialValue: false });
          return ok === true;
        },
      };
  try {
    switch (sub) {
      case undefined: {
        if (f.booleans.has("background")) {
          // Started by `query`: no output, failures are kept in the status file.
          await runSync({ ...base, background: true }).catch(() => null);
          return 0;
        }
        const r = await runSync(base);
        if (json) console.log(JSON.stringify(r));
        else if (r) printResult(r);
        return r && r.errors.length > 0 ? 1 : 0;
      }
      case "init": {
        const url = rest[0];
        if (!url) throw new CliError(1, "Missing required argument: git-url", "Usage: skill-library sync init <git-url>");
        const shareFlag = f.lists.get("share");
        const interactive = !shareFlag && tty;
        const outcome = await initSync(url, {
          ...base,
          ...readmeOpts,
          // Only you know which folder skills you wrote (share them) and which are copies (keep them local).
          ...(shareFlag
            ? { chooseShare: async (candidates) => candidates.filter((c) => shareFlag.includes("*") || shareFlag.includes(c.name) || shareFlag.includes(c.id)).map((c) => c.id) }
            : {}),
          ...(interactive
            ? {
                chooseShare: async (candidates) => {
                  const picked = await p.multiselect({
                    message: "Which of your folder skills should sync to your other devices? (copies of other people's skills: add them from their git repo instead)",
                    options: candidates.map((c) => ({ value: c.id, label: c.name, hint: c.description.slice(0, 60) })),
                    required: false,
                  });
                  return p.isCancel(picked) ? [] : (picked as string[]);
                },
              }
            : {}),
        });
        if (outcome.alreadySetUp) {
          if (json) console.log(JSON.stringify({ alreadySetUp: true, url: outcome.url }));
          else console.log(`Sync is already set up with ${outcome.url}. ${DIM}Run${RESET} skill-library sync ${DIM}to sync now.${RESET}`);
          return 0;
        }
        const { result, seeded, machineOnly, readme } = outcome;
        const gw = await placeGateway();
        if (json) {
          console.log(JSON.stringify({ ...result, seeded, machineOnly, readme }));
          return result.errors.length > 0 ? 1 : 0;
        }
        if (seeded.length > 0) console.log(`${DIM}The repository was empty; added this machine's ${seeded.length} global skill(s) to it.${RESET}`);
        if (machineOnly.length > 0) {
          console.log(`${DIM}Kept machine-only (not synced):${RESET} ${machineOnly.map(sanitizeMetadata).join(", ")}`);
          console.log(`${DIM}Share one with${RESET} skill-library sync share <name>`);
        }
        if (readme) console.log(readmeLine(readme));
        printResult(result);
        if (gw.updated.length > 0) note(`Updated skill-library gateway for ${gw.updated.join(", ")}`);
        for (const e of gw.errors) note(`gateway: ${e}`);
        console.log(`${DIM}Sync runs on its own from now on. Turn it off with${RESET} skill-library sync disable`);
        return result.errors.length > 0 ? 1 : 0;
      }
      case "update": {
        const url = rest[0];
        if (!url) throw new CliError(1, "Missing required argument: git-url", "Usage: skill-library sync update <git-url>");
        const outcome = await updateSyncUrl(url, { ...base, ...readmeOpts });
        if (outcome.unchanged) {
          if (json) console.log(JSON.stringify({ unchanged: true, url: outcome.url }));
          else console.log(`Sync already uses ${outcome.url}`);
          return 0;
        }
        const { result, previousUrl, oldPullError, readme } = outcome;
        if (json) {
          console.log(JSON.stringify({ ...result, previousUrl, readme, ...(oldPullError ? { oldPullError } : {}) }));
          return result.errors.length > 0 ? 1 : 0;
        }
        if (oldPullError) note(`Could not pull from ${previousUrl} first: ${oldPullError} (this machine's skills were moved as they are)`);
        console.log(`Sync moved from ${previousUrl} to ${result.url}`);
        if (readme) console.log(readmeLine(readme));
        printResult(result);
        console.log(`${DIM}On your other machines, run${RESET} skill-library sync update ${result.url}`);
        return result.errors.length > 0 ? 1 : 0;
      }
      case "share": {
        let selectors = rest;
        if (selectors.length === 0 && !json && process.stdin.isTTY && !isRunningInAgent()) {
          const candidates = await shareableSkills(base);
          if (candidates.length === 0) {
            console.log("No machine-only global skills to share.");
            return 0;
          }
          const picked = await p.multiselect({
            message: "Skills to share across your devices",
            options: candidates.map((c) => ({ value: c.id, label: c.name, hint: c.description.slice(0, 60) })),
            required: true,
          });
          if (p.isCancel(picked)) return 0;
          selectors = picked as string[];
        }
        const r = await shareSkills(selectors, base);
        if (json) {
          console.log(JSON.stringify(r));
          return r.errors.length > 0 ? 1 : 0;
        }
        for (const s of r.shared) {
          console.log(`  ${pc.green("✓")} Shared ${pc.cyan(sanitizeMetadata(s.name))}`);
          console.log(`    ${DIM}edit it here from now on:${RESET} ${s.path}`);
        }
        for (const e of r.errors) console.log(`  ${pc.red("✗")} ${e}`);
        if (r.pushed) console.log(`Synced to ${r.url}`);
        return r.errors.length > 0 ? 1 : 0;
      }
      case "enable": {
        await setSyncEnabled(true, base);
        console.log("Sync enabled");
        const r = await runSync(base);
        if (r) printResult(r);
        return r && r.errors.length > 0 ? 1 : 0;
      }
      case "disable": {
        const cfg = await setSyncEnabled(false, base);
        console.log(`Sync disabled. Nothing is pulled from or pushed to ${cfg.url} until you run skill-library sync enable`);
        return 0;
      }
      case "status": {
        const s = await syncStatus(base);
        if (json) {
          console.log(JSON.stringify(s));
          return 0;
        }
        if (!s.configured) {
          console.log("Sync is not set up. Run skill-library sync init <git-url>");
          return 0;
        }
        console.log(`Repository: ${s.url}`);
        console.log(`Sync:       ${s.enabled ? pc.green("enabled") : pc.yellow("disabled")}`);
        console.log(`Clone:      ${s.clone}`);
        console.log(`Last sync:  ${s.lastSync ? formatTimestamp(s.lastSync) : "never"}`);
        if (s.pending !== undefined && s.pending > 0) console.log(`Unpushed:   ${s.pending} commit(s)`);
        if (s.lastError) console.log(`Last error: ${pc.red(s.lastError)}`);
        return 0;
      }
      default:
        throw new CliError(1, `Unknown sync command: ${sub}`, USAGE);
    }
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${formatError(err)}`);
      return err.exitCode;
    }
    throw err;
  }
}

/** After a global add/remove/update: push the change to the sync repo (no-op unless sync is enabled). Never fails the command. */
export async function afterGlobalChange(change: GlobalChange, g: GlobalOpts): Promise<void> {
  try {
    const res = await recordGlobalChange(change, { cwd: g.cwd, ...(g.store ? { store: g.store } : {}) });
    if (!res) return;
    for (const n of res.pulled.added) note(`  ${pc.green("+")} ${sanitizeMetadata(n)} (from ${res.url})`);
    for (const n of res.pulled.removed) note(`  ${pc.red("-")} ${sanitizeMetadata(n)} (dropped by ${res.url})`);
    for (const s of res.shared) note(`Shared ${sanitizeMetadata(s.name)} across your devices. It now lives in the sync repo; edit it there: ${s.path}`);
    for (const n of res.shadowed) note(shadowLine(n));
    if (res.errors.length > 0) note(`sync: ${res.errors.join("; ")} (the change is kept locally and pushed on the next sync)`);
    else if (res.pushed) note(`Synced to ${res.url}`);
  } catch (err) {
    note(`sync: ${msgOf(err)}`);
  }
}
