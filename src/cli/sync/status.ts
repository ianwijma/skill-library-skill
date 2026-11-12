// `sync status`: the repository, last sync and last error.
import pc from "picocolors";
import { syncStatus } from "../../core/sync.ts";
import { formatTimestamp } from "../../lib/time.ts";
import { type Ctx, newCommand, warnUnknownOptions } from "../command.ts";
import type { GlobalOpts } from "../index.ts";
import { baseOf } from "./shared.ts";

export function statusCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("status"))
    .description("Show the repository, last sync and last error")
    .action(async () => {
      ctx.done(await runSyncStatus(ctx.globals()));
    });
}

/** `sync status`. */
async function runSyncStatus(g: GlobalOpts): Promise<number> {
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
