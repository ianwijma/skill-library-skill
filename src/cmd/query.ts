import { CliError, parseArgs, printJson, warn, type Globals } from "../lib/cli.ts";
import { loadIndex, projection } from "../lib/store.ts";
import { buildRequest, callSystemOne } from "../lib/typesafe.ts";
import type { NoulResponse } from "@typesafe-ai/sdk";

export const help = `skill-library query "<task text>" — score the catalog for a task

One positional: the task description (quote it). Use "-" to read the task
text from stdin (long/multiline descriptions). If both are given, the
positional wins.

Flags:
  --threshold <0..1>   minimum probability to include a match (default 0.7)
  --top <n>            cap the number of matches

Output: {"matches":[{id,name,description,path,probability}...]}

Examples:
  skill-library query "fix a failing Next.js production build"
  skill-library query --threshold 0.8 --top 3 "design a dark dashboard with charts"
  cat task.md | skill-library query -
  skill-library query --return-content "review this PR for accessibility issues"`;

export async function run(args: string[], globals: Globals): Promise<void> {
  const { positionals, values } = parseArgs(args, {
    flags: { threshold: "string", top: "string" },
    maxPositionals: 2,
    positionalHint: "<task text> ('-' for stdin)",
  });
  const task = await taskText(positionals);
  const threshold = values.has("threshold") ? parseThreshold(values.get("threshold")!) : 0.7;
  const top = values.has("top") ? parseTop(values.get("top")!) : undefined;

  const index = await loadIndex(globals.store);
  const candidates = [];
  for (const entry of index) {
    if (entry.description.trim() === "") {
      warn(`skill '${entry.name}' (${entry.id}) has an empty description; excluded from query`);
      continue;
    }
    candidates.push(entry);
  }
  if (candidates.length === 0) {
    printJson({ matches: [] }, globals.pretty);
    return;
  }

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new CliError(2, "TYPESAFE_API_KEY is not set (required for query). Export it and retry.");
  }

  const request = buildRequest(
    task,
    candidates.map((e) => ({ id: e.id, name: e.name, description: e.description })),
  );
  const response = await callSystemOne(request, apiKey);
  if (globals.verbose) {
    console.error(`verbose: ${JSON.stringify({ model: response.model, usage: response.usage })}`);
  }

  const byId = new Map(candidates.map((e) => [e.id, e]));
  const answers = response.answers as Record<string, NoulResponse>;
  const matches: Array<{ id: string; name: string; description: string; path: string; dir: string; probability: number; content?: string }> = [];
  for (const [id, answer] of Object.entries(answers)) {
    const entry = byId.get(id);
    const probability = answer && typeof answer.noul === "number" ? answer.noul : undefined;
    if (!entry || probability === undefined) continue;
    if (probability >= threshold) {
      matches.push({ ...(await projection(entry, globals)), probability });
    }
  }
  matches.sort(
    (a, b) => b.probability - a.probability || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  printJson({ matches: top !== undefined ? matches.slice(0, top) : matches }, globals.pretty);
}

async function taskText(positionals: string[]): Promise<string> {
  if (positionals.length > 0 && positionals[0] !== "-") return clean(positionals[0]!);
  if (positionals.length > 1) throw new CliError(1, "unexpected argument after '-'");
  if (process.stdin.isTTY) {
    throw new CliError(1, "task text is empty (pass it as a quoted argument, or pipe via '-')");
  }
  return clean(await Bun.stdin.text());
}

function clean(raw: string): string {
  const task = raw.trim();
  if (task === "") throw new CliError(1, "task text is empty");
  return task;
}

function parseThreshold(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new CliError(1, "--threshold must be a number between 0 and 1");
  }
  return n;
}

function parseTop(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError(1, "--top must be a positive integer");
  }
  return n;
}
