// The command tree (commander): every command and subcommand, its options and its own help.
// Handlers live in the command files and take parsed options; this file only wires them up.
import { Command, InvalidArgumentError, Option, type CommandUnknownOpts, type OptionValues } from "@commander-js/extra-typings";
import pc from "picocolors";
import { CliError, warn } from "../lib/cli.ts";
import { runAdd } from "./add.ts";
import { runFind } from "./find.ts";
import { runInit } from "./init.ts";
import { runInstall } from "./install.ts";
import { runList } from "./list.ts";
import { runQuery } from "./query.ts";
import { runRemove } from "./remove.ts";
import { runSelfDoctor, runSelfSetup, runSelfUpdate } from "./self.ts";
import { runSyncCommand, type SyncOptions } from "./sync.ts";
import { VERSION, showBanner, showLogo } from "./ui.ts";
import { runUpdate } from "./update.ts";
import { USE_AGENT_IDS, runUse } from "./use.ts";
import type { GlobalOpts } from "./index.ts";

const isOptionLike = (v: string): boolean => v.length > 1 && v.startsWith("-");
/** Commander reads `-a=codex` as -a with the value "=codex". */
const inline = (v: string): string => (v.startsWith("=") ? v.slice(1) : v);

/** A one-value option. An empty or option-like value is a missing value: `--top=` is never 0, and
 *  `--skill --json` never selects a skill called --json. */
function value(raw: string): string {
  const v = inline(raw);
  if (v === "" || isOptionLike(v)) throw new InvalidArgumentError("requires a value");
  return v;
}

/** vercel's list flags (`-s pdf docx`): values up to the next option, repeatable, and
 *  `--agent=a,b` splits on commas. */
function list(raw: string, previous: string[] | undefined): string[] {
  const v = inline(raw);
  const items = isOptionLike(v) ? [] : v.split(",").filter(Boolean);
  if (items.length === 0) throw new InvalidArgumentError("requires a value");
  return [...(previous ?? []), ...items];
}

const HELP_FLAGS = new Set(["-h", "--help"]);

/** Most commands warn about an unknown option and carry on, as vercel's CLI does (`use` rejects them
 *  instead). Commander would treat the arguments after an unknown option as unknown too; here they
 *  stay positionals, and arguments after `--` are positionals whatever they look like. */
function warnUnknownOptions<C extends CommandUnknownOpts>(cmd: C): C {
  cmd.allowUnknownOption();
  const parseOptions = cmd.parseOptions.bind(cmd);
  cmd.parseOptions = (args: string[]) => {
    const parsed = parseOptions(args);
    const operands = [...parsed.operands];
    const unknown: string[] = [];
    for (let i = 0; i < parsed.unknown.length; i++) {
      const arg = parsed.unknown[i]!;
      if (arg === "--") {
        operands.push(...parsed.unknown.slice(i + 1));
        break;
      }
      if (HELP_FLAGS.has(arg)) unknown.push(arg); // commander looks for help among the unknown arguments
      else if (isOptionLike(arg)) warn(`ignoring unknown option ${arg}`);
      else operands.push(arg);
    }
    return { operands, unknown };
  };
  return cmd;
}

/** Which of `flags` (long names, e.g. "no-share") were given: for flag pairs where both given is an
 *  error, or where one wins whatever the order. */
function given(cmd: CommandUnknownOpts, ...flags: string[]): Set<string> {
  const seen = new Set<string>();
  for (const flag of flags) cmd.on(`option:${flag}`, () => seen.add(flag));
  return seen;
}

function examples(rows: Array<[string, string?]>): string {
  const width = Math.max(0, ...rows.filter(([, d]) => d).map(([c]) => c.length));
  const lines = rows.map(([c, d]) => `  ${pc.gray("$")} ${c}${d ? `${" ".repeat(width - c.length + 2)}${pc.gray(`# ${d}`)}` : ""}`);
  return `\n${pc.bold("Examples:")}\n${lines.join("\n")}`;
}

