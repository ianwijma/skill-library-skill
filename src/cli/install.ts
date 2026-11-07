import pc from "picocolors";
import { installProject } from "../core/install.ts";
import { CliError, DIM, RESET, formatError } from "../lib/cli.ts";
import { parseFlags } from "./args.ts";
import { showLogo } from "./ui.ts";
import type { GlobalOpts } from "./index.ts";

function inCI(): boolean {
  return ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "TRAVIS", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION"].some((k) => {
    const v = process.env[k];
    return v !== undefined && v !== "" && v !== "0" && v !== "false";
  });
}

export async function runInstall(args: string[], g: GlobalOpts): Promise<number> {
  const f = parseFlags(args, {
    booleans: {
      dryRun: ["--dry-run"],
      force: ["--force"],
      frozen: ["--frozen-lockfile"],
      noFrozen: ["--no-frozen-lockfile"],
      yes: ["-y", "--yes"],
    },
    lists: { agent: ["-a", "--agent"] },
  });
  showLogo();
  const frozen = f.booleans.has("noFrozen") ? false : f.booleans.has("frozen") || inCI();
  try {
    const res = await installProject({
      cwd: g.cwd,
      ...(g.store ? { store: g.store } : {}),
      dryRun: f.booleans.has("dryRun"),
      force: f.booleans.has("force"),
      frozen,
    });
    const todo = res.skills.filter((r) => r.status !== "present" && r.status !== "local");
    if (res.skills.length === 0) {
      console.log(`${DIM}No skills in skill-library.json.${RESET}`);
      return 0;
    }
    console.log(`${DIM}Restoring ${res.skills.length} skill(s) from skill-library.json into the library${RESET}`);
    for (const r of res.skills) {
      const label =
        r.status === "present" || r.status === "local"
          ? `${pc.dim("•")} ${r.id} ${DIM}(${r.status === "local" ? "in this repository" : "already installed"})${RESET}`
          : r.status === "would-install"
            ? `${pc.cyan("→")} Would restore ${r.id}`
            : r.status === "installed" || r.status === "repaired"
              ? `${pc.green("✓")} ${r.status === "repaired" ? "Repaired" : "Installed"} ${r.id}`
              : `${pc.red("✗")} ${r.id}: ${r.message}`;
      console.log(`  ${label}`);
    }
    if (todo.length === 0) console.log(`${DIM}Everything is already installed.${RESET}`);
    return res.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${formatError(err)}`);
      return 1;
    }
    throw err;
  }
}
