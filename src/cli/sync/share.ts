// `sync share [skills...]`: sync machine-only skills to your other devices.
import * as p from "@clack/prompts";
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
