import { readFileSync } from "node:fs";
import pc from "picocolors";
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
// A 256-color gradient (picocolors only has the basic colors); the logo only ever shows on a terminal.
const GRAYS = ["\x1b[38;5;250m", "\x1b[38;5;245m", "\x1b[38;5;240m"];
const RESET = "\x1b[0m";

/** Logo only on a TTY and never inside an agent (vercel hides it there too). */
function logoAllowed(): boolean {
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
    console.log(pc.gray("A skill library for agents — skills load on demand through one query"));
    console.log();
  }
  const row = (cmd: string, arg: string, desc: string) =>
    console.log(`  ${pc.gray("$")} skill-library ${cmd}${arg ? ` ${pc.gray(arg)}` : ""}${" ".repeat(Math.max(1, 30 - cmd.length - (arg ? arg.length + 1 : 0)))}${pc.gray(desc)}`);
  row("self setup", "", "Install, update and connect your agents");
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
  console.log(`${pc.gray("try:")} skill-library add anthropics/skills`);
  console.log();
  console.log("Discover more skills at https://skills.sh/");
  console.log();
}
