import { querySkills } from "../core/query.ts";
import { maybeStartBackgroundSync, takeSyncChanges, type SyncChanges } from "../core/sync.ts";
import { resolveStore } from "../lib/paths.ts";
import { CliError, note, sanitizeMetadata } from "../lib/cli.ts";
import { type Ctx, examples, newCommand, numberValue, value, warnUnknownOptions } from "./command.ts";
import type { GlobalOpts } from "./index.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseThreshold(raw: string): number {
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new CliError(1, "--threshold must be a number between 0 and 1");
  return n;
}

function parseTop(raw: string): number {
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new CliError(1, "--top must be a positive integer");
  return n;
}

/** Lines telling the agent what a background sync changed (worded without sync internals), so it can pass it on to the user. */
function syncChangeLines(c: SyncChanges): string[] {
  const list = (names: string[]) => names.map(sanitizeMetadata).join(", ");
  const lines = ["Your skills changed — tell the user:"];
  if (c.added.length > 0) lines.push(`  added: ${list(c.added)}`);
  if (c.removed.length > 0) lines.push(`  removed: ${list(c.removed)}`);
  if (c.updated.length > 0) lines.push(`  updated: ${list(c.updated)}`);
  if (c.shadowed && c.shadowed.length > 0) {
    lines.push(`  now shadowing a skill with the same name: ${list(c.shadowed)} (the user can choose which one to keep)`);
  }
  return lines;
}

/** `query` keeps its own exit codes: 0 ok, 1 usage (incl. invalid agent), 2 runtime. */
export interface QueryOptions {
  json?: boolean;
  agent?: string;
  threshold?: string;
  top?: string;
}

/** `query "<task>" | -`; `pos` are the positionals (one at most). */
export async function runQuery(pos: string[], opts: QueryOptions, g: GlobalOpts): Promise<number> {
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
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.threshold !== undefined ? { threshold: parseThreshold(opts.threshold) } : {}),
    ...(opts.top !== undefined ? { top: parseTop(opts.top) } : {}),
  });
  // Taken only once the query succeeded, so a failed query doesn't swallow them.
  const syncChanges = takeSyncChanges(store);
  if (g.verbose && res.model) note(`verbose: ${JSON.stringify({ model: res.model, usage: res.usage })}`);
  if (res.notInstalled > 0) {
    note(`${res.notInstalled} project skill${res.notInstalled === 1 ? " is" : "s are"} not installed — run skill-library install`);
  }
  if (opts.json) {
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
    const scope = m.scope === "project" ? ", project" : m.scope === "builtin" ? ", built-in" : "";
    lines.push(`${sanitizeMetadata(m.name)} (${label}${scope})`);
    lines.push(`└ ${m.path}`);
    lines.push("");
  }
  process.stdout.write(lines.join("\n") + tail);
  return 0;
}

export function queryCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("query"))
    .summary("Find the skills for a task")
    .description("Find the skills for a task (TypeSafe Jev scoring). Pass the task as one quoted argument, or '-' to read it from stdin.")
    .argument("[task]", 'The task, quoted ("-": read stdin)')
    .option("-a, --agent <agent>", "Your agent id; skips skills meant only for other agents", value)
    .option("--threshold <0..1>", "Minimum probability (default 0.7)", numberValue)
    .option("--top <n>", "Cap the number of matches", numberValue)
    .option("--json", "Output as JSON")
    .addHelpText("after", examples([['skill-library query -a claude-code "fix a failing Next.js build"'], ['echo "dockerize the app" | skill-library query - --json']]))
    .action(async (_task, opts, cmd) => {
      ctx.done(await runQuery(cmd.args, opts, ctx.globals()));
    });
}
