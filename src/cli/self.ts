// `self`: commands that look after skill-library itself, rather than your skills.
//   self setup    check this machine, install or update skill-library (npm -g), install the gateway skill
//                 into your agents, then run the doctor. Re-running it updates everything.
//   self update   update skill-library (npm -g) and refresh the gateway skill where it is installed
//   self doctor   check that everything skill-library needs is in place; changes nothing
import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import semver from "semver";
import { agentIds, detectInstalledAgents, displayName, globalReadDir } from "../lib/agents.ts";
import { CliError, msgOf } from "../lib/cli.ts";
import { GATEWAY_NAME, agentsWithGateway, gatewayState, writeGateway, type GatewayResult } from "../lib/gateway.ts";
import {
  PACKAGE_NAME,
  checkRelease,
  fetchDistTags,
  globalInstall,
  globalRootWritable,
  newerRelease,
  npmGlobalRoot,
  npmInstallGlobal,
  npmVersion,
  run,
  type GlobalInstall,
} from "../lib/release.ts";
import { validateAgents } from "../core/context.ts";
import { VERSION } from "./ui.ts";
import type { GlobalOpts } from "./index.ts";

export const API_KEY_ENV = "SKILL_LIBRARY_TYPESAFE_API_KEY";
export const API_KEY_URL = "https://console.typesafe.ai/keys";
const EACCES_URL = "https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally";
/** Set on the newly installed copy we hand over to, so it never installs or hands over again. */
const HANDOFF_ENV = "SKILL_LIBRARY_SELF_HANDOFF";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  id: "install" | "release" | "gateway" | "api-key" | "git" | "npm";
  status: CheckStatus;
  message: string;
  fix?: string;
}

// --- doctor ------------------------------------------------------------------------------------

/** `self doctor`; `extra` are positionals, which it doesn't take. */
export async function runSelfDoctor(extra: string[], opts: { agent?: string[]; json?: boolean }, g: GlobalOpts): Promise<number> {
  if (extra.length > 0) throw new CliError(1, `Unexpected argument: ${extra[0]}`, "Usage: skill-library self doctor [-a <agents>] [--json]");
  const agents = requestedAgents(opts.agent);
  const checks = await doctorChecks(g.cwd, agents);
  const ok = !checks.some((c) => c.status === "fail");
  if (opts.json) {
    console.log(JSON.stringify({ checks, ok }, null, 2));
    return ok ? 0 : 1;
  }
  printChecks(checks);
  printVerdict(checks, "skill-library self doctor");
  return ok ? 0 : 1;
}

/** Everything skill-library needs to work, read-only. */
export async function doctorChecks(cwd: string, agents?: string[]): Promise<Check[]> {
  const root = await npmGlobalRoot();
  const installed = await globalInstall(root);
  const [release, gateway, git] = await Promise.all([
    checkRelease(installed?.version ?? VERSION),
    gatewayCheck(cwd, agents),
    gitInstalled(),
  ]);
  const checks: Check[] = [installCheck(installed, root)];
  if (release.updateAvailable) {
    checks.push({ id: "release", status: "warn", message: `skill-library ${release.latest} is available (you have ${release.current})`, fix: installed ? "Run skill-library self update" : "Run npx skill-library self setup" });
  } else if (release.error) {
    checks.push({ id: "release", status: "warn", message: `Couldn't check for a newer release: ${release.error}` });
  } else {
    checks.push({ id: "release", status: "ok", message: `skill-library ${release.current} is the newest release` });
  }
  checks.push(gateway, apiKeyCheck(), gitCheck(git));
  return checks;
}

function installCheck(installed: GlobalInstall | null, root: string | null): Check {
  const onPath = findOnPath(PACKAGE_NAME);
  if (installed && onPath) return { id: "install", status: "ok", message: `skill-library ${installed.version} is installed and on PATH` };
  if (installed) {
    const bin = root ? (process.platform === "win32" ? path.dirname(root) : path.join(path.dirname(path.dirname(root)), "bin")) : "npm's global bin folder";
    return {
      id: "install",
      status: "fail",
      message: "skill-library is installed, but npm's global bin folder isn't on PATH, so your agents can't run it",
      fix: `Add ${bin} to PATH in your shell profile.`,
    };
  }
  if (onPath) {
    return {
      id: "install",
      status: "warn",
      message: `skill-library is on PATH (${onPath}) but wasn't installed with npm -g, so self update can't update it`,
      fix: "To let it, install it with: npx skill-library self setup",
    };
  }
  return { id: "install", status: "fail", message: "skill-library isn't installed", fix: "Install it: npx skill-library self setup" };
}

async function gatewayCheck(cwd: string, requested?: string[]): Promise<Check> {
  const agents = requested ?? (await detectInstalledAgents(cwd)).filter((id) => globalReadDir(id));
  if (agents.length === 0) {
    return { id: "gateway", status: "fail", message: "No agents found on this machine", fix: "Name them with -a, e.g. skill-library self setup -a claude-code" };
  }
  const missing: string[] = [];
  const outdated: string[] = [];
  const current: string[] = [];
  for (const id of agents) {
    const state = await gatewayState(id);
    if (state === "missing") missing.push(displayName(id));
    else if (state === "outdated") outdated.push(displayName(id));
    else if (state === "current") current.push(displayName(id));
  }
  if (missing.length === 0 && outdated.length === 0) {
    return { id: "gateway", status: "ok", message: `The ${GATEWAY_NAME} skill is installed for ${current.join(", ")}` };
  }
  const parts = [
    ...(missing.length > 0 ? [`missing for ${missing.join(", ")}`] : []),
    ...(outdated.length > 0 ? [`outdated for ${outdated.join(", ")}`] : []),
  ];
  return { id: "gateway", status: "fail", message: `The ${GATEWAY_NAME} skill is ${parts.join("; ")}`, fix: "Run skill-library self setup" };
}

