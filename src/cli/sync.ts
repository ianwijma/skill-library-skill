import pc from "picocolors";
import { initSync, recordGlobalChange, runSync, setSyncEnabled, syncStatus, type GlobalChange, type SyncResult } from "../core/sync.ts";
import { CliError, DIM, RESET, formatError, msgOf, note, sanitizeMetadata } from "../lib/cli.ts";
import { placeGateway } from "../lib/gateway.ts";
import { parseFlags } from "./args.ts";
import type { GlobalOpts } from "./index.ts";

const USAGE = "Usage: skill-library sync [init <git-url> | enable | disable | status]";

function printResult(r: SyncResult): void {
  for (const n of r.added) console.log(`  ${pc.green("+")} ${sanitizeMetadata(n)}`);
  for (const n of r.removed) console.log(`  ${pc.red("-")} ${sanitizeMetadata(n)}`);
  for (const n of r.updated) console.log(`  ${pc.green("↑")} ${sanitizeMetadata(n)}`);
  for (const e of r.errors) console.log(`  ${pc.red("✗")} ${e}`);
  const changes = r.added.length + r.removed.length + r.updated.length;
  console.log(`${changes === 0 ? "Global skills are in sync" : "Synced global skills"} with ${r.url}${r.pushed ? " (pushed)" : ""}`);
}

export async function runSyncCommand(args: string[], g: GlobalOpts): Promise<number> {
  const f = parseFlags(args, { booleans: { background: ["--background"], json: ["--json"] } });
  const base = { cwd: g.cwd, ...(g.store ? { store: g.store } : {}) };
  const [sub, ...rest] = f.positionals;
  const json = f.booleans.has("json");
  try {
    switch (sub) {
      case undefined: {
        if (f.booleans.has("background")) {
          // Started by `query`: no output, failures are kept in the status file.
          await runSync({ ...base, background: true }).catch(() => null);
          return 0;
        }
        const r = await runSync(base);
        if (json) console.log(JSON.stringify(r));
        else if (r) printResult(r);
        return r && r.errors.length > 0 ? 1 : 0;
      }
      case "init": {
        const url = rest[0];
        if (!url) throw new CliError(1, "Missing required argument: git-url", "Usage: skill-library sync init <git-url>");
        const { result, seeded } = await initSync(url, base);
        const gw = await placeGateway();
        if (json) {
          console.log(JSON.stringify({ ...result, seeded }));
          return result.errors.length > 0 ? 1 : 0;
        }
        if (seeded.length > 0) console.log(`${DIM}The repository was empty; added this machine's ${seeded.length} global skill(s) to it.${RESET}`);
        printResult(result);
        if (gw.updated.length > 0) note(`Updated skill-library gateway for ${gw.updated.join(", ")}`);
        for (const e of gw.errors) note(`gateway: ${e}`);
        console.log(`${DIM}Sync runs on its own from now on. Turn it off with${RESET} skill-library sync disable`);
        return result.errors.length > 0 ? 1 : 0;
      }
      case "enable": {
        await setSyncEnabled(true, base);
        console.log("Sync enabled");
        const r = await runSync(base);
        if (r) printResult(r);
        return r && r.errors.length > 0 ? 1 : 0;
      }
      case "disable": {
        const cfg = await setSyncEnabled(false, base);
        console.log(`Sync disabled. Nothing is pulled from or pushed to ${cfg.url} until you run skill-library sync enable`);
        return 0;
      }
      case "status": {
        const s = await syncStatus(base);
        if (json) {
          console.log(JSON.stringify(s));
          return 0;
        }
        if (!s.configured) {
          console.log("Sync is not set up. Run skill-library sync init <git-url>");
          return 0;
        }
        console.log(`Repository: ${s.url}`);
        console.log(`Sync:       ${s.enabled ? pc.green("enabled") : pc.yellow("disabled")}`);
        console.log(`Clone:      ${s.clone}`);
        console.log(`Last sync:  ${s.lastSync ?? "never"}`);
        if (s.pending !== undefined && s.pending > 0) console.log(`Unpushed:   ${s.pending} commit(s)`);
        if (s.lastError) console.log(`Last error: ${pc.red(s.lastError)}`);
        return 0;
      }
      default:
        throw new CliError(1, `Unknown sync command: ${sub}`, USAGE);
    }
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${formatError(err)}`);
      return err.exitCode;
    }
    throw err;
  }
}

/** After a global add/remove/update: push the change to the sync repo (no-op unless sync is enabled). Never fails the command. */
export async function afterGlobalChange(change: GlobalChange, g: GlobalOpts): Promise<void> {
  try {
    const res = await recordGlobalChange(change, { cwd: g.cwd, ...(g.store ? { store: g.store } : {}) });
    if (!res) return;
    if (res.errors.length > 0) note(`sync: ${res.errors.join("; ")} (the change is kept locally and pushed on the next sync)`);
    else if (res.pushed) note(`Synced to ${res.url}`);
  } catch (err) {
    note(`sync: ${msgOf(err)}`);
  }
}
