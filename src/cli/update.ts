import pc from "picocolors";
import { checkSkills, updateSkills, type UpdateRow } from "../core/update.ts";
import { builtinNote, isBuiltinName } from "../lib/builtin.ts";
import { CliError, formatError, note, sanitizeMetadata } from "../lib/cli.ts";
import { pickAmbiguous } from "./remove.ts";
import { afterGlobalChange } from "./sync/shared.ts";
import { type Ctx, examples, newCommand, warnUnknownOptions } from "./command.ts";
import type { GlobalOpts } from "./index.ts";

interface UpdateOptions {
  global?: boolean;
  project?: boolean;
  /** Accepted; update never prompts for anything but an ambiguous name. */
  yes?: boolean;
}

/** `update` / `check [skills...]`: `names` are the positionals. */
async function runUpdate(names: string[], flags: UpdateOptions, g: GlobalOpts, mode: "update" | "check"): Promise<number> {
  const opts = {
    cwd: g.cwd,
    ...(g.store ? { store: g.store } : {}),
    global: !!flags.global,
    project: !!flags.project,
    skills: names,
    ...(process.stdin.isTTY ? { chooseAmbiguous: pickAmbiguous } : {}),
  };
  try {
    const res = mode === "check" ? await checkSkills(opts) : await updateSkills(opts);
    // Built-in skills ship with skill-library; a library skill with the same name is updated as usual.
    for (const name of names) if (isBuiltinName(name) && !res.skills.some((r) => r.name === name)) note(builtinNote(name));
    const label = res.scopes.map((s) => (s === "global" ? "global" : "project")).join(" and ");
    if (res.skills.length === 0) {
      console.log(pc.gray(`No ${label} skills to ${mode === "check" ? "check" : "update"}.`));
      return 0;
    }
    console.log(pc.gray(`${mode === "check" ? "Checking" : "Updating"} ${label} skills…`));
    const skipped: UpdateRow[] = [];
    for (const r of res.skills) {
      const name = sanitizeMetadata(r.name);
      if (r.status === "has-update") console.log(`  ${pc.yellow("↑")} ${name} has an update`);
      else if (r.status === "updated") console.log(`  ${pc.green("✓")} Updated ${name}${r.from ? ` ${pc.gray(`${r.from} → ${r.to}`)}` : ""}`);
      else if (r.status === "up-to-date") console.log(`  ${pc.dim("•")} ${name} is up to date`);
      else if (r.status === "failed") console.log(`  ${pc.red("✗")} ${name}: ${r.reason}`);
      else skipped.push(r);
    }
    if (skipped.length > 0) {
      console.log();
      console.log(pc.gray("Skipped:"));
      for (const r of skipped) console.log(`  ${sanitizeMetadata(r.name)} ${pc.gray(`(${r.reason})`)}`);
      if (skipped.some((r) => r.reason === "Local path")) {
        console.log(pc.gray("To update a local skill: skill-library add <path>"));
      }
    }
    const failed = res.skills.some((r) => r.status === "failed");
    if (mode === "update" && res.skills.some((r) => r.scope === "global" && r.status === "updated")) await afterGlobalChange({}, g);
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

/** `update` and `check` take the same arguments and options. */
export function updateLikeCommand(ctx: Ctx, mode: "update" | "check") {
  const verb = mode === "update" ? "Update" : "Check";
  return warnUnknownOptions(newCommand(mode))
    .argument("[skills...]", `Skills to ${mode} (default: all in scope)`)
    .option("-g, --global", `${verb} global skills only`)
    .option("-p, --project", `${verb} project skills only`)
    .option("-y, --yes", "Skip prompts (scope: project if it has skills, else global)")
    .addHelpText("after", examples([[`skill-library ${mode}`], [`skill-library ${mode} -g`, "global skills only"], [`skill-library ${mode} my-skill`]]))
    .action(async (names, opts) => {
      ctx.done(await runUpdate(names, opts, ctx.globals(), mode));
    });
}

export function updateCommand(ctx: Ctx) {
  return updateLikeCommand(ctx, "update").alias("upgrade").description("Update skills from their source");
}