function apiKeyCheck(): Check {
  if (process.env[API_KEY_ENV]?.trim()) return { id: "api-key", status: "ok", message: `${API_KEY_ENV} is set` };
  return {
    id: "api-key",
    status: "fail",
    message: `${API_KEY_ENV} is not set; query needs it to match skills to a task`,
    fix: `Create a TypeSafe API key at ${API_KEY_URL}, then add this to your shell profile:\nexport ${API_KEY_ENV}='<your TypeSafe API key>'`,
  };
}

function gitCheck(installed: boolean): Check {
  if (installed) return { id: "git", status: "ok", message: "git is installed" };
  return {
    id: "git",
    status: "fail",
    message: "git is not installed or not on PATH; it's needed to add skills from GitHub or git URLs, and for sync",
    fix: "Install it from https://git-scm.com",
  };
}

function gitInstalled(): Promise<boolean> {
  return new Promise((resolve) => execFile("git", ["--version"], { timeout: 10_000 }, (err) => resolve(!err)));
}

/** The first executable called `name` on PATH, or null. */
function findOnPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".ps1", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return file;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

// --- update ------------------------------------------------------------------------------------

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

// --- setup -------------------------------------------------------------------------------------

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

// --- shared ------------------------------------------------------------------------------------

function requestedAgents(requested: string[] | undefined): string[] | undefined {
  if (!requested || requested.length === 0) return undefined;
  if (requested.includes("*")) throw new CliError(1, "Invalid agents: *", `Name the agents. Valid agents: ${agentIds().join(", ")}`);
  validateAgents(requested);
  const noGlobal = requested.filter((id) => !globalReadDir(id));
  if (noGlobal.length > 0) throw new CliError(1, `${noGlobal.map(displayName).join(", ")} has no global skills folder`);
  return [...new Set(requested)];
}

async function placeGateway(requested: string[] | undefined, cwd: string): Promise<GatewayResult> {
  const agents = requested ?? (await detectInstalledAgents(cwd)).filter((id) => globalReadDir(id));
  if (agents.length === 0) {
    return { updated: [], current: [], errors: ["No agents found on this machine. Name them with -a, e.g. skill-library self setup -a claude-code"] };
  }
  return writeGateway(agents);
}

async function distTags(): Promise<Record<string, unknown>> {
  try {
    return await fetchDistTags();
  } catch (err) {
    throw new CliError(2, `Couldn't check for a newer release: ${msgOf(err)}`);
  }
}

/** With nothing installed yet: this copy's version (it's what `npx` fetched), or newer. */
function firstInstallVersion(tags: Record<string, unknown>): string {
  if (semver.valid(VERSION)) return newerRelease(VERSION, tags) ?? VERSION;
  // A copy without a release version (a dev build) is never a prerelease, so only a stable `latest` will do.
  if (typeof tags.latest === "string" && semver.valid(tags.latest) && !semver.prerelease(tags.latest)) return tags.latest;
  throw new CliError(2, "The npm registry has no stable latest release of skill-library");
}

async function installRelease(root: string, version: string): Promise<void> {
  if (!(await globalRootWritable(root))) {
    throw new CliError(1, `npm can't install globally: ${root} isn't writable by you`, `Point npm at a folder you own, as described in ${EACCES_URL}`);
  }
  console.log(`  ${pc.gray(`$ npm i -g ${PACKAGE_NAME}@${version}`)}`);
  const code = await npmInstallGlobal(version);
  if (code !== 0) throw new CliError(2, `npm i -g ${PACKAGE_NAME}@${version} failed (exit ${code})`, "Its output above says why.");
}

/** Run the globally installed copy with `args`; it skips the install steps. */
async function handOff(root: string, args: string[]): Promise<number> {
  const installed = await globalInstall(root);
  if (!installed) throw new CliError(2, `npm reported success, but skill-library isn't in ${root}`);
  return run(process.execPath, [installed.script, ...args], false, { ...process.env, [HANDOFF_ENV]: "1" });
}

function realpathOr(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function isRunning(script: string): boolean {
  return realpathOr(script) === realpathOr(process.argv[1] ?? "");
}

function icon(status: CheckStatus): string {
  return status === "ok" ? pc.green("✓") : status === "warn" ? pc.yellow("!") : pc.red("✗");
}

function printChecks(checks: Check[]): void {
  for (const c of checks) {
    console.log(`  ${icon(c.status)} ${c.message}`);
    if (c.status !== "ok" && c.fix) for (const line of c.fix.split("\n")) console.log(`    ${line}`);
  }
}

function printVerdict(checks: Check[], rerun: string): void {
  const problems = checks.filter((c) => c.status === "fail").length;
  console.log();
  console.log(problems === 0 ? "All good." : `${problems} problem(s) found. Fix them and run ${rerun} again.`);
}

function printGateway(r: GatewayResult): void {
  if (r.updated.length > 0) console.log(`  ${pc.green("✓")} Installed the ${GATEWAY_NAME} skill for ${r.updated.join(", ")}`);
  if (r.current.length > 0) console.log(`  ${pc.dim("•")} Already up to date for ${r.current.join(", ")}`);
  for (const e of r.errors) console.log(`  ${pc.red("✗")} ${e}`);
  if (r.updated.length > 0) console.log(`  ${pc.gray("Restart your agent so it loads the skill.")}`);
}
