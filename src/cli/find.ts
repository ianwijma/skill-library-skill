// `find`: skills.sh search, following vercel-labs/skills v1.7.6 src/find.ts (MIT).
// The interactive picker is a simpler clack prompt instead of vercel's raw-mode search box.
import * as p from "@clack/prompts";
import { BOLD, CYAN, DIM, RESET, TEXT, sanitizeMetadata } from "../lib/cli.ts";
import { isRunningInAgent } from "../lib/detect-agent.ts";
import { runAdd } from "./add.ts";
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

export async function searchSkills(query: string, owner?: string): Promise<SearchSkill[]> {
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

export async function runFind(args: string[], g: GlobalOpts): Promise<number> {
  const parts: string[] = [];
  let owner: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    let value: string | undefined;
    if (a === "--owner") {
      value = args[i + 1];
      if (!value || value.startsWith("-")) {
        console.error("--owner requires a GitHub owner");
        console.error("Usage: skill-library find <query> [--owner <owner>]");
        return 0;
      }
      i++;
    } else if (a.startsWith("--owner=")) value = a.slice("--owner=".length);
    else {
      parts.push(a);
      continue;
    }
    if (!value || !OWNER.test(value.trim())) {
      console.error("--owner must be a GitHub owner");
      console.error("Usage: skill-library find <query> [--owner <owner>]");
      return 0;
    }
    owner = value.trim().toLowerCase();
  }
  const query = parts.join(" ").trim();

  if (query) {
    const results = await searchSkills(query, owner);
    if (results.length === 0) {
      console.log(`${DIM}No skills found for "${query}"${owner ? ` from owner "${owner}"` : ""}${RESET}`);
      return 0;
    }
    console.log(`${DIM}Install with${RESET} skill-library add <owner/repo@skill>`);
    console.log();
    for (const s of results) {
      const pkg = s.source || s.slug;
      const installs = formatInstalls(s.installs);
      console.log(`${TEXT}${sanitizeMetadata(pkg)}@${sanitizeMetadata(s.name)}${RESET}${installs ? ` ${CYAN}${installs}${RESET}` : ""}`);
      console.log(`${DIM}└ https://skills.sh/${sanitizeMetadata(s.slug)}${RESET}`);
      console.log();
    }
    return 0;
  }

  if (!process.stdin.isTTY || isRunningInAgent()) {
    console.log(`${DIM}Tip: if running in a coding agent, follow these steps:${RESET}`);
    console.log(`${DIM}  1) skill-library find [query] [--owner <owner>]${RESET}`);
    console.log(`${DIM}  2) skill-library add <owner/repo@skill>${RESET}`);
    console.log();
    console.log(`${DIM}Usage: skill-library find <query> [--owner <owner>]${RESET}`);
    return 0;
  }

  const text = await p.text({ message: "Search skills", placeholder: "e.g. typescript" });
  if (p.isCancel(text) || !text || String(text).trim().length < 2) {
    console.log(`${DIM}Search cancelled${RESET}`);
    return 0;
  }
  const results = await searchSkills(String(text).trim(), owner);
  if (results.length === 0) {
    console.log(`${DIM}No skills found for "${text}"${RESET}`);
    return 0;
  }
  const picked = await p.select({
    message: "Select a skill to add",
    options: results.slice(0, 20).map((s, i) => ({ value: i, label: `${s.source || s.slug}@${s.name}`, hint: formatInstalls(s.installs) })),
  });
  if (p.isCancel(picked)) {
    console.log(`${DIM}Search cancelled${RESET}`);
    return 0;
  }
  const s = results[picked as number]!;
  const pkg = s.source || s.slug;
  console.log();
  console.log(`${TEXT}Installing ${BOLD}${s.name}${RESET} from ${DIM}${pkg}${RESET}…`);
  console.log();
  return runAdd([pkg, "--skill", s.name], g);
}
