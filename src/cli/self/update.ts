// `self update`: update skill-library (npm -g) and refresh the gateway skill where it is installed.
import pc from "picocolors";
import { CliError } from "../../lib/cli.ts";
import { GATEWAY_NAME, agentsWithGateway, writeGateway } from "../../lib/gateway.ts";
import { globalInstall, newerRelease, npmGlobalRoot } from "../../lib/release.ts";
import { type Ctx, newCommand, warnUnknownOptions } from "../command.ts";
import { HANDOFF_ENV, distTags, handOff, installRelease, isRunning, printGateway } from "./shared.ts";

export function updateCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("update"))
    .description("Update skill-library (npm -g) and refresh the gateway skill in the agents that already have it")
    .action(async (_opts, cmd) => {
      ctx.done(await runSelfUpdate(cmd.args));
    });
}

/** `self update`; `extra` are positionals, which it doesn't take. */
export async function runSelfUpdate(extra: string[]): Promise<number> {
  if (extra.length > 0) throw new CliError(1, `Unexpected argument: ${extra[0]}`, "Usage: skill-library self update");

  if (process.env[HANDOFF_ENV] !== "1") {
    const root = await npmGlobalRoot();
    if (!root) throw new CliError(2, "npm is not installed or not on PATH", "skill-library self update installs with npm.");
    const installed = await globalInstall(root);
    if (!installed) {
      throw new CliError(1, "skill-library isn't installed with npm -g, so there is nothing to update", "Install it: npx skill-library self setup");
    }
    const target = newerRelease(installed.version, await distTags());
    if (target) {
      console.log(`${pc.yellow("↑")} Updating skill-library ${installed.version} → ${target}`);
      await installRelease(root, target);
    } else {
      console.log(`${pc.green("✓")} skill-library ${installed.version} is the newest release`);
    }
    // The installed copy writes its own gateway skill, so the content always matches its version.
    if (target || !isRunning(installed.script)) return handOff(root, ["self", "update"]);
  }

  const agents = await agentsWithGateway();
  if (agents.length === 0) {
    console.log(`${pc.dim("•")} No agent has the ${GATEWAY_NAME} skill yet. Install it with: skill-library self setup`);
    return 0;
  }
  const result = await writeGateway(agents);
  printGateway(result);
  return result.errors.length > 0 ? 1 : 0;
}
