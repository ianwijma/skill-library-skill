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
async function runSyncStatus(globalOpts: GlobalOpts): Promise<number> {
  const status = await syncStatus(baseOf(globalOpts));

  if (!status.configured) {
    console.log("Sync is not set up. Run skill-library sync init <git-url>");

    return 0;
  }

  console.log(`Repository: ${String(status.url)}`);
  console.log(`Sync:       ${status.enabled ? pc.green("enabled") : pc.yellow("disabled")}`);
  console.log(`Clone:      ${String(status.clone)}`);
  console.log(`Last sync:  ${status.lastSync ? formatTimestamp(status.lastSync) : "never"}`);

  if (status.pending !== undefined && status.pending > 0) {
    console.log(`Unpushed:   ${status.pending} commit(s)`);
  }

  if (status.lastError) {
    console.log(`Last error: ${pc.red(status.lastError)}`);
  }

  return 0;
}
