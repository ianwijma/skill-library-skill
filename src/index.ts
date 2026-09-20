import { CliError, type Globals } from "./lib/cli.ts";
import { resolveStore } from "./lib/paths.ts";
import * as query from "./cmd/query.ts";
import * as list from "./cmd/list.ts";
import * as add from "./cmd/add.ts";
import * as update from "./cmd/update.ts";
import * as remove from "./cmd/remove.ts";
import * as get from "./cmd/get.ts";

const VERSION = "0.1.0";

const GLOBAL_STRING_FLAGS = new Set(["store"]);
const GLOBAL_BOOLEAN_FLAGS = new Set(["return-content", "pretty", "verbose", "json", "help", "version"]);

const GENERAL_HELP = `skill-library ${VERSION} — skill library CLI

Usage: skill-library <command> [args] [flags]

Commands:
  query "<task text>"   Score the catalog for a task (Jev); prints matches as JSON
  list                  Print the catalog as JSON (sorted by name)
  add                   Import a skill file: --name --description --path
  update <id>           Update name/description/content: --name --description --path
  remove <id>           Delete a skill; prints the deleted record with content
  get <id>              Print one skill as JSON

Global flags:
  --return-content      Include full skill content in each returned record
  --store <dir>         Store directory (default ~/.local/share/skill-library; env SKILL_LIBRARY_DIR)
  --pretty              Pretty-print JSON (2-space indent)
  --json                No-op: output is always JSON (accepted for compatibility)
  --verbose             Extra diagnostics on stderr (query: token usage)
  --help                Show help (per command too: skill-library <cmd> --help)
  --version             Show version

Exit codes: 0 success · 1 usage/validation error · 2 runtime failure`;

const commands: Record<string, { run: (args: string[], globals: Globals) => Promise<void>; help: string }> = {
  query: { run: query.run, help: query.help },
  list: { run: list.run, help: list.help },
  add: { run: add.run, help: add.help },
  update: { run: update.run, help: update.help },
  remove: { run: remove.run, help: remove.help },
  get: { run: get.run, help: get.help },
};

interface SplitGlobals {
  values: Map<string, string>;
  booleans: Set<string>;
  rest: string[];
}

function splitGlobals(argv: string[]): SplitGlobals {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      for (let j = i; j < argv.length; j++) rest.push(argv[j]!);
      break;
    }
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let inline: string | undefined;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (GLOBAL_STRING_FLAGS.has(name)) {
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined) throw new CliError(1, `flag '--${name}' requires a value`);
      values.set(name, value);
    } else if (GLOBAL_BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) throw new CliError(1, `flag '--${name}' does not take a value`);
      booleans.add(name);
    } else {
      rest.push(arg);
    }
  }
  return { values, booleans, rest };
}

async function main(): Promise<void> {
  const { values, booleans, rest } = splitGlobals(process.argv.slice(2));
  if (booleans.has("version")) {
    console.log(`skill-library ${VERSION}`);
    return;
  }
  const globals: Globals = {
    store: resolveStore(values.get("store")),
    pretty: booleans.has("pretty"),
    returnContent: booleans.has("return-content"),
    verbose: booleans.has("verbose"),
  };

  const [cmd, ...args] = rest;
  if (cmd === undefined) {
    if (booleans.has("help")) {
      console.log(GENERAL_HELP);
      return;
    }
    console.error(`${GENERAL_HELP}\n`);
    throw new CliError(1, "no command given");
  }
  const command = commands[cmd];
  if (!command) throw new CliError(1, `unknown command '${cmd}' (run 'skill-library --help')`);
  if (booleans.has("help")) {
    console.log(command.help);
    return;
  }
  await command.run(args, globals);
}

main().catch((err) => {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}`);
    process.exit(err.exitCode);
  }
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(2);
});
