import { querySkills } from "../core/query.ts";
import { maybeStartBackgroundSync, takeSyncChanges, type SyncChanges } from "../core/sync.ts";
import { resolveStore } from "../lib/paths.ts";
import { CliError, note, sanitizeMetadata } from "../lib/cli.ts";
import { type Ctx, examples, newCommand, numberValue, value, warnUnknownOptions } from "./command.ts";
import type { GlobalOpts } from "./index.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseThreshold(raw: string): number {
  const parsed = raw.trim() === "" ? NaN : Number(raw);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CliError(1, "--threshold must be a number between 0 and 1");
  }

  return parsed;
}

function parseTop(raw: string): number {
  const parsed = raw.trim() === "" ? NaN : Number(raw);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError(1, "--top must be a positive integer");
  }

  return parsed;
}

/** Lines telling the agent what a background sync changed (worded without sync internals), so it can pass it on
 *  to the user. */
function syncChangeLines(changes: SyncChanges): string[] {
  const list = (names: string[]) => names.map(sanitizeMetadata).join(", ");
  const lines = ["Your skills changed — tell the user:"];

  if (changes.added.length > 0) {
    lines.push(`  added: ${list(changes.added)}`);
  }

  if (changes.removed.length > 0) {
    lines.push(`  removed: ${list(changes.removed)}`);
  }

  if (changes.updated.length > 0) {
    lines.push(`  updated: ${list(changes.updated)}`);
  }

  if (changes.shadowed && changes.shadowed.length > 0) {
    lines.push(`  now shadowing a skill with the same name: ${list(changes.shadowed)} (the user can choose which one to keep)`);
  }

  return lines;
}

/** `query` keeps its own exit codes: 0 ok, 1 usage (incl. invalid agent), 2 runtime. */
interface QueryOptions {
  json?: boolean;
  agent?: string;
  threshold?: string;
  top?: string;
}

/** `query "<task>" | -`; `pos` are the positionals (one at most). */
async function runQuery(pos: string[], opts: QueryOptions, globalOpts: GlobalOpts): Promise<number> {
  if (pos.length > 1) {
    throw new CliError(1, `unexpected argument '${pos[1]!}' (quote the task text)`);
  }

  let task: string;

  if (pos.length === 1 && pos[0] !== "-") {
    task = pos[0]!;
  } else {
    if (process.stdin.isTTY) {
      throw new CliError(1, "task text is empty (pass it as a quoted argument, or pipe via '-')");
    }

    task = await readStdin();
  }

  if (task.trim() === "") {
    throw new CliError(1, "task text is empty");
  }

  const store = resolveStore(globalOpts.store);
  const syncNotice = maybeStartBackgroundSync(store);

  if (syncNotice) {
    note(syncNotice);
  }

  const res = await querySkills(task, {
    cwd: globalOpts.cwd,
    ...(globalOpts.store ? { store: globalOpts.store } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.threshold !== undefined ? { threshold: parseThreshold(opts.threshold) } : {}),
    ...(opts.top !== undefined ? { top: parseTop(opts.top) } : {}),
  });
  // Taken only once the query succeeded, so a failed query doesn't swallow them.
  const syncChanges = takeSyncChanges(store);

  if (globalOpts.verbose && res.model) {
    note(`verbose: ${JSON.stringify({ model: res.model, usage: res.usage })}`);
  }

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

  for (const match of res.matches) {
    const label = match.always ? "always" : `${Math.round(match.probability * 100)}%`;
    const scope = match.scope === "project" ? ", project" : match.scope === "builtin" ? ", built-in" : "";

    lines.push(`${sanitizeMetadata(match.name)} (${label}${scope})`);
    lines.push(`└ ${match.path}`);
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
