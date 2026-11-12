import { CommanderError } from "@commander-js/extra-typings";
import { CliError, formatError } from "../lib/cli.ts";
import { buildProgram } from "./program.ts";

export interface GlobalOpts {
  cwd: string;
  store?: string;
  verbose: boolean;
}

/** Run the CLI; returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  let code = 0;
  const program = buildProgram(argv, (c) => {
    code = c;
  });
  try {
    await program.parseAsync(argv, { from: "user" });
    return code;
  } catch (err) {
    // Usage errors, --help and --version: commander has already printed what there is to say.
    if (err instanceof CommanderError) return err.exitCode;
    if (err instanceof CliError) {
      console.error(`Error: ${formatError(err)}`);
      return err.exitCode;
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 2;
  }
}
