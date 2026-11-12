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
async function runSyncEnable(g: GlobalOpts): Promise<number> {
  await setSyncEnabled(true, baseOf(g));
  console.log("Sync enabled");
  const r = await runSync(baseOf(g));
  if (r) printResult(r);
  return r && r.errors.length > 0 ? 1 : 0;
}
