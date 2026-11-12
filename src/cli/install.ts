import pc from "picocolors";
import { installProject } from "../core/install.ts";
import { CliError, formatError } from "../lib/cli.ts";
import { showLogo } from "./ui.ts";
import type { GlobalOpts } from "./index.ts";

function inCI(): boolean {
  return ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "TRAVIS", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION"].some((k) => {
    const v = process.env[k];
    return v !== undefined && v !== "" && v !== "0" && v !== "false";
  });
}

export interface InstallOptions {
  dryRun?: boolean;
  force?: boolean;
  /** --frozen-lockfile (true) or --no-frozen-lockfile (false); unset: frozen in CI. */
  frozen?: boolean;
}

/** Source-less `install`: restore skill-library.json into the library. */
export async function runInstall(opts: InstallOptions, g: GlobalOpts): Promise<number> {
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
