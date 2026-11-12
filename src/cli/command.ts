// What every command file shares: the base command (help layout, error handling), option value
// checkers, the unknown-option warning and help examples. Each command lives in its own file
// (src/cli/<command>.ts, or src/cli/<command>/<subcommand>.ts) and program.ts assembles them.
import { Command, InvalidArgumentError, type CommandUnknownOpts, type Option } from "@commander-js/extra-typings";
import pc from "picocolors";
import { warn } from "../lib/cli.ts";
import type { GlobalOpts } from "./index.ts";

/** What a command needs from the run it is part of. */
export interface Ctx {
  /** Set the process exit code (actions can't return one through commander). */
  done(code: number): void;
  /** --store / --verbose and the working directory. */
  globals(): GlobalOpts;
  /** The raw arguments (only read to keep --json output whole on a usage error). */
  argv: string[];
}

/** A command with the settings every command shares. Commander only copies these from the parent
 *  for `.command()`, not for `.addCommand()`, so every command file starts from here. */
export function newCommand(name: string) {
  return new Command(name)
    .helpOption("-h, --help", "Show help")
    .configureHelp({
      styleTitle: (title) => pc.bold(title),
      showGlobalOptions: true,
      // Global options are the top-level ones (--store, --verbose, --version), not a parent command's.
      visibleGlobalOptions: (cmd): Option[] => {
        if (!cmd.parent) return [];
        let root = cmd;
        while (root.parent) root = root.parent;
        return root.options.filter((o) => !o.hidden);
      },
    })
    .exitOverride()
    .allowExcessArguments()
    .showHelpAfterError(pc.gray("Run with --help for usage."));
}

export const isOptionLike = (v: string): boolean => v.length > 1 && v.startsWith("-");
/** Commander reads `-a=codex` as -a with the value "=codex". */
const inline = (v: string): string => (v.startsWith("=") ? v.slice(1) : v);

/** A one-value option. An empty or option-like value is a missing value: `--skill=` and
 *  `--skill --json` never select a skill. */
export function value(raw: string): string {
  const v = inline(raw);
  if (v === "" || isOptionLike(v)) throw new InvalidArgumentError("requires a value");
  return v;
}

/** A number option (query's --threshold / --top): only an empty value is a missing value; a
 *  negative number such as `--threshold=-0.1` reaches the command's own range check. */
export function numberValue(raw: string): string {
  const v = inline(raw);
  if (v === "") throw new InvalidArgumentError("requires a value");
  return v;
}

/** vercel's list flags (`-s pdf docx`): values up to the next option, repeatable, and
 *  `--agent=a,b` splits on commas. */
export function list(raw: string, previous: string[] | undefined): string[] {
  const v = inline(raw);
  const items = isOptionLike(v) ? [] : v.split(",").filter(Boolean);
  if (items.length === 0) throw new InvalidArgumentError("requires a value");
  return [...(previous ?? []), ...items];
}

const HELP_FLAGS = new Set(["-h", "--help"]);

/** Most commands warn about an unknown option and carry on, as vercel's CLI does (`use` rejects them
 *  instead). Commander would treat the arguments after an unknown option as unknown too; here they
 *  stay positionals, and arguments after `--` are positionals whatever they look like. */
export function warnUnknownOptions<C extends CommandUnknownOpts>(cmd: C): C {
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

/** For a command with subcommands (sync, self): options it doesn't know are left for the
 *  subcommand to parse, so each subcommand owns its options. Its own action only runs when no
 *  subcommand was named; `run` then gets the leftover positionals, after a warning for each
 *  unknown option. A subcommand named after an unknown option (`sync --bogus status`) still runs. */
export function withSubcommands(cmd: CommandUnknownOpts, ctx: Ctx, run: (rest: string[]) => Promise<number> | number): void {
  cmd.allowUnknownOption();
  cmd.action(async () => {
    const args = cmd.args;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--") {
        rest.push(...args.slice(i + 1));
        break;
      }
      if (isOptionLike(arg)) {
        warn(`ignoring unknown option ${arg}`);
        continue;
      }
      const sub = rest.length === 0 ? cmd.commands.find((c) => c.name() === arg || c.aliases().includes(arg)) : undefined;
      if (sub) {
        await sub.parseAsync(args.slice(i + 1), { from: "user" });
        return;
      }
      rest.push(arg);
    }
    ctx.done(await run(rest));
  });
}

/** With --json, stdout stays one JSON value even when the arguments are wrong. */
export function jsonOnError<C extends CommandUnknownOpts>(cmd: C, ctx: Ctx): C {
  return cmd.exitOverride((err) => {
    if (err.exitCode !== 0 && ctx.argv.includes("--json")) console.log("[]");
    throw err;
  });
}

/** Which of `flags` (long names, e.g. "no-share") were given: for flag pairs where both given is an
 *  error, or where one wins whatever the order. */
export function given(cmd: CommandUnknownOpts, ...flags: string[]): Set<string> {
  const seen = new Set<string>();
  for (const flag of flags) cmd.on(`option:${flag}`, () => seen.add(flag));
  return seen;
}

/** An "Examples:" help section. */
export function examples(rows: Array<[string, string?]>): string {
  const width = Math.max(0, ...rows.filter(([, d]) => d).map(([c]) => c.length));
  const lines = rows.map(([c, d]) => `  ${pc.gray("$")} ${c}${d ? `${" ".repeat(width - c.length + 2)}${pc.gray(`# ${d}`)}` : ""}`);
  return `\n${pc.bold("Examples:")}\n${lines.join("\n")}`;
}
