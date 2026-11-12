// `sync update <git-url>`: move sync to another repository.
import pc from "picocolors";
import { updateSyncUrl } from "../../core/sync.ts";
import { note } from "../../lib/cli.ts";
import { type Ctx, newCommand, warnUnknownOptions } from "../command.ts";
import type { GlobalOpts } from "../index.ts";
import { baseOf, printResult, readmeLine, readmeOptions } from "./shared.ts";

export function updateCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("update"))
    .description("Move sync to another repository (pushes everything there)")
    .argument("<git-url>", "The new repository")
    .option("--no-readme", "Leave the repository's README alone (default: add one, or ask before replacing an existing one)")
    .action(async (url, opts) => {
      ctx.done(await runSyncUpdate(url, opts, ctx.globals()));
    });
}

/** `sync update <git-url>`: move sync to another repository. */
async function runSyncUpdate(url: string, opts: { readme?: boolean }, g: GlobalOpts): Promise<number> {
  const outcome = await updateSyncUrl(url, { ...baseOf(g), ...readmeOptions(opts.readme) });
  if (outcome.unchanged) {
    console.log(`Sync already uses ${outcome.url}`);
    return 0;
  }
  const { result, previousUrl, oldPullError, readme } = outcome;
  if (oldPullError) note(`Could not pull from ${previousUrl} first: ${oldPullError} (this machine's skills were moved as they are)`);
  console.log(`Sync moved from ${previousUrl} to ${result.url}`);
  if (readme) console.log(readmeLine(readme));
  printResult(result);
  console.log(`${pc.gray("On your other machines, run")} skill-library sync update ${result.url}`);
  return result.errors.length > 0 ? 1 : 0;
}
