// `sync`: keep global skills in a git repository. Each subcommand has its own file and options;
// plain `sync` (sync now) only has the internal --background, which query uses for a quiet sync.
import { Option } from "@commander-js/extra-typings";
import pc from "picocolors";
import { runSync } from "../../core/sync.ts";
import { CliError } from "../../lib/cli.ts";
import { type Ctx, examples, newCommand, withSubcommands } from "../command.ts";
import type { GlobalOpts } from "../index.ts";
import { disableCommand } from "./disable.ts";
import { enableCommand } from "./enable.ts";
import { initCommand } from "./init.ts";
import { shareCommand } from "./share.ts";
import { SYNC_USAGE, baseOf, printResult } from "./shared.ts";
import { statusCommand } from "./status.ts";
import { updateCommand } from "./update.ts";

export function syncCommand(ctx: Ctx) {
  const sync = newCommand("sync")
    .summary("Sync global skills through a git repository")
    .description("Keep your global skills in a git repository (any host, HTTPS or SSH). Without a command: pull, install, update and push now (this also runs on its own from query).")
    .addOption(new Option("--background").hideHelp())
    .addHelpText(
      "after",
      `\n${pc.bold("Command options:")}\n` +
        "  init    --share <skills...>  Folder skills to sync when seeding an empty repository ('*' = all)\n" +
        "          --no-readme          Leave the repository's README alone\n" +
        "  update  --no-readme          Leave the repository's README alone\n" +
        examples([["skill-library sync init git@bitbucket.org:me/my-skills.git", "start syncing"], ["skill-library sync", "sync now"], ["skill-library sync status"]]),
    )
    .addCommand(initCommand(ctx))
    .addCommand(updateCommand(ctx))
    .addCommand(shareCommand(ctx))
    .addCommand(enableCommand(ctx))
    .addCommand(disableCommand(ctx))
    .addCommand(statusCommand(ctx));
  withSubcommands(sync, ctx, (rest) => {
    if (rest[0] === "help") {
      sync.outputHelp();
      return 0;
    }
    if (rest.length > 0) throw new CliError(1, `Unknown sync command: ${rest[0]}`, SYNC_USAGE);
    return runSyncNow(sync.opts(), ctx.globals());
  });
  return sync;
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
