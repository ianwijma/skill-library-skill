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
import { msgOf, note, sanitizeMetadata } from "../lib/cli.ts";
import { placeGateway } from "../lib/gateway.ts";
import { formatTimestamp } from "../lib/time.ts";
import type { GlobalOpts } from "./index.ts";

export const SYNC_USAGE = "Usage: skill-library sync [init <git-url> [--share <skill...>] [--no-readme] | update <git-url> [--no-readme] | share <skill...> | enable | disable | status]";

function shadowLine(name: string): string {
  return `${sanitizeMetadata(name)} from the sync repo now shadows another global ${sanitizeMetadata(name)}; see skill-library list -g and remove the one you don't want`;
}

function readmeLine(r: NonNullable<ReadmeOutcome>): string {
  return pc.gray(`${r.action === "created" ? "Added" : "Replaced"} the repository's ${r.file}.`);
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

type Base = { cwd: string; store?: string };

function baseOf(g: GlobalOpts): Base {
  return { cwd: g.cwd, ...(g.store ? { store: g.store } : {}) };
}

/** A terminal to ask in (and not inside an agent). */
function canPrompt(): boolean {
  return !!process.stdin.isTTY && !isRunningInAgent();
}

/** init / update: a repo without a README gets ours; one with a README is replaced only when you
 *  say so (no terminal to ask in: kept). `readme: false` (--no-readme) leaves the README alone. */
function readmeOptions(readme: boolean | undefined): ReadmeOptions {
  if (readme === false) return { readme: false };
  return {
    confirmReadme: async (files) => {
      if (!canPrompt()) return false;
      const ok = await p.confirm({ message: `The repository already has ${files.join(", ")}. Replace it with the Skill Library README?`, initialValue: false });
      return ok === true;
    },
  };
}

/** `sync`: pull, install, update and push now. `background` (internal) is what `query` starts. */
export async function runSyncNow(opts: { background?: boolean }, g: GlobalOpts): Promise<number> {
  if (opts.background) {
    // Started by `query`: no output, failures are kept in the status file.
    await runSync({ ...baseOf(g), background: true }).catch(() => null);
    return 0;
  }
  const r = await runSync(baseOf(g));
  if (r) printResult(r);
  return r && r.errors.length > 0 ? 1 : 0;
}

export interface SyncInitOptions {
  /** Folder skills to share when seeding an empty repository ('*' = all). */
  share?: string[];
  /** false for --no-readme. */
  readme?: boolean;
}

/** `sync init <git-url>`. */
export async function runSyncInit(url: string, opts: SyncInitOptions, g: GlobalOpts): Promise<number> {
  const shareFlag = opts.share;
  const interactive = !shareFlag && canPrompt();
  const outcome = await initSync(url, {
    ...baseOf(g),
    ...readmeOptions(opts.readme),
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
    console.log(`Sync is already set up with ${outcome.url}. ${pc.gray("Run")} skill-library sync ${pc.gray("to sync now.")}`);
    return 0;
  }
  const { result, seeded, machineOnly, readme } = outcome;
  const gw = await placeGateway();
  if (seeded.length > 0) console.log(pc.gray(`The repository was empty; added this machine's ${seeded.length} global skill(s) to it.`));
  if (machineOnly.length > 0) {
    console.log(`${pc.gray("Kept machine-only (not synced):")} ${machineOnly.map(sanitizeMetadata).join(", ")}`);
    console.log(`${pc.gray("Share one with")} skill-library sync share <name>`);
  }
  if (readme) console.log(readmeLine(readme));
  printResult(result);
  if (gw.updated.length > 0) note(`Updated skill-library gateway for ${gw.updated.join(", ")}`);
  for (const e of gw.errors) note(`gateway: ${e}`);
  console.log(`${pc.gray("Sync runs on its own from now on. Turn it off with")} skill-library sync disable`);
  return result.errors.length > 0 ? 1 : 0;
}

/** `sync update <git-url>`: move sync to another repository. */
export async function runSyncUpdate(url: string, opts: { readme?: boolean }, g: GlobalOpts): Promise<number> {
  const outcome = await updateSyncUrl(url, { ...baseOf(g), ...readmeOptions(opts.readme) });
  if (outcome.unchanged) {
    console.log(`Sync already uses ${outcome.url}`);
    return 0;
  }
  const { result, previousUrl, oldPullError, readme } = outcome;
  if (oldPullError) note(`Could not pull from ${previousUrl} first: ${oldPullError} (this machine's skills were moved as they are)`);
  console.log(`Sync moved from ${previousUrl} to ${result.url}`);
  if (readme) console.log(readmeLine(readme));
  printResult(result);
  console.log(`${pc.gray("On your other machines, run")} skill-library sync update ${result.url}`);
  return result.errors.length > 0 ? 1 : 0;
}

/** `sync share [skills...]`: without names (on a terminal), asks which. */
export async function runSyncShare(names: string[], g: GlobalOpts): Promise<number> {
  const base = baseOf(g);
  let selectors = names;
  if (selectors.length === 0 && process.stdin.isTTY && !isRunningInAgent()) {
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
  for (const s of r.shared) {
    console.log(`  ${pc.green("✓")} Shared ${pc.cyan(sanitizeMetadata(s.name))}`);
    console.log(`    ${pc.gray("edit it here from now on:")} ${s.path}`);
  }
  for (const e of r.errors) console.log(`  ${pc.red("✗")} ${e}`);
  if (r.pushed) console.log(`Synced to ${r.url}`);
  return r.errors.length > 0 ? 1 : 0;
}

/** `sync enable`: start syncing again, and sync now. */
export async function runSyncEnable(g: GlobalOpts): Promise<number> {
  await setSyncEnabled(true, baseOf(g));
  console.log("Sync enabled");
  const r = await runSync(baseOf(g));
  if (r) printResult(r);
  return r && r.errors.length > 0 ? 1 : 0;
}

/** `sync disable`. */
export async function runSyncDisable(g: GlobalOpts): Promise<number> {
  const cfg = await setSyncEnabled(false, baseOf(g));
  console.log(`Sync disabled. Nothing is pulled from or pushed to ${cfg.url} until you run skill-library sync enable`);
  return 0;
}

/** `sync status`. */
export async function runSyncStatus(g: GlobalOpts): Promise<number> {
  const s = await syncStatus(baseOf(g));
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
