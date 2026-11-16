// `sync update <git-url>`: move sync to another repository.
import pc from "picocolors";
import { updateSyncUrl } from "../../core/sync.ts";
import { note } from "../../lib/cli.ts";
import { type Ctx, newCommand, warnUnknownOptions } from "../command.ts";
import type { GlobalOpts } from "../index.ts";
import { baseOf, printResult, agentFilesLine, readmeLine, readmeOptions } from "./shared.ts";

export function updateCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("update"))
    .description("Move sync to another repository (pushes everything there)")
    .argument("<git-url>", "The new repository")
    .option("--no-readme", "Leave the repository's README alone (default: add one, or ask before replacing an existing one)")
    .option("--no-agents-md", "Don't add an AGENTS.md (and CLAUDE.md) for crafting skills (default: added when the repository has none)")
    .action(async (url, opts) => {
      ctx.done(await runSyncUpdate(url, opts, ctx.globals()));
    });
}

/** `sync update <git-url>`: move sync to another repository. */
async function runSyncUpdate(
  url: string,
  opts: { readme?: boolean; agentsMd?: boolean },
  globalOpts: GlobalOpts,
): Promise<number> {
  const outcome = await updateSyncUrl(url, { ...baseOf(globalOpts), ...readmeOptions(opts.readme, opts.agentsMd) });

  if (outcome.unchanged) {
    console.log(`Sync already uses ${outcome.url}`);

    return 0;
  }

  const { result, previousUrl, oldPullError, readme, agentFiles } = outcome;

  if (oldPullError) {
    note(`Could not pull from ${previousUrl} first: ${oldPullError} (this machine's skills were moved as they are)`);
  }

  console.log(`Sync moved from ${previousUrl} to ${result.url}`);

  if (readme) {
    console.log(readmeLine(readme));
  }

  if (agentFiles.length > 0) {
    console.log(agentFilesLine(agentFiles));
  }

  printResult(result);
  console.log(`${pc.gray("On your other machines, run")} skill-library sync update ${result.url}`);

  return result.errors.length > 0 ? 1 : 0;
}
