// What the sync commands share, and the hook add / remove / update call after a global change.
import * as p from "@clack/prompts";
import pc from "picocolors";
import { recordGlobalChange, type GlobalChange, type ReadmeOptions, type ReadmeOutcome, type SyncResult } from "../../core/sync.ts";
import { msgOf, note, sanitizeMetadata } from "../../lib/cli.ts";
import { isRunningInAgent } from "../../lib/detect-agent.ts";
import type { GlobalOpts } from "../index.ts";

export const SYNC_USAGE = "Usage: skill-library sync [init <git-url> [--share <skill...>] [--no-readme] | update <git-url> [--no-readme] | share <skill...> | enable | disable | status]";

function shadowLine(name: string): string {
  return `${sanitizeMetadata(name)} from the sync repo now shadows another global ${sanitizeMetadata(name)}; see skill-library list -g and remove the one you don't want`;
}

export function readmeLine(r: NonNullable<ReadmeOutcome>): string {
  return pc.gray(`${r.action === "created" ? "Added" : "Replaced"} the repository's ${r.file}.`);
}

export function printResult(r: SyncResult): void {
  for (const n of r.added) console.log(`  ${pc.green("+")} ${sanitizeMetadata(n)}`);
  for (const n of r.removed) console.log(`  ${pc.red("-")} ${sanitizeMetadata(n)}`);
  for (const n of r.updated) console.log(`  ${pc.green("↑")} ${sanitizeMetadata(n)}`);
  for (const e of r.errors) console.log(`  ${pc.red("✗")} ${e}`);
  for (const n of r.shadowed) console.log(`  ${pc.yellow("!")} ${shadowLine(n)}`);
  const changes = r.added.length + r.removed.length + r.updated.length;
  console.log(`${changes === 0 ? "Global skills are in sync" : "Synced global skills"} with ${r.url}${r.pushed ? " (pushed)" : ""}`);
}

type Base = { cwd: string; store?: string };

export function baseOf(g: GlobalOpts): Base {
  return { cwd: g.cwd, ...(g.store ? { store: g.store } : {}) };
}

/** A terminal to ask in (and not inside an agent). */
export function canPrompt(): boolean {
  return !!process.stdin.isTTY && !isRunningInAgent();
}

/** init / update: a repo without a README gets ours; one with a README is replaced only when you
 *  say so (no terminal to ask in: kept). `readme: false` (--no-readme) leaves the README alone. */
export function readmeOptions(readme: boolean | undefined): ReadmeOptions {
  if (readme === false) return { readme: false };
  return {
    confirmReadme: async (files) => {
      if (!canPrompt()) return false;
      const ok = await p.confirm({ message: `The repository already has ${files.join(", ")}. Replace it with the Skill Library README?`, initialValue: false });
      return ok === true;
    },
  };
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
