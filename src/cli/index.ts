import { CliError, formatError } from "../lib/cli.ts";
import { runAdd } from "./add.ts";
import { parseFlags } from "./args.ts";
import { runFind } from "./find.ts";
import { runInit } from "./init.ts";
import { runInstall } from "./install.ts";
import { runList } from "./list.ts";
import { runQuery } from "./query.ts";
import { runRemove } from "./remove.ts";
import { runSyncCommand } from "./sync.ts";
import { VERSION, showBanner, showHelp, showLogo, showRemoveHelp } from "./ui.ts";
import { runUpdate } from "./update.ts";
import { runUse } from "./use.ts";

export interface GlobalOpts {
  cwd: string;
  store?: string;
  verbose: boolean;
}

/** Pull our own global flags (--store, --verbose) out of argv, wherever they appear. */
function splitGlobals(argv: string[]): { g: GlobalOpts; rest: string[] } {
  const g: GlobalOpts = { cwd: process.cwd(), verbose: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (a === "--verbose") g.verbose = true;
    else if (a === "--store") {
      const v = argv[++i];
      if (v === undefined) throw new CliError(1, "--store requires a directory");
      g.store = v;
    } else if (a.startsWith("--store=")) g.store = a.slice("--store=".length);
    else rest.push(a);
  }
  return { g, rest };
}

/** `install <source>` adds; source-less `install` restores (list flags consume their values). */
function hasSource(args: string[]): boolean {
  const f = parseFlags(args, { lists: { agent: ["-a", "--agent"], skill: ["-s", "--skill"] }, strict: true });
  return f.positionals.length > 0;
}

/** Run the CLI; returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  let g: GlobalOpts;
  let rest: string[];
  try {
    ({ g, rest } = splitGlobals(argv));
  } catch (err) {
    console.error(`Error: ${formatError(err)}`);
    return 1;
  }
  if (rest.length === 0) {
    showBanner();
    return 0;
  }
  const [command, ...args] = rest as [string, ...string[]];
  if (command !== "--help" && command !== "-h" && command !== "--version" && command !== "-v" && (args.includes("--help") || args.includes("-h"))) {
    if (command === "remove" || command === "rm" || command === "r") showRemoveHelp();
    else if (command === "use") return runUse(["--help"], g);
    else showHelp();
    return 0;
  }
  try {
    switch (command) {
      case "add":
      case "a":
        return await runAdd(args, g);
      case "install":
      case "i":
        if (hasSource(args)) return await runAdd(args, g);
        return await runInstall(args, g);
      case "experimental_install":
        return await runInstall(args, g);
      case "list":
      case "ls":
        return await runList(args, g);
      case "remove":
      case "rm":
      case "r":
        return await runRemove(args, g);
      case "update":
      case "upgrade":
        return await runUpdate(args, g, "update");
      case "check":
        return await runUpdate(args, g, "check");
      case "find":
      case "search":
      case "f":
      case "s":
        showLogo();
        console.log();
        return await runFind(args, g);
      case "init":
        return runInit(args, g);
      case "use":
        return await runUse(args, g);
      case "query":
        return await runQuery(args, g);
      case "sync":
        return await runSyncCommand(args, g);
      case "--help":
      case "-h":
        showHelp();
        return 0;
      case "--version":
      case "-v":
        console.log(VERSION);
        return 0;
      default:
        console.log(`Unknown command: ${command}\nRun skill-library --help for usage.`);
        return 1;
    }
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${formatError(err)}`);
      return err.exitCode;
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 2;
  }
}
