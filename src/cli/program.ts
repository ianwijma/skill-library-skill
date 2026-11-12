// The top level of the CLI: global options, the banner, and the commands, each defined in its own
// file (src/cli/<command>.ts, or src/cli/<command>/ for one with subcommands).
import type { CommandUnknownOpts } from "@commander-js/extra-typings";
import { addCommand } from "./add.ts";
import { checkCommand } from "./check.ts";
import { type Ctx, examples, newCommand } from "./command.ts";
import { connectCommand } from "./connect.ts";
import { findCommand } from "./find.ts";
import type { GlobalOpts } from "./index.ts";
import { initCommand } from "./init.ts";
import { installCommand } from "./install.ts";
import { listCommand } from "./list.ts";
import { queryCommand } from "./query.ts";
import { removeCommand } from "./remove.ts";
import { selfCommand } from "./self/index.ts";
import { syncCommand } from "./sync/index.ts";
import { VERSION, showBanner } from "./ui.ts";
import { updateCommand } from "./update.ts";
import { useCommand } from "./use.ts";

/** The whole CLI for one run. `argv` is only read to keep `--json` output whole on a usage error. */
export function buildProgram(argv: string[], done: (code: number) => void): CommandUnknownOpts {
  const program = newCommand("skill-library")
    .usage("<command> [options]")
    .description("A skill library for agents: skills load on demand through one query.")
    .version(VERSION, "-v, --version", "Show the version number")
    .helpCommand("help [command]", "Show help for a command")
    .option("--store <dir>", "Library directory (default ~/.local/share/skill-library; env SKILL_LIBRARY_DIR)")
    .option("--verbose", "Extra diagnostics on stderr")
    .addHelpText(
      "after",
      `${examples([
        ["npx skill-library self setup", "install skill-library and set up your agents"],
        ["skill-library add anthropics/skills", "add to the global library"],
        ["skill-library add anthropics/skills -p", "pin in this project's skill-library.json"],
        ['skill-library query -a claude-code "fix a failing Next.js build"'],
        ["skill-library use vercel-labs/skills@frontend-design | claude"],
        ["skill-library remove web-design", "remove by name"],
        ["skill-library ls -g", "list the whole library"],
        ["skill-library find typescript", "search by keyword"],
        ["skill-library sync init git@bitbucket.org:me/my-skills.git", "sync global skills"],
      ])}\n\nRun skill-library <command> --help for a command's options.\nDiscover more skills at https://skills.sh/`,
    );

  const ctx: Ctx = {
    done,
    argv,
    globals(): GlobalOpts {
      const o = program.opts();
      return { cwd: process.cwd(), ...(o.store !== undefined ? { store: o.store } : {}), verbose: !!o.verbose };
    },
  };

  // No command: the banner. Anything that isn't a command lands here too.
  program.action(() => {
    const [unknown] = program.args;
    if (unknown === undefined) {
      showBanner();
      return done(0);
    }
    console.log(`Unknown command: ${unknown}\nRun skill-library --help for usage.`);
    done(1);
  });

  program.commandsGroup("Manage Skills:");
  program.addCommand(addCommand(ctx)).addCommand(useCommand(ctx)).addCommand(removeCommand(ctx)).addCommand(listCommand(ctx)).addCommand(findCommand(ctx));
  program.commandsGroup("Updates:");
  program.addCommand(updateCommand(ctx)).addCommand(checkCommand(ctx));
  program.commandsGroup("Project:");
  program.addCommand(installCommand(ctx)).addCommand(initCommand(ctx));
  program.commandsGroup("Sync:");
  program.addCommand(syncCommand(ctx));
  program.commandsGroup("skill-library itself:");
  program.addCommand(selfCommand(ctx));
  program.commandsGroup("Add-ons:");
  program.addCommand(queryCommand(ctx));
  program.addCommand(connectCommand(ctx), { hidden: true });
  return program;
}
