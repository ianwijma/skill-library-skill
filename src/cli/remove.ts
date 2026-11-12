import * as p from "@clack/prompts";
import pc from "picocolors";
import { removableSkills, removeSkills } from "../core/remove.ts";
import { CliError, formatError, note, sanitizeMetadata } from "../lib/cli.ts";
import { isRunningInAgent } from "../lib/detect-agent.ts";
import { loadProject } from "../lib/manifest.ts";
import { afterGlobalChange } from "./sync.ts";
import type { GlobalOpts } from "./index.ts";

/** TTY picker for a name that matches several skills. */
export async function pickAmbiguous(selector: string, ids: string[]): Promise<string | null> {
  const picked = await p.select({ message: `"${selector}" matches several skills — which one?`, options: ids.map((id) => ({ value: id, label: id })) });
  return p.isCancel(picked) ? null : (picked as string);
}

export interface RemoveOptions {
  global?: boolean;
  project?: boolean;
  yes?: boolean;
  all?: boolean;
  agent?: string[];
  skill?: string[];
}

/** `remove [skills...]`: `names` are the positionals. */
export async function runRemove(names: string[], opts: RemoveOptions, g: GlobalOpts): Promise<number> {
  const all = !!opts.all;
  const yes = !!opts.yes || all || isRunningInAgent();
  let selectors = [...names, ...(opts.skill ?? [])];
  try {
    if (opts.global && opts.project) throw new CliError(1, "--global cannot be combined with --project");
    // Global by default. With a skill-library.json here, ask (or take -p / -g). Without a prompt
    // the scope must be explicit: guessing wrong would delete a skill from the whole library.
    let projectScope = !!opts.project;
    if (!projectScope && !opts.global) {
      const project = await loadProject(g.cwd);
      if (project?.exists) {
        if (yes || !process.stdin.isTTY) {
          throw new CliError(
            1,
            `This folder has a project (${project.file}); say where to remove from.`,
            "Use -p to drop the project's reference, or -g to delete from the global library.",
          );
        }
        const choice = await p.select({
          message: "Remove from",
          options: [
            { value: "global", label: "Global", hint: "delete from the library, every project" },
            { value: "project", label: "Project", hint: `only ${project.file}` },
          ],
        });
        if (p.isCancel(choice)) {
          p.cancel("Removal cancelled");
          return 0;
        }
        projectScope = choice === "project";
      }
    }
    const base = { cwd: g.cwd, ...(g.store ? { store: g.store } : {}), project: projectScope };
    if (all && names.length > 0) {
      throw new CliError(1, "Cannot combine --all with specific skill names.", `Use \`skill-library remove --all\` to remove every skill, or omit --all to remove only the named skills.\n   Example: skill-library remove ${names[0]} -y`);
    }
    if (!all && selectors.length === 0) {
      if (!process.stdin.isTTY) {
        throw new CliError(1, "Interactive prompt required but stdin is not a TTY. Nothing was removed. Name the skills to remove (or use --all) and -y to run non-interactively.");
      }
      const choices = await removableSkills(base);
      if (choices.length === 0) {
        console.log(pc.gray("No skills found to remove."));
        return 0;
      }
      const picked = await p.multiselect({
        message: "Select skills to remove",
        options: choices.map((s) => ({ value: s.id, label: s.name, hint: s.id })),
        required: true,
      });
      if (p.isCancel(picked)) {
        p.cancel("Removal cancelled");
        return 0;
      }
      selectors = picked as string[];
    }
    if (!yes && !process.stdin.isTTY) {
      throw new CliError(1, "Interactive prompt required but stdin is not a TTY. Nothing was removed. Use -y to run non-interactively.");
    }
    if (!yes) {
      const what = all ? "every skill in scope" : selectors.join(", ");
      const ok = await p.confirm({ message: `Remove ${what}${base.project ? " from this project" : " from the library"}?` });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Removal cancelled");
        return 0;
      }
    }
    const res = await removeSkills(all ? [] : selectors, {
      ...base,
      all,
      ...(opts.agent ? { agents: opts.agent } : {}),
      ...(process.stdin.isTTY ? { chooseAmbiguous: pickAmbiguous } : {}),
    });
    for (const n of res.notes) note(n);
    const globalRows = res.removed.filter((r) => r.scope === "global" && r.action !== "kept");
    if (globalRows.length > 0) await afterGlobalChange({ removed: globalRows.filter((r) => r.action === "removed").map((r) => r.id) }, g);
    if (res.unmatched.length > 0 && res.removed.length === 0) {
      console.log(`No matching skills found for: ${res.unmatched.join(", ")}`);
      return 0;
    }
    const done = res.removed.filter((r) => r.action !== "kept");
    for (const r of res.removed) {
      if (r.action === "kept") console.log(`${pc.yellow("!")} ${r.message}`);
      else if (r.action === "agents") console.log(`${pc.green("✓")} Updated agents for ${sanitizeMetadata(r.name)}`);
      else console.log(`${pc.green("✓")} Removed ${sanitizeMetadata(r.name)} ${pc.gray(`(${r.id})`)}`);
      if (r.action !== "kept" && r.message) note(r.message);
    }
    if (done.length > 0) {
      console.log();
      console.log(`Successfully removed ${done.length} skill(s)`);
    }
    console.log("Done!");
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${formatError(err)}`);
      return err.exitCode;
    }
    throw err;
  }
}
