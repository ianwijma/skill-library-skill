import * as p from "@clack/prompts";
import pc from "picocolors";
import { removableSkills, removeSkills } from "../core/remove.ts";
import { CliError, DIM, RESET, formatError, note, sanitizeMetadata } from "../lib/cli.ts";
import { isRunningInAgent } from "../lib/detect-agent.ts";
import { parseFlags } from "./args.ts";
import type { GlobalOpts } from "./index.ts";

export async function runRemove(args: string[], g: GlobalOpts): Promise<number> {
  const f = parseFlags(args, {
    booleans: { global: ["-g", "--global"], yes: ["-y", "--yes"], all: ["--all"] },
    lists: { agent: ["-a", "--agent"], skill: ["-s", "--skill"] },
  });
  const base = { cwd: g.cwd, ...(g.store ? { store: g.store } : {}), global: f.booleans.has("global") };
  const all = f.booleans.has("all");
  const yes = f.booleans.has("yes") || all || isRunningInAgent();
  let selectors = [...f.positionals, ...(f.lists.get("skill") ?? [])];
  try {
    if (all && f.positionals.length > 0) {
      throw new CliError(1, "Cannot combine --all with specific skill names.", `Use \`skill-library remove --all\` to remove every skill, or omit --all to remove only the named skills.\n   Example: skill-library remove ${f.positionals[0]} -y`);
    }
    if (!all && selectors.length === 0) {
      if (!process.stdin.isTTY) {
        throw new CliError(1, "Interactive prompt required but stdin is not a TTY. Nothing was removed. Name the skills to remove (or use --all) and -y to run non-interactively.");
      }
      const choices = await removableSkills(base);
      if (choices.length === 0) {
        console.log(`${DIM}No skills found to remove.${RESET}`);
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
    if (!yes && process.stdin.isTTY) {
      const what = all ? "every skill in scope" : selectors.join(", ");
      const ok = await p.confirm({ message: `Remove ${what}${base.global ? " from the library" : " from this project"}?` });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Removal cancelled");
        return 0;
      }
    }
    const res = await removeSkills(all ? [] : selectors, { ...base, all, ...(f.lists.get("agent") ? { agents: f.lists.get("agent")! } : {}) });
    for (const n of res.notes) note(n);
    if (res.unmatched.length > 0 && res.removed.length === 0) {
      console.log(`No matching skills found for: ${res.unmatched.join(", ")}`);
      return 0;
    }
    const done = res.removed.filter((r) => r.action !== "kept");
    for (const r of res.removed) {
      if (r.action === "kept") console.log(`${pc.yellow("!")} ${r.message}`);
      else if (r.action === "agents") console.log(`${pc.green("✓")} Updated agents for ${sanitizeMetadata(r.name)}`);
      else console.log(`${pc.green("✓")} Removed ${sanitizeMetadata(r.name)} ${DIM}(${r.id})${RESET}`);
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