/** add's options; `install <package>` takes them too, without listing them in its help. */
function withAddOptions<A extends unknown[], O extends OptionValues, G extends OptionValues>(cmd: Command<A, O, G>, hidden = false) {
  const opt = <F extends string>(flags: F, description: string) => new Option(flags, description).hideHelp(hidden);
  return cmd
    .addOption(opt("-p, --project", "Pin in this project's skill-library.json (created if missing)"))
    .addOption(opt("-g, --global", "Add to the global library (the default; skips the scope prompt). With a skill-library.json and no prompt (-y, no TTY, agent): pass -p or -g"))
    .addOption(opt("-a, --agent <agents...>", "Agents the skills are for ('*' for all agents; default: all)").argParser(list))
    .addOption(opt("-s, --skill <skills...>", "Skill names to add ('*' for all skills)").argParser(list))
    .addOption(opt("-l, --list", "List the skills in the source without adding them"))
    .addOption(opt("-y, --yes", "Skip confirmation prompts"))
    .addOption(opt("--all", "Shorthand for --skill '*' --agent '*' -y"))
    .addOption(opt("--full-depth", "Search all subdirectories even when a root SKILL.md exists"))
    .addOption(opt("--json", "Output results as JSON (machine-readable, no ANSI codes)"))
    .addOption(opt("--copy", "Accepted for compatibility (skills are always copied into the library)"))
    .addOption(opt("--share", "With sync on: sync a skill from a local folder to your other devices"))
    .addOption(opt("--no-share", "With sync on: keep a skill from a local folder on this machine only (default: asks; machine-only with -y or inside an agent)"));
}

