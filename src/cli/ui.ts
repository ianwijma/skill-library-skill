import { readFileSync } from "node:fs";
import { BOLD, DIM, RESET, TEXT } from "../lib/cli.ts";
import { isRunningInAgent } from "../lib/detect-agent.ts";

/** Replaced with package.json's version by scripts/build.mjs; unset when running from src. */
declare const __SKILL_LIBRARY_VERSION__: string | undefined;

export const VERSION: string =
  typeof __SKILL_LIBRARY_VERSION__ === "string"
    ? __SKILL_LIBRARY_VERSION__
    : JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const LOGO_LINES = [
  "┌─┐┬┌─┬┬  ┬    ┬  ┬┌┐ ┬─┐┌─┐┬─┐┬ ┬",
  "└─┐├┴┐││  │    │  │├┴┐├┬┘├─┤├┬┘└┬┘",
  "└─┘┴ ┴┴┴─┘┴─┘  ┴─┘┴└─┘┴└─┴ ┴┴└─ ┴ ",
];
const GRAYS = ["\x1b[38;5;250m", "\x1b[38;5;245m", "\x1b[38;5;240m"];

/** Logo only on a TTY and never inside an agent (vercel hides it there too). */
export function logoAllowed(): boolean {
  return !!process.stdout.isTTY && !isRunningInAgent();
}

export function showLogo(): void {
  if (!logoAllowed()) return;
  console.log();
  LOGO_LINES.forEach((line, i) => console.log(`${GRAYS[i]}${line}${RESET}`));
}

export function showBanner(): void {
  if (logoAllowed()) {
    showLogo();
    console.log();
    console.log(`${DIM}A skill library for agents — skills load on demand through one query${RESET}`);
    console.log();
  }
  const row = (cmd: string, arg: string, desc: string) =>
    console.log(`  ${DIM}$${RESET} ${TEXT}skill-library ${cmd}${arg ? ` ${DIM}${arg}` : ""}${RESET}${" ".repeat(Math.max(1, 30 - cmd.length - (arg ? arg.length + 1 : 0)))}${DIM}${desc}${RESET}`);
  row("connect", "", "Teach your agents to use the library");
  row("add", "<package>", "Add a skill to the library");
  row("query", '"<task>"', "Find the skills for a task");
  row("use", "<package>@<skill>", "Use a skill without adding it");
  row("remove", "", "Remove skills");
  row("list", "", "List skills");
  row("find", "[query]", "Search for skills");
  console.log();
  row("update", "", "Update skills");
  console.log();
  row("install", "", "Restore from skill-library.json");
  row("sync", "init <git-url>", "Sync global skills through a git repo");
  row("init", "[name]", "Create a new skill");
  console.log();
  console.log(`${DIM}try:${RESET} skill-library add anthropics/skills`);
  console.log();
  console.log(`Discover more skills at ${TEXT}https://skills.sh/${RESET}`);
  console.log();
}

