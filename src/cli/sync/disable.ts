// `sync disable`: stop syncing.
import { setSyncEnabled } from "../../core/sync.ts";
import { type Ctx, newCommand, warnUnknownOptions } from "../command.ts";
import type { GlobalOpts } from "../index.ts";
import { baseOf } from "./shared.ts";

export function disableCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("disable"))
    .description("Stop syncing (add/remove/update -g stay local)")
    .action(async () => {
      ctx.done(await runSyncDisable(ctx.globals()));
    });
}

/** `sync disable`. */
async function runSyncDisable(g: GlobalOpts): Promise<number> {
  const cfg = await setSyncEnabled(false, baseOf(g));
  console.log(`Sync disabled. Nothing is pulled from or pushed to ${cfg.url} until you run skill-library sync enable`);
  return 0;
}
