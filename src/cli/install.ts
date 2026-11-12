import pc from "picocolors";
import { installProject } from "../core/install.ts";
import { CliError, formatError, warn } from "../lib/cli.ts";
import { showLogo } from "./ui.ts";
import { runAdd, withAddOptions } from "./add.ts";
import { type Ctx, examples, given, jsonOnError, newCommand, warnUnknownOptions } from "./command.ts";
import type { GlobalOpts } from "./index.ts";

function inCI(): boolean {
  return ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "TRAVIS", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION"].some((k) => {
    const v = process.env[k];
    return v !== undefined && v !== "" && v !== "0" && v !== "false";
  });
}

interface InstallOptions {
  dryRun?: boolean;
  force?: boolean;
  /** --frozen-lockfile (true) or --no-frozen-lockfile (false); unset: frozen in CI. */
  frozen?: boolean;
}

/** Source-less `install`: restore skill-library.json into the library. */
async function runInstall(opts: InstallOptions, g: GlobalOpts): Promise<number> {
  showLogo();
  const frozen = opts.frozen ?? inCI();
  try {
    const res = await installProject({
      cwd: g.cwd,
      ...(g.store ? { store: g.store } : {}),
      dryRun: !!opts.dryRun,
      force: !!opts.force,
      frozen,
    });
    const todo = res.skills.filter((r) => r.status !== "present" && r.status !== "local");
    if (res.skills.length === 0) {
      console.log(pc.gray("No skills in skill-library.json."));
      return 0;
    }
    console.log(pc.gray(`Restoring ${res.skills.length} skill(s) from skill-library.json into the library`));
    for (const r of res.skills) {
      const label =
        r.status === "present" || r.status === "local"
          ? `${pc.dim("•")} ${r.id} ${pc.gray(`(${r.status === "local" ? "in this repository" : "already installed"})`)}`
          : r.status === "would-install"
            ? `${pc.cyan("→")} Would restore ${r.id}`
            : r.status === "installed" || r.status === "repaired"
              ? `${pc.green("✓")} ${r.status === "repaired" ? "Repaired" : "Installed"} ${r.id}`
              : `${pc.red("✗")} ${r.id}: ${r.message}`;
      console.log(`  ${label}`);
    }
    if (todo.length === 0) console.log(pc.gray("Everything is already installed."));
    return res.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${formatError(err)}`);
      return 1;
    }
    throw err;
  }
}

export function installCommand(ctx: Ctx) {
  const install = withAddOptions(
    newCommand("install")
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
  const share = given(install, "share", "no-share");
  const frozen = given(install, "frozen-lockfile", "no-frozen-lockfile");
  // Each mode's options are ignored, with a warning, in the other mode (-y and -a are accepted by both).
  const restoreOnly = given(install, "dry-run", "force", "frozen-lockfile", "no-frozen-lockfile");
  const addOnly = given(install, "project", "global", "skill", "list", "all", "full-depth", "json", "copy", "share", "no-share");
  return warnUnknownOptions(jsonOnError(install, ctx)).action(async (_pkg, opts, cmd) => {
    // `experimental_install` (vercel's name for restoring) only ever restores, as before.
    const restoring = cmd.args.length === 0 || cmd.parent?.args[0] === "experimental_install";
    if (!restoring) {
      for (const flag of restoreOnly) warn(`ignoring --${flag}: it only applies to install without a <package>`);
      return ctx.done(await runAdd(cmd.args, { ...opts, shareConflict: share.size === 2 }, ctx.globals()));
    }
    for (const flag of addOnly) warn(`ignoring --${flag}: it only applies to install <package>`);
    // --no-frozen-lockfile wins over --frozen-lockfile, whatever the order.
    const frozenOpt = frozen.has("no-frozen-lockfile") ? false : frozen.has("frozen-lockfile") ? true : undefined;
    ctx.done(await runInstall({ ...(opts.dryRun ? { dryRun: true } : {}), ...(opts.force ? { force: true } : {}), ...(frozenOpt !== undefined ? { frozen: frozenOpt } : {}) }, ctx.globals()));
  });
}
