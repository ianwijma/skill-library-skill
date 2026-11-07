import pc from "picocolors";
import { checkSkills, updateSkills, type UpdateRow } from "../core/update.ts";
import { CliError, DIM, RESET, formatError, sanitizeMetadata } from "../lib/cli.ts";
import { oldCommandGuard } from "./legacy.ts";
import { parseFlags } from "./args.ts";
import type { GlobalOpts } from "./index.ts";

export async function runUpdate(args: string[], g: GlobalOpts, mode: "update" | "check"): Promise<number> {
  if (mode === "update") oldCommandGuard("update", args);
  const f = parseFlags(args, {
    booleans: { global: ["-g", "--global"], project: ["-p", "--project"], yes: ["-y", "--yes"] },
  });
  const opts = {
    cwd: g.cwd,
    ...(g.store ? { store: g.store } : {}),
    global: f.booleans.has("global"),
    project: f.booleans.has("project"),
    skills: f.positionals,
  };
  try {
    const res = mode === "check" ? await checkSkills(opts) : await updateSkills(opts);
    const label = res.scopes.map((s) => (s === "global" ? "global" : "project")).join(" and ");
    if (res.skills.length === 0) {
      console.log(`${DIM}No ${label} skills to ${mode === "check" ? "check" : "update"}.${RESET}`);
      return 0;
    }
    console.log(`${DIM}${mode === "check" ? "Checking" : "Updating"} ${label} skills…${RESET}`);
    const skipped: UpdateRow[] = [];
    for (const r of res.skills) {
      const name = sanitizeMetadata(r.name);
      if (r.status === "has-update") console.log(`  ${pc.yellow("↑")} ${name} has an update`);
      else if (r.status === "updated") console.log(`  ${pc.green("✓")} Updated ${name}${r.from ? ` ${DIM}${r.from} → ${r.to}${RESET}` : ""}`);
      else if (r.status === "up-to-date") console.log(`  ${pc.dim("•")} ${name} is up to date`);
      else if (r.status === "failed") console.log(`  ${pc.red("✗")} ${name}: ${r.reason}`);
      else skipped.push(r);
    }
    if (skipped.length > 0) {
      console.log();
      console.log(`${DIM}Skipped:${RESET}`);
      for (const r of skipped) console.log(`  ${sanitizeMetadata(r.name)} ${DIM}(${r.reason})${RESET}`);
      if (skipped.some((r) => r.reason === "Local path")) {
        console.log(`${DIM}To update a local skill: skill-library add <path>${RESET}`);
      }
    }
    const failed = res.skills.some((r) => r.status === "failed");
    if (mode === "check") {
      const n = res.skills.filter((r) => r.status === "has-update").length;
      console.log();
      console.log(n > 0 ? `${n} skill(s) have updates. Run skill-library update to apply them.` : "All skills are up to date.");
      return n > 0 || failed ? 1 : 0;
    }
    return failed ? 1 : 0;
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${formatError(err)}`);
      return 1;
    }
    throw err;
  }
}
