// `sync init <git-url>`: start syncing global skills with a git repository.
import * as prompts from "@clack/prompts";
import pc from "picocolors";
import { initSync } from "../../core/sync.ts";
import { note, sanitizeMetadata } from "../../lib/cli.ts";
import { placeGateway } from "../../lib/gateway.ts";
import { type Ctx, list, newCommand, warnUnknownOptions } from "../command.ts";
import type { GlobalOpts } from "../index.ts";
import { baseOf, canPrompt, printResult, agentFilesLine, readmeLine, readmeOptions } from "./shared.ts";

export function initCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("init"))
    .description("Start syncing global skills with a git repository")
    .argument("<git-url>", "The repository (any host, HTTPS or SSH)")
    .option("--share <skills...>", "Folder skills to sync when seeding an empty repository ('*' = all; default: asks, none without a terminal)", list)
    .option("--no-readme", "Leave the repository's README alone (default: add one, or ask before replacing an existing one)")
    .option("--no-agents-md", "Don't add an AGENTS.md (and CLAUDE.md) for crafting skills (default: added when the repository has none)")
    .action(async (url, opts) => {
      ctx.done(await runSyncInit(url, opts, ctx.globals()));
    });
}

interface SyncInitOptions {
  /** Folder skills to share when seeding an empty repository ('*' = all). */
  share?: string[];
  /** false for --no-readme. */
  readme?: boolean;
  /** false for --no-agents-md. */
  agentsMd?: boolean;
}

/** `sync init <git-url>`. */
async function runSyncInit(url: string, opts: SyncInitOptions, globalOpts: GlobalOpts): Promise<number> {
  const shareFlag = opts.share;
  const interactive = !shareFlag && canPrompt();
  const outcome = await initSync(url, {
    ...baseOf(globalOpts),
    ...readmeOptions(opts.readme, opts.agentsMd),
    // Only you know which folder skills you wrote (share them) and which are copies (keep them local).
    ...(shareFlag
      ? {
          chooseShare: async (candidates) => candidates
            .filter((candidate) => shareFlag.includes("*") || shareFlag.includes(candidate.name) || shareFlag.includes(candidate.id))
            .map((candidate) => candidate.id),
        }
      : {}),
    ...(interactive
      ? {
          chooseShare: async (candidates) => {
            const picked = await prompts.multiselect({
              message: "Which of your folder skills should sync to your other devices? (copies of other people's skills: add them from their git repo instead)",
              options: candidates.map((candidate) => ({
                value: candidate.id,
                label: candidate.name,
                hint: candidate.description.slice(0, 60),
              })),
              required: false,
            });

            return prompts.isCancel(picked) ? [] : (picked);
          },
        }
      : {}),
  });

  if (outcome.alreadySetUp) {
    console.log(`Sync is already set up with ${outcome.url}. ${pc.gray("Run")} skill-library sync ${pc.gray("to sync now.")}`);

    return 0;
  }

  const { result, seeded, machineOnly, readme, agentFiles } = outcome;
  const gw = await placeGateway();

  if (seeded.length > 0) {
    console.log(pc.gray(`The repository was empty; added this machine's ${seeded.length} global skill(s) to it.`));
  }

  if (machineOnly.length > 0) {
    console.log(`${pc.gray("Kept machine-only (not synced):")} ${machineOnly.map(sanitizeMetadata).join(", ")}`);
    console.log(`${pc.gray("Share one with")} skill-library sync share <name>`);
  }

  if (readme) {
    console.log(readmeLine(readme));
  }

  if (agentFiles.length > 0) {
    console.log(agentFilesLine(agentFiles));
  }

  printResult(result);

  if (gw.updated.length > 0) {
    note(`Updated skill-library gateway for ${gw.updated.join(", ")}`);
  }

  for (const error of gw.errors) {
    note(`gateway: ${error}`);
  }

  console.log(`${pc.gray("Sync runs on its own from now on. Turn it off with")} skill-library sync disable`);

  return result.errors.length > 0 ? 1 : 0;
}
