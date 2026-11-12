// `self setup`: check this machine, install or update skill-library (npm -g), install the gateway
// skill into your agents, then run the doctor. Re-running it updates everything.
import pc from "picocolors";
import { CliError } from "../../lib/cli.ts";
import { globalInstall, globalRootWritable, newerRelease, npmGlobalRoot, npmVersion } from "../../lib/release.ts";
import { type Ctx, list, newCommand, warnUnknownOptions } from "../command.ts";
import type { GlobalOpts } from "../index.ts";
import {
  EACCES_URL,
  HANDOFF_ENV,
  apiKeyCheck,
  distTags,
  doctorChecks,
  firstInstallVersion,
  gitCheck,
  gitInstalled,
  handOff,
  installRelease,
  isRunning,
  placeGateway,
  printChecks,
  printGateway,
  printVerdict,
  requestedAgents,
  type Check,
} from "./shared.ts";

export function setupCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("setup"))
    .description(
      "Check this machine, install or update skill-library (npm -g), install the gateway skill into your agents, then run the doctor. Run it again any time: it updates everything. Start here: npx skill-library self setup",
    )
    .option("-a, --agent <agents...>", "Only these agents (default: every agent found on this machine)", list)
    .action(async (opts, cmd) => {
      ctx.done(await runSelfSetup(cmd.args, opts, ctx.globals()));
    });
}

/** `self setup`; `extra` are positionals, which it doesn't take. */
export async function runSelfSetup(extra: string[], opts: { agent?: string[] }, g: GlobalOpts): Promise<number> {
  if (extra.length > 0) throw new CliError(1, `Unexpected argument: ${extra[0]}`, "Usage: skill-library self setup [-a <agents>]");
  const agents = requestedAgents(opts.agent);

  if (process.env[HANDOFF_ENV] !== "1") {
    // 1. Check everything the install needs before touching anything.
    console.log("Checking this machine");
    const root = await npmGlobalRoot();
    const pre = await preflight(root);
    printChecks(pre);
    if (pre.some((c) => c.status === "fail") || !root) {
      console.log();
      console.log("Fix the problems above, then run setup again. Nothing was installed.");
      return 1;
    }
    // 2. Install or update skill-library itself.
    console.log();
    console.log("skill-library");
    const installed = await globalInstall(root);
    const tags = await distTags();
    const target = installed ? newerRelease(installed.version, tags) : firstInstallVersion(tags);
    if (target) {
      console.log(installed ? `  ${pc.yellow("↑")} Updating ${installed.version} → ${target}` : `  ${pc.dim("•")} Installing ${target}`);
      await installRelease(root, target);
    } else if (installed) {
      console.log(`  ${pc.green("✓")} ${installed.version} is installed and the newest release`);
    }
    // The installed copy does the rest, so the gateway skill it writes is its own.
    if (target || !installed || !isRunning(installed.script)) {
      console.log();
      return handOff(root, ["self", "setup", ...(opts.agent ? ["--agent", ...opts.agent] : [])]);
    }
    console.log();
  }

  // 3. The gateway skill, in every agent (or the -a ones).
  console.log("Gateway skill");
  printGateway(await placeGateway(agents, g.cwd));
  // 4. Is everything in place?
  console.log();
  console.log("Health check");
  const checks = await doctorChecks(g.cwd, agents);
  printChecks(checks);
  printVerdict(checks, "skill-library self setup");
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

/** What setup needs before it installs anything. */
async function preflight(root: string | null): Promise<Check[]> {
  const [npm, git] = await Promise.all([npmVersion(), gitInstalled()]);
  const checks: Check[] = [];
  if (!npm || !root) {
    checks.push({ id: "npm", status: "fail", message: "npm is not installed or not on PATH; setup installs skill-library with it", fix: "Install Node.js (which includes npm) from https://nodejs.org" });
  } else if (!(await globalRootWritable(root))) {
    checks.push({ id: "npm", status: "fail", message: `npm can't install globally: ${root} isn't writable by you`, fix: `Point npm at a folder you own, as described in ${EACCES_URL}` });
  } else {
    checks.push({ id: "npm", status: "ok", message: `npm ${npm} can install globally` });
  }
  checks.push(gitCheck(git), apiKeyCheck());
  return checks;
}
