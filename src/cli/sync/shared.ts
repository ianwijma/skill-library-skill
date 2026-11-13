// What the sync commands share, and the hook add / remove / update call after a global change.
import * as prompts from "@clack/prompts";
import pc from "picocolors";
import { recordGlobalChange, type GlobalChange, type ReadmeOptions, type ReadmeOutcome, type SyncResult } from "../../core/sync.ts";
import { msgOf, note, sanitizeMetadata } from "../../lib/cli.ts";
import { isRunningInAgent } from "../../lib/detect-agent.ts";
import type { GlobalOpts } from "../index.ts";

export const SYNC_USAGE = "Usage: skill-library sync [init <git-url> [--share <skill...>] [--no-readme] | update <git-url> [--no-readme] | share <skill...> | enable | disable | status]";

function shadowLine(name: string): string {
  return `${sanitizeMetadata(name)} from the sync repo now shadows another global ${sanitizeMetadata(name)}; see skill-library list -g and remove the one you don't want`;
}

export function readmeLine(outcome: NonNullable<ReadmeOutcome>): string {
  return pc.gray(`${outcome.action === "created" ? "Added" : "Replaced"} the repository's ${outcome.file}.`);
}

export function printResult(result: SyncResult): void {
  for (const name of result.added) {
    console.log(`  ${pc.green("+")} ${sanitizeMetadata(name)}`);
  }

  for (const name of result.removed) {
    console.log(`  ${pc.red("-")} ${sanitizeMetadata(name)}`);
  }

  for (const name of result.updated) {
    console.log(`  ${pc.green("↑")} ${sanitizeMetadata(name)}`);
  }

  for (const error of result.errors) {
    console.log(`  ${pc.red("✗")} ${error}`);
  }

  for (const name of result.shadowed) {
    console.log(`  ${pc.yellow("!")} ${shadowLine(name)}`);
  }

  const changes = result.added.length + result.removed.length + result.updated.length;

  console.log(`${changes === 0 ? "Global skills are in sync" : "Synced global skills"} with ${result.url}${result.pushed ? " (pushed)" : ""}`);
}

interface Base { cwd: string; store?: string }

export function baseOf(globalOpts: GlobalOpts): Base {
  return { cwd: globalOpts.cwd, ...(globalOpts.store ? { store: globalOpts.store } : {}) };
}

/** A terminal to ask in (and not inside an agent). */
export function canPrompt(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- isTTY is undefined off a TTY
  return !!process.stdin.isTTY && !isRunningInAgent();
}

/** init / update: a repo without a README gets ours; one with a README is replaced only when you
 *  say so (no terminal to ask in: kept). `readme: false` (--no-readme) leaves the README alone. */
export function readmeOptions(readme: boolean | undefined): ReadmeOptions {
  if (readme === false) {
    return { readme: false };
  }

  return {
    confirmReadme: async (files) => {
      if (!canPrompt()) {
        return false;
      }

      const ok = await prompts.confirm({ message: `The repository already has ${files.join(", ")}. Replace it with the Skill Library README?`, initialValue: false });

      return ok === true;
    },
  };
}

/** After a global add/remove/update: push the change to the sync repo (no-op unless sync is enabled). Never fails
 *  the command. */
export async function afterGlobalChange(change: GlobalChange, globalOpts: GlobalOpts): Promise<void> {
  try {
    const res = await recordGlobalChange(
      change,
      { cwd: globalOpts.cwd, ...(globalOpts.store ? { store: globalOpts.store } : {}) },
    );

    if (!res) {
      return;
    }

    for (const name of res.pulled.added) {
      note(`  ${pc.green("+")} ${sanitizeMetadata(name)} (from ${res.url})`);
    }

    for (const name of res.pulled.removed) {
      note(`  ${pc.red("-")} ${sanitizeMetadata(name)} (dropped by ${res.url})`);
    }

    for (const skill of res.shared) {
      note(`Shared ${sanitizeMetadata(skill.name)} across your devices. It now lives in the sync repo; edit it there: ${skill.path}`);
    }

    for (const name of res.shadowed) {
      note(shadowLine(name));
    }

    if (res.errors.length > 0) {
      note(`sync: ${res.errors.join("; ")} (the change is kept locally and pushed on the next sync)`);
    } else if (res.pushed) {
      note(`Synced to ${res.url}`);
    }
  } catch (err) {
    note(`sync: ${msgOf(err)}`);
  }
}
