import { querySkills } from "../core/query.ts";
import { maybeStartBackgroundSync, takeSyncChanges, type SyncChanges } from "../core/sync.ts";
import { resolveStore } from "../lib/paths.ts";
import { CliError, note, sanitizeMetadata } from "../lib/cli.ts";
import { parseFlags } from "./args.ts";
import type { GlobalOpts } from "./index.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseThreshold(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new CliError(1, "--threshold must be a number between 0 and 1");
  return n;
}

function parseTop(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new CliError(1, "--top must be a positive integer");
  return n;
}

/** Lines telling the agent what a background sync changed, so it can pass it on to the user. */
function syncChangeLines(c: SyncChanges): string[] {
  const list = (names: string[]) => names.map(sanitizeMetadata).join(", ");
  const lines = ["Sync changed your global skills — tell the user:"];
  if (c.added.length > 0) lines.push(`  added: ${list(c.added)}`);
  if (c.removed.length > 0) lines.push(`  removed: ${list(c.removed)}`);
  if (c.updated.length > 0) lines.push(`  updated: ${list(c.updated)}`);
  if (c.shadowed && c.shadowed.length > 0) {
    lines.push(`  now shadowing a skill with the same name: ${list(c.shadowed)} (the user can pick one; see skill-library list -g)`);
  }
  return lines;
}

/** `query` keeps its own exit codes: 0 ok, 1 usage (incl. invalid agent), 2 runtime. */
export async function runQuery(args: string[], g: GlobalOpts): Promise<number> {
  const f = parseFlags(args, {
    booleans: { json: ["--json"] },
    values: { agent: ["-a", "--agent"], threshold: ["--threshold"], top: ["--top"] },
  });
  if (f.missing.length > 0) throw new CliError(1, `${f.missing[0]} requires a value`);
  const pos = f.positionals;
  if (pos.length > 1) throw new CliError(1, `unexpected argument '${pos[1]}' (quote the task text)`);
  let task: string;
  if (pos.length === 1 && pos[0] !== "-") task = pos[0]!;
  else {
    if (process.stdin.isTTY) throw new CliError(1, "task text is empty (pass it as a quoted argument, or pipe via '-')");
    task = await readStdin();
  }
  if (task.trim() === "") throw new CliError(1, "task text is empty");
  const store = resolveStore(g.store);
  const syncNotice = maybeStartBackgroundSync(store);
  if (syncNotice) note(syncNotice);
  const res = await querySkills(task, {
    cwd: g.cwd,
    ...(g.store ? { store: g.store } : {}),
    ...(f.values.has("agent") ? { agent: f.values.get("agent")! } : {}),
    ...(f.values.has("threshold") ? { threshold: parseThreshold(f.values.get("threshold")!) } : {}),
    ...(f.values.has("top") ? { top: parseTop(f.values.get("top")!) } : {}),
  });
  // Taken only once the query succeeded, so a failed query doesn't swallow them.
  const syncChanges = takeSyncChanges(store);
  if (g.verbose && res.model) note(`verbose: ${JSON.stringify({ model: res.model, usage: res.usage })}`);
  if (res.notInstalled > 0) {
    note(`${res.notInstalled} project skill${res.notInstalled === 1 ? " is" : "s are"} not installed — run skill-library install`);
  }
  if (f.booleans.has("json")) {
    console.log(JSON.stringify({ matches: res.matches, ...(syncChanges ? { syncChanges } : {}) }));
    return 0;
  }
  const tail = syncChanges ? ["", ...syncChangeLines(syncChanges), ""].join("\n") : "";
  if (res.matches.length === 0) {
    process.stdout.write(`No matching skills. Continue without one.\n${tail}`);
    return 0;
  }
  const lines = ["Read these skill files before continuing with the task:", ""];
  for (const m of res.matches) {
    const label = m.always ? "always" : `${Math.round(m.probability * 100)}%`;
    lines.push(`${sanitizeMetadata(m.name)} (${label}${m.scope === "project" ? ", project" : ""})`);
    lines.push(`└ ${m.path}`);
    lines.push("");
  }
  process.stdout.write(lines.join("\n") + tail);
  return 0;
}
