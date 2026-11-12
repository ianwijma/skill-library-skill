// `sync share [skills...]`: sync machine-only skills to your other devices.
import * as prompts from "@clack/prompts";
import pc from "picocolors";
import { shareSkills, shareableSkills } from "../../core/sync.ts";
import { sanitizeMetadata } from "../../lib/cli.ts";
import { isRunningInAgent } from "../../lib/detect-agent.ts";
import { type Ctx, newCommand, warnUnknownOptions } from "../command.ts";
import type { GlobalOpts } from "../index.ts";
import { baseOf } from "./shared.ts";

export function shareCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("share"))
    .description("Sync machine-only skills (added from a local folder) to your other devices")
    .argument("[skills...]", "The skills to share (default: asks)")
    .action(async (skills) => {
      ctx.done(await runSyncShare(skills, ctx.globals()));
    });
}

/** `sync share [skills...]`: without names (on a terminal), asks which. */
async function runSyncShare(names: string[], globalOpts: GlobalOpts): Promise<number> {
  const base = baseOf(globalOpts);
  let selectors = names;

  if (selectors.length === 0 && process.stdin.isTTY && !isRunningInAgent()) {
    const candidates = await shareableSkills(base);

    if (candidates.length === 0) {
      console.log("No machine-only global skills to share.");

      return 0;
    }

    const picked = await prompts.multiselect({
      message: "Skills to share across your devices",
      options: candidates.map((candidate) => ({
        value: candidate.id,
        label: candidate.name,
        hint: candidate.description.slice(0, 60),
      })),
      required: true,
    });

    if (prompts.isCancel(picked)) {
      return 0;
    }

    selectors = picked;
  }

  const result = await shareSkills(selectors, base);

  for (const skill of result.shared) {
    console.log(`  ${pc.green("✓")} Shared ${pc.cyan(sanitizeMetadata(skill.name))}`);
    console.log(`    ${pc.gray("edit it here from now on:")} ${skill.path}`);
  }

  for (const error of result.errors) {
    console.log(`  ${pc.red("✗")} ${error}`);
  }

  if (result.pushed) {
    console.log(`Synced to ${result.url}`);
  }

  return result.errors.length > 0 ? 1 : 0;
}
