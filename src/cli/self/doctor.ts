// `self doctor`: check that everything skill-library needs is in place; changes nothing.
import { CliError } from "../../lib/cli.ts";
import { type Ctx, list, newCommand, warnUnknownOptions } from "../command.ts";
import type { GlobalOpts } from "../index.ts";
import { doctorChecks, printChecks, printVerdict, requestedAgents } from "./shared.ts";

export function doctorCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("doctor"))
    .description("Check that everything skill-library needs is in place; changes nothing. Exit 1 when something needs fixing")
    .option("-a, --agent <agents...>", "Check only these agents' gateway skill", list)
    .option("--json", "Output as JSON")
    .action(async (opts, cmd) => {
      ctx.done(await runSelfDoctor(cmd.args, opts, ctx.globals()));
    });
}

/** `self doctor`; `extra` are positionals, which it doesn't take. */
async function runSelfDoctor(
  extra: string[],
  opts: { agent?: string[]; json?: boolean },
  globalOpts: GlobalOpts,
): Promise<number> {
  if (extra.length > 0) {
    throw new CliError(1, `Unexpected argument: ${extra[0]!}`, "Usage: skill-library self doctor [-a <agents>] [--json]");
  }

  const agents = requestedAgents(opts.agent);
  const checks = await doctorChecks(globalOpts.cwd, agents);
  const ok = !checks.some((check) => check.status === "fail");

  if (opts.json) {
    console.log(JSON.stringify({ checks, ok }, null, 2));

    return ok ? 0 : 1;
  }

  printChecks(checks);
  printVerdict(checks, "skill-library self doctor");

  return ok ? 0 : 1;
}
