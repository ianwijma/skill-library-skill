import { CliError } from "../lib/cli.ts";

const GATEWAY_HINT = "Run skill-library add <any source> once to install the new gateway.";
const OLD_FLAGS = ["--name", "--description", "--path", "--return-content", "--pretty"];

function hasOldFlag(args: string[]): string | undefined {
  return args.find((a) => OLD_FLAGS.includes(a.split("=")[0]!));
}

/** Refuse pre-0.1 command forms with a pointer to the replacement; changes nothing. */
export function oldCommandGuard(cmd: string, args: string[]): void {
  const flag = hasOldFlag(args);
  if (!flag) return;
  if (cmd === "add" && (flag === "--name" || flag === "--description" || flag === "--path")) {
    throw new CliError(1, `'add ${flag}' is the old command form and is no longer supported.`, `Add a skill folder or file directly: skill-library add <path>\n${GATEWAY_HINT}`);
  }
  if (cmd === "update" && (flag === "--name" || flag === "--description" || flag === "--path")) {
    throw new CliError(1, `'update <id> ${flag}' is the old command form and is no longer supported.`, `Descriptions come from each skill's SKILL.md; to replace content, run skill-library add <path>.\n${GATEWAY_HINT}`);
  }
  if (flag === "--return-content" || flag === "--pretty") {
    throw new CliError(1, `${flag} is no longer supported.`, `query prints the paths to read; use --json for machine-readable output.\n${GATEWAY_HINT}`);
  }
}

export function oldGetCommand(): never {
  throw new CliError(1, "'get <id>' is no longer supported.", `Use skill-library query "<task>" or skill-library list --json to find a skill's path.\n${GATEWAY_HINT}`);
}