export function showHelp(): void {
  const examples: Array<[string, string?]> = [
    ["skill-library connect", "install the gateway skill into your agents"],
    ["skill-library connect -a claude-code codex", "only these agents"],
    ["skill-library add anthropics/skills", "add to the global library"],
    ["skill-library add anthropics/skills -p", "pin in this project's skill-library.json"],
    ["skill-library add anthropics/skills --agent claude-code", "only for Claude Code"],
    ["skill-library add anthropics/skills --skill pdf docx"],
    ["skill-library add anthropics/skills --json -y", "JSON output"],
    ['skill-library query -a claude-code "fix a failing Next.js build"'],
    ["skill-library use vercel-labs/skills@frontend-design | claude"],
    ["skill-library remove web-design", "remove by name"],
    ["skill-library rm --global frontend-design"],
    ["skill-library remove -p frontend-design", "drop it from this project only"],
    ["skill-library list", "project skills (global without skill-library.json)"],
    ["skill-library ls -g", "list the whole library"],
    ["skill-library ls --json", "JSON output"],
    ["skill-library find typescript", "search by keyword"],
    ["skill-library update"],
    ["skill-library check -g"],
    ["skill-library install", "restore from skill-library.json"],
    ["skill-library init my-skill"],
    ["skill-library sync init git@bitbucket.org:me/my-skills.git", "sync global skills"],
  ];
  const width = Math.max(...examples.filter(([, d]) => d).map(([c]) => c.length));
  const formatted = examples
    .map(([c, d]) => `  ${DIM}$${RESET} ${c}${d ? `${" ".repeat(width - c.length + 2)}${DIM}# ${d}${RESET}` : ""}`)
    .join("\n");
  console.log(`
${BOLD}Usage:${RESET} skill-library <command> [options]

${BOLD}Manage Skills:${RESET}
  add <package>        Add skills to the library (alias: a, install <package>, i <package>)
                       e.g. anthropics/skills
                            https://github.com/anthropics/skills
                            ./path/to/skills
  use <package>@<skill>
                       Generate a prompt for using one skill without adding it
  remove [skills]      Remove skills (alias: rm, r)
  list, ls             List skills
  find [query]         Search for skills (alias: search, f, s)

${BOLD}Find Options:${RESET}
  --owner <owner>        Search only repositories from a GitHub owner

${BOLD}Updates:${RESET}
  update [skills...]   Update skills from their source (alias: upgrade)
  check [skills...]    Check for updates without changing anything

${BOLD}Update Options:${RESET}
  -g, --global           Update global skills only
  -p, --project          Update project skills only
  -y, --yes              Skip prompts (scope: project if it has skills, else global)

${BOLD}Project:${RESET}
  install              Restore skills from skill-library.json (alias: i, experimental_install)
  init [name]          Initialize a skill (creates <name>/SKILL.md or ./SKILL.md);
                       --always: every query returns it, without scoring

${BOLD}Sync:${RESET}
  sync init <git-url>     Keep global skills in a git repository (any host, HTTPS or SSH)
                          --share <skills>: folder skills to sync when seeding an empty repo ('*' = all;
                          default: asks, none without a terminal)
  sync                    Pull, install, update and push now (also runs on its own from query)
  sync update <git-url>   Move sync to another repository (pushes everything there)
  sync share <skill...>   Sync a machine-only skill (one added from a local folder) to your other devices
  sync disable            Stop syncing (add/remove/update -g stay local)
  sync enable             Start syncing again
  sync status             Show the repository, last sync and last error

${BOLD}Install Options:${RESET}
  --dry-run              Show what would be restored without installing anything
  --force                Re-check installed skills and repair any that changed
  --frozen-lockfile      Fail when skill-library.json is missing or empty (default in CI)
  --no-frozen-lockfile   Allow an empty skill-library.json in CI

${BOLD}Add Options:${RESET}
  -p, --project          Pin in this project's skill-library.json (created if missing)
  -g, --global           Add to the global library (the default; skips the scope prompt)
  -a, --agent <agents>   Agents the skills are for (use '*' for all agents; default: all)
  -s, --skill <skills>   Skill names to add (use '*' for all skills)
  -l, --list             List available skills in the source without adding them
  -y, --yes              Skip confirmation prompts
  --all                  Shorthand for --skill '*' --agent '*' -y
  --full-depth           Search all subdirectories even when a root SKILL.md exists
  --json                 Output results as JSON (machine-readable, no ANSI codes)
  --copy                 Accepted for compatibility (skills are always copied into the library)
  --share                With sync on: sync a skill from a local folder to your other devices
  --no-share             With sync on: keep a skill from a local folder on this machine only
                         (default: asks; machine-only with -y or inside an agent)

${BOLD}Use Options:${RESET}
  -s, --skill <skill>    Specify the skill to use
  -a, --agent <agent>    Start one supported agent interactively
  --full-depth           Search all subdirectories even when a root SKILL.md exists

${BOLD}Remove Options:${RESET}
  -p, --project          Only drop this project's reference (the skill stays in the library)
  -g, --global           Delete from the library itself (the default; skips the scope prompt)
  -a, --agent <agents>   Remove only these agents from the skill's agent list
  -s, --skill <skills>   Specify skills to remove (use '*' for all skills)
  -y, --yes              Skip confirmation prompts
  --all                  Remove every skill in scope (-y implied). Do not combine with named skills.

${BOLD}List Options:${RESET}
  -g, --global           List the whole library (default: the project, if it has a skill-library.json)
  -a, --agent <agents>   Filter by specific agents
  --json                 Output as JSON (machine-readable, no ANSI codes)

${BOLD}Add-ons:${RESET}
  connect                Install the gateway skill into your agents, so they query the library
    -a, --agent <agents> Only these agents (default: every agent found on this machine)
    --json               Output as JSON
  query "<task>" | -     Find the skills for a task (TypeSafe Jev scoring)
    -a, --agent <agent>  Your agent id; skips skills meant only for other agents
    --threshold <0..1>   Minimum probability (default 0.7)
    --top <n>            Cap the number of matches
    --json               Output as JSON

${BOLD}Options:${RESET}
  --help, -h        Show this help message
  --version, -v     Show version number
  --store <dir>     Library directory (default ~/.local/share/skill-library; env SKILL_LIBRARY_DIR)
  --verbose         Extra diagnostics on stderr

${BOLD}Examples:${RESET}
${formatted}

Discover more skills at ${TEXT}https://skills.sh/${RESET}
`);
}

export function showRemoveHelp(): void {
  console.log(`
${BOLD}Usage:${RESET} skill-library remove [skills...] [options]

${BOLD}Description:${RESET}
  Remove skills from the global library. With -p it only drops this project's reference
  (the skill stays in the library). In a folder with a skill-library.json you are asked
  which one you mean; without a prompt (-y, no TTY, inside an agent) pass -p or -g.
  If no skill names are provided, an interactive selection menu will be shown.

${BOLD}Arguments:${RESET}
  skills            Optional skill names or ids to remove (space-separated)

${BOLD}Options:${RESET}
  -p, --project      Only drop this project's reference
  -g, --global       Delete from the library itself (the default)
  -a, --agent        Remove only these agents from the skill's agent list
  -s, --skill        Specify skills to remove (use '*' for all skills)
  -y, --yes          Skip confirmation prompts
  --all              Remove every skill in scope (-y implied). Do not combine with named skills.

${BOLD}Examples:${RESET}
  ${DIM}$${RESET} skill-library remove                           ${DIM}# interactive selection${RESET}
  ${DIM}$${RESET} skill-library remove my-skill                   ${DIM}# remove specific skill${RESET}
  ${DIM}$${RESET} skill-library remove skill1 skill2 -y           ${DIM}# remove multiple skills${RESET}
  ${DIM}$${RESET} skill-library remove -p my-skill               ${DIM}# drop it from this project only${RESET}
  ${DIM}$${RESET} skill-library rm --agent claude-code my-skill   ${DIM}# stop offering it to Claude Code${RESET}
  ${DIM}$${RESET} skill-library remove --all                      ${DIM}# remove all skills${RESET}

Discover more skills at ${TEXT}https://skills.sh/${RESET}
`);
}
