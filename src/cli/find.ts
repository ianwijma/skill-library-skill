// `find`: skills.sh search, following vercel-labs/skills v1.7.6 src/find.ts (MIT).
// The interactive picker is a simpler clack prompt instead of vercel's raw-mode search box.
import * as p from "@clack/prompts";
import pc from "picocolors";
import { sanitizeMetadata } from "../lib/cli.ts";
import { isRunningInAgent } from "../lib/detect-agent.ts";
import { runAdd } from "./add.ts";
import { type Ctx, examples, newCommand, warnUnknownOptions } from "./command.ts";
import { showLogo } from "./ui.ts";
import type { GlobalOpts } from "./index.ts";

interface SearchSkill {
  name: string;
  slug: string;
  source: string;
  installs: number;
}

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

function apiBase(): string {
  return process.env.SKILLS_API_URL || "https://skills.sh";
}

function formatInstalls(count: number): string {
  if (!count || count <= 0) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${count} install${count === 1 ? "" : "s"}`;
}

async function searchSkills(query: string, owner?: string): Promise<SearchSkill[]> {
  try {
    const url = new URL("/api/search", apiBase());
    url.searchParams.set("q", query);
    if (owner) url.searchParams.set("owner", owner);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { skills?: Array<{ id?: string; slug?: string; name: string; source?: string; installs?: number }> };
    return (data.skills ?? []).map((s) => ({ name: s.name, slug: s.slug ?? s.id ?? "", source: s.source ?? "", installs: s.installs ?? 0 }));
  } catch {
    return [];
  }
}

/** `find [query...]`; `ownerOpt` is --owner's value (true when it was given without one). */
async function runFind(parts: string[], ownerOpt: string | true | undefined, g: GlobalOpts): Promise<number> {
  let owner: string | undefined;
  if (ownerOpt === true) {
    console.error("--owner requires a GitHub owner");
    console.error("Usage: skill-library find <query> [--owner <owner>]");
    return 0;
  }
  if (ownerOpt !== undefined) {
    if (!ownerOpt || !OWNER.test(ownerOpt.trim())) {
      console.error("--owner must be a GitHub owner");
      console.error("Usage: skill-library find <query> [--owner <owner>]");
      return 0;
    }
    owner = ownerOpt.trim().toLowerCase();
  }
  const query = parts.join(" ").trim();

  if (query) {
    const results = await searchSkills(query, owner);
    if (results.length === 0) {
      console.log(pc.gray(`No skills found for "${query}"${owner ? ` from owner "${owner}"` : ""}`));
      return 0;
    }
    console.log(`${pc.gray("Install with")} skill-library add <owner/repo@skill>`);
    console.log();
    for (const s of results) {
      const pkg = s.source || s.slug;
      const installs = formatInstalls(s.installs);
      console.log(`${sanitizeMetadata(pkg)}@${sanitizeMetadata(s.name)}${installs ? ` ${pc.cyan(installs)}` : ""}`);
      console.log(pc.gray(`└ https://skills.sh/${sanitizeMetadata(s.slug)}`));
      console.log();
    }
    return 0;
  }

  if (!process.stdin.isTTY || isRunningInAgent()) {
    console.log(pc.gray("Tip: if running in a coding agent, follow these steps:"));
    console.log(pc.gray("  1) skill-library find [query] [--owner <owner>]"));
    console.log(pc.gray("  2) skill-library add <owner/repo@skill>"));
    console.log();
    console.log(pc.gray("Usage: skill-library find <query> [--owner <owner>]"));
    return 0;
  }

  const text = await p.text({ message: "Search skills", placeholder: "e.g. typescript" });
  if (p.isCancel(text) || !text || String(text).trim().length < 2) {
    console.log(pc.gray("Search cancelled"));
    return 0;
  }
  const results = await searchSkills(String(text).trim(), owner);
  if (results.length === 0) {
    console.log(pc.gray(`No skills found for "${text}"`));
    return 0;
  }
  const picked = await p.select({
    message: "Select a skill to add",
    options: results.slice(0, 20).map((s, i) => ({ value: i, label: `${s.source || s.slug}@${s.name}`, hint: formatInstalls(s.installs) })),
  });
  if (p.isCancel(picked)) {
    console.log(pc.gray("Search cancelled"));
    return 0;
  }
  const s = results[picked as number]!;
  const pkg = s.source || s.slug;
  console.log();
  console.log(`Installing ${pc.bold(s.name)} from ${pc.gray(pkg)}…`);
  console.log();
  return runAdd([pkg], { skill: [s.name] }, g);
}

export function findCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("find"))
    .aliases(["search", "f", "s"])
    .summary("Search for skills")
    .description("Search skills.sh for skills; without a query (on a terminal), search interactively and add one.")
    .argument("[query...]", "What to search for")
    .option("--owner [owner]", "Only repositories from this GitHub owner")
    .addHelpText("after", examples([["skill-library find typescript", "search by keyword"], ["skill-library find react --owner vercel-labs", "only vercel-labs' skills"]]))
    .action(async (query, opts) => {
      showLogo();
      console.log();
      ctx.done(await runFind(query, opts.owner, ctx.globals()));
    });
}
