// `sync enable`: start syncing again.
import { runSync, setSyncEnabled } from "../../core/sync.ts";
import { type Ctx, newCommand, warnUnknownOptions } from "../command.ts";
import type { GlobalOpts } from "../index.ts";
import { baseOf, printResult } from "./shared.ts";

export function enableCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("enable"))
    .description("Start syncing again")
    .action(async () => {
      ctx.done(await runSyncEnable(ctx.globals()));
    });
}

/** `sync enable`: start syncing again, and sync now. */
async function runSyncEnable(globalOpts: GlobalOpts): Promise<number> {
  await setSyncEnabled(true, baseOf(globalOpts));
  console.log("Sync enabled");
  const result = await runSync(baseOf(globalOpts));

  if (result) {
    printResult(result);
  }

  return result && result.errors.length > 0 ? 1 : 0;
}