/** The whole CLI for one run. `argv` is only read to keep `--json` output whole on a usage error. */
export function buildProgram(argv: string[], done: (code: number) => void): CommandUnknownOpts {
  const program = new Command()
    .name("skill-library")
    .usage("<command> [options]")
    .description("A skill library for agents: skills load on demand through one query.")
    .version(VERSION, "-v, --version", "Show the version number")
    .helpOption("-h, --help", "Show help")
    .helpCommand("help [command]", "Show help for a command")
    .option("--store <dir>", "Library directory (default ~/.local/share/skill-library; env SKILL_LIBRARY_DIR)")
    .option("--verbose", "Extra diagnostics on stderr");
  // Every setting here is inherited by the commands added after it.
  program
    .configureHelp({
      styleTitle: (title) => pc.bold(title),
      showGlobalOptions: true,
      // Global options are the top-level ones (--store, --verbose, --version), not a parent command's.
      visibleGlobalOptions: (cmd): Option[] => (cmd.parent ? program.options.filter((o) => !o.hidden) : []),
    })
    .exitOverride()
    .allowExcessArguments()
    .showHelpAfterError(pc.gray("Run with --help for usage."))
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
  program.action(() => {
      const [unknown] = program.args;
      if (unknown === undefined) {
        showBanner();
        return done(0);
      }
      console.log(`Unknown command: ${unknown}\nRun skill-library --help for usage.`);
      done(1);
    });

  const g = (): GlobalOpts => {
    const o = program.opts();
    return { cwd: process.cwd(), ...(o.store !== undefined ? { store: o.store } : {}), verbose: !!o.verbose };
  };
  /** With --json, stdout stays one JSON value even when the arguments are wrong. */
  const jsonOnError = <C extends CommandUnknownOpts>(cmd: C): C =>
    cmd.exitOverride((err) => {
      if (err.exitCode !== 0 && argv.includes("--json")) console.log("[]");
      throw err;
    });

  // --- Manage skills ------------------------------------------------------------------------------
  program.commandsGroup("Manage Skills:");

  const add = withAddOptions(
    program
      .command("add")
      .alias("a")
      .summary("Add skills to the library")
      .description("Add skills to the global library, or pin them in this project's skill-library.json with -p.")
      .argument("<package>", "owner/repo, a git URL or a local path (e.g. anthropics/skills, https://github.com/anthropics/skills, ./path/to/skills)"),
  ).addHelpText(
    "after",
    examples([
      ["skill-library add anthropics/skills", "add to the global library"],
      ["skill-library add anthropics/skills -p", "pin in this project's skill-library.json"],
      ["skill-library add anthropics/skills --agent claude-code", "only for Claude Code"],
      ["skill-library add anthropics/skills --skill pdf docx"],
      ["skill-library add anthropics/skills --list", "see what is in it"],
      ["skill-library add anthropics/skills --json -y", "JSON output"],
    ]),
  );
  const addShare = given(add, "share", "no-share");
  warnUnknownOptions(jsonOnError(add)).action(async (_pkg, opts, cmd) => {
    done(await runAdd(cmd.args, { ...opts, shareConflict: addShare.size === 2 }, g()));
  });

  // use never warns-and-continues on an unknown option: it might start an agent with options it didn't understand.
  const use = program.command("use");
  // Keep use's own wording (commander's unknownOption() isn't in its typings).
  (use as unknown as { unknownOption(flag: string): never }).unknownOption = (flag) => use.error(`Unknown option: ${flag}`, { code: "commander.unknownOption" });
  use
    .summary("Generate a prompt for using one skill without adding it")
    .description("Generate a prompt for using one skill without adding it: print it, or start an agent with it.")
    .usage("<source>[@<skill>] [options]")
    .argument("[source]", "owner/repo, a git URL or a local path, optionally with @<skill>")
    .option("-s, --skill <skill>", "The skill to use", value)
    .option("-a, --agent <agent...>", `Start one supported agent interactively (${USE_AGENT_IDS.join(", ")})`, list)
    .option("--full-depth", "Search nested directories, like skill-library add --full-depth")
    .addHelpText(
      "after",
      examples([["skill-library use anthropics/skills@frontend-design | claude"], ["skill-library use anthropics/skills --skill frontend-design --agent claude-code"]]),
    )
    .action(async (_source, opts, cmd) => {
      done(await runUse(cmd.args, opts, g()));
    });

  warnUnknownOptions(program.command("remove"))
    .aliases(["rm", "r"])
    .summary("Remove skills")
    .description(
      "Remove skills from the global library. With -p it only drops this project's reference (the skill stays in the library). " +
        "In a folder with a skill-library.json you are asked which one you mean; without a prompt (-y, no TTY, inside an agent) pass -p or -g. " +
        "Without skill names, an interactive selection menu is shown.",
    )
    .argument("[skills...]", "Skill names or ids to remove")
    .option("-p, --project", "Only drop this project's reference (the skill stays in the library)")
    .option("-g, --global", "Delete from the library itself (the default; skips the scope prompt)")
    .option("-a, --agent <agents...>", "Remove only these agents from the skill's agent list", list)
    .option("-s, --skill <skills...>", "Skills to remove ('*' for all skills)", list)
    .option("-y, --yes", "Skip confirmation prompts")
    .option("--all", "Remove every skill in scope (-y implied). Do not combine with named skills")
    .addHelpText(
      "after",
      examples([
        ["skill-library remove", "interactive selection"],
        ["skill-library remove my-skill", "remove one skill"],
        ["skill-library remove skill1 skill2 -y", "remove several skills"],
        ["skill-library remove -p my-skill", "drop it from this project only"],
        ["skill-library rm --agent claude-code my-skill", "stop offering it to Claude Code"],
        ["skill-library remove --all", "remove every skill"],
      ]),
    )
    .action(async (names, opts) => {
      done(await runRemove(names, opts, g()));
    });

  jsonOnError(warnUnknownOptions(program.command("list")))
    .alias("ls")
    .summary("List skills")
    .description("List the project's skills (with a skill-library.json), or the whole library.")
    .option("-g, --global", "List the whole library (default: the project, if it has a skill-library.json)")
    .option("-a, --agent <agents...>", "Only skills for these agents", list)
    .option("--json", "Output as JSON (machine-readable, no ANSI codes)")
    .addHelpText("after", examples([["skill-library list", "project skills (global without skill-library.json)"], ["skill-library ls -g", "the whole library"], ["skill-library ls --json", "JSON output"]]))
    .action(async (opts) => {
      done(await runList(opts, g()));
    });

  warnUnknownOptions(program.command("find"))
    .aliases(["search", "f", "s"])
    .summary("Search for skills")
    .description("Search skills.sh for skills; without a query (on a terminal), search interactively and add one.")
    .argument("[query...]", "What to search for")
    .option("--owner [owner]", "Only repositories from this GitHub owner")
    .addHelpText("after", examples([["skill-library find typescript", "search by keyword"], ["skill-library find react --owner vercel-labs", "only vercel-labs' skills"]]))
    .action(async (query, opts) => {
      showLogo();
      console.log();
      done(await runFind(query, opts.owner, g()));
    });

  // --- Updates ------------------------------------------------------------------------------------
  program.commandsGroup("Updates:");
  for (const mode of ["update", "check"] as const) {
    const cmd = warnUnknownOptions(program.command(mode));
    if (mode === "update") cmd.alias("upgrade");
    cmd
      .description(mode === "update" ? "Update skills from their source" : "Check for updates without changing anything")
      .argument("[skills...]", `Skills to ${mode} (default: all in scope)`)
      .option("-g, --global", `${mode === "update" ? "Update" : "Check"} global skills only`)
      .option("-p, --project", `${mode === "update" ? "Update" : "Check"} project skills only`)
      .option("-y, --yes", "Skip prompts (scope: project if it has skills, else global)")
      .addHelpText("after", examples([[`skill-library ${mode}`], [`skill-library ${mode} -g`, "global skills only"], [`skill-library ${mode} my-skill`]]))
      .action(async (names, opts) => {
        done(await runUpdate(names, opts, g(), mode));
      });
  }

  // --- Project ------------------------------------------------------------------------------------
  program.commandsGroup("Project:");
  const install = withAddOptions(
    program
      .command("install")
      .aliases(["i", "experimental_install"])
      .summary("Restore skills from skill-library.json")
      .description("Restore the skills in this project's skill-library.json into the library. With a <package>, install is add: see skill-library add --help.")
      .argument("[package]", "Add this package instead (same as skill-library add)")
      .option("--dry-run", "Show what would be restored without installing anything")
      .option("--force", "Re-check installed skills and repair any that changed")
      .option("--frozen-lockfile", "Fail when skill-library.json is missing or empty (default in CI)")
      .option("--no-frozen-lockfile", "Allow an empty skill-library.json in CI"),
    true,
  ).addHelpText("after", examples([["skill-library install", "restore from skill-library.json"], ["skill-library install --dry-run"], ["skill-library install anthropics/skills", "same as add"]]));
  const installShare = given(install, "share", "no-share");
  const frozen = given(install, "frozen-lockfile", "no-frozen-lockfile");
  warnUnknownOptions(jsonOnError(install)).action(async (_pkg, opts, cmd) => {
    if (cmd.args.length > 0) return done(await runAdd(cmd.args, { ...opts, shareConflict: installShare.size === 2 }, g()));
    // --no-frozen-lockfile wins over --frozen-lockfile, whatever the order.
    const frozenOpt = frozen.has("no-frozen-lockfile") ? false : frozen.has("frozen-lockfile") ? true : undefined;
    done(await runInstall({ ...(opts.dryRun ? { dryRun: true } : {}), ...(opts.force ? { force: true } : {}), ...(frozenOpt !== undefined ? { frozen: frozenOpt } : {}) }, g()));
  });

  warnUnknownOptions(program.command("init"))
    .summary("Create a new skill")
    .description("Create a skill: <name>/SKILL.md, or ./SKILL.md without a name.")
    .argument("[name]", "The skill's name (default: this folder's name)")
    .option("--always", "Every query returns this skill, without scoring")
    .addHelpText("after", examples([["skill-library init my-skill"], ["skill-library init house-rules --always", "always returned by query"]]))
    .action((name, opts) => {
      done(runInit(name, opts, g()));
    });

  // --- Sync ---------------------------------------------------------------------------------------
  program.commandsGroup("Sync:");
  const sync = warnUnknownOptions(program.command("sync"))
    .summary("Sync global skills through a git repository")
    .description("Keep your global skills in a git repository (any host, HTTPS or SSH). Without a command: pull, install, update and push now (this also runs on its own from query).")
    .option("--share <skills...>", "With init: folder skills to sync when seeding an empty repository ('*' = all; default: asks, none without a terminal)", list)
    .option("--no-readme", "With init or update: leave the repository's README alone (default: add one, or ask before replacing an existing one)")
    // Internal: query starts `sync --background` to sync quietly.
    .addOption(new Option("--background").hideHelp())
    .addHelpText("after", examples([["skill-library sync init git@bitbucket.org:me/my-skills.git", "start syncing"], ["skill-library sync", "sync now"], ["skill-library sync status"]]))
    .action(async (opts, cmd) => {
      done(await runSyncCommand(cmd.args[0], cmd.args.slice(1), opts, g()));
    });
  // sync reads --share / --no-readme wherever they appear, so a subcommand merges them with its own.
  const syncOpts = (own: SyncOptions): SyncOptions => {
    const parent = sync.opts();
    const share = own.share ?? parent.share;
    return { readme: parent.readme !== false && own.readme !== false, ...(share ? { share } : {}) };
  };
  warnUnknownOptions(sync.command("init"))
    .description("Start syncing global skills with a git repository")
    .argument("<git-url>", "The repository (any host, HTTPS or SSH)")
    .option("--share <skills...>", "Folder skills to sync when seeding an empty repository ('*' = all; default: asks, none without a terminal)", list)
    .option("--no-readme", "Leave the repository's README alone (default: add one, or ask before replacing an existing one)")
    .action(async (url, opts) => {
      done(await runSyncCommand("init", [url], syncOpts(opts), g()));
    });
  warnUnknownOptions(sync.command("update"))
    .description("Move sync to another repository (pushes everything there)")
    .argument("<git-url>", "The new repository")
    .option("--no-readme", "Leave the repository's README alone (default: add one, or ask before replacing an existing one)")
    .action(async (url, opts) => {
      done(await runSyncCommand("update", [url], syncOpts(opts), g()));
    });
  warnUnknownOptions(sync.command("share"))
    .description("Sync machine-only skills (added from a local folder) to your other devices")
    .argument("[skills...]", "The skills to share (default: asks)")
    .action(async (skills) => {
      done(await runSyncCommand("share", skills, syncOpts({}), g()));
    });
  for (const [sub, description] of [
    ["enable", "Start syncing again"],
    ["disable", "Stop syncing (add/remove/update -g stay local)"],
    ["status", "Show the repository, last sync and last error"],
  ] as const) {
    warnUnknownOptions(sync.command(sub))
      .description(description)
      .action(async () => {
        done(await runSyncCommand(sub, [], syncOpts({}), g()));
      });
  }

  // --- skill-library itself -----------------------------------------------------------------------
  program.commandsGroup("skill-library itself:");
  const self = program
    .command("self")
    .usage("<command> [options]")
    .summary("Set up, update and check skill-library itself")
    .description("Commands that look after skill-library itself, rather than your skills.")
    .addHelpText(
      "after",
      `\n${pc.bold("Command options:")}\n` +
        "  setup   -a, --agent <agents...>  Only these agents (default: every agent found on this machine)\n" +
        "  doctor  -a, --agent <agents...>  Check only these agents' gateway skill\n" +
        "          --json                   Output as JSON\n" +
        examples([["npx skill-library self setup", "start here"], ["skill-library self setup -a claude-code codex", "only these agents"], ["skill-library self doctor --json"]]),
    )
    .action((_opts, cmd) => {
      const [sub] = cmd.args;
      if (sub === undefined || sub === "help") {
        cmd.outputHelp();
        return done(0);
      }
      throw new CliError(1, `Unknown self command: ${sub}`, "Run skill-library self for the list.");
    });
  warnUnknownOptions(self.command("setup"))
    .description(
      "Check this machine, install or update skill-library (npm -g), install the gateway skill into your agents, then run the doctor. Run it again any time: it updates everything. Start here: npx skill-library self setup",
    )
    .option("-a, --agent <agents...>", "Only these agents (default: every agent found on this machine)", list)
    .action(async (opts, cmd) => {
      done(await runSelfSetup(cmd.args, opts, g()));
    });
  warnUnknownOptions(self.command("update"))
    .description("Update skill-library (npm -g) and refresh the gateway skill in the agents that already have it")
    .action(async (_opts, cmd) => {
      done(await runSelfUpdate(cmd.args));
    });
  warnUnknownOptions(self.command("doctor"))
    .description("Check that everything skill-library needs is in place; changes nothing. Exit 1 when something needs fixing")
    .option("-a, --agent <agents...>", "Check only these agents' gateway skill", list)
    .option("--json", "Output as JSON")
    .action(async (opts, cmd) => {
      done(await runSelfDoctor(cmd.args, opts, g()));
    });

  // --- Add-ons ------------------------------------------------------------------------------------
  program.commandsGroup("Add-ons:");
  warnUnknownOptions(program.command("query"))
    .summary("Find the skills for a task")
    .description("Find the skills for a task (TypeSafe Jev scoring). Pass the task as one quoted argument, or '-' to read it from stdin.")
    .argument("[task]", 'The task, quoted ("-": read stdin)')
    .option("-a, --agent <agent>", "Your agent id; skips skills meant only for other agents", value)
    .option("--threshold <0..1>", "Minimum probability (default 0.7)", value)
    .option("--top <n>", "Cap the number of matches", value)
    .option("--json", "Output as JSON")
    .addHelpText("after", examples([['skill-library query -a claude-code "fix a failing Next.js build"'], ['echo "dockerize the app" | skill-library query - --json']]))
    .action(async (_task, opts, cmd) => {
      done(await runQuery(cmd.args, opts, g()));
    });

  // Replaced by `self setup`; kept so old instructions get a pointer instead of "unknown command".
  warnUnknownOptions(program.command("connect", { hidden: true })).action(() => {
    console.error("Error: connect was replaced by self setup\nRun skill-library self setup to install the gateway skill into your agents.");
    done(1);
  });

  return program;
}
