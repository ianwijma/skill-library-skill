// The CLI contract the e2e suite holds every argument parser to. The parser is going to change
// (we are moving to a CLI library), so these checks pin down *behaviour* — exit status, which
// option or argument a message is about, what was or wasn't changed — and never the exact wording,
// layout or stream a particular parser happens to print.
import { expect } from "vitest";
import { plain, type Result } from "./harness.ts";

/** A usage error (missing value, unknown command, unexpected argument …): a non-zero exit and a
 *  message that names the offending option or argument. Short and long names count as one option:
 *  `expectUsageError(r, "-a", "--agent")` passes when either is named. */
export function expectUsageError(r: Result, ...names: string[]): void {
  expect(r.code, `expected a usage error\n${r.stdout}${r.stderr}`).not.toBe(0);
  const out = r.stdout + r.stderr;
  if (names.length > 0) expect(names.some((n) => out.includes(n)), `expected one of ${names.join(", ")} in:\n${out}`).toBe(true);
}

/** With --json, stdout is never half a document: either nothing, or one JSON value. */
export function expectJsonOrNothing(r: Result): void {
  if (r.stdout.trim() !== "") expect(() => JSON.parse(r.stdout), r.stdout).not.toThrow();
}

/** An unknown option is named, and is either ignored with a warning (the command still runs) or
 *  rejected as a usage error. Returns true when the command ran. */
export function expectUnknownOption(r: Result, option: string): boolean {
  expect(r.stdout + r.stderr, `expected ${option} to be named`).toContain(option);
  return r.code === 0;
}

// --- help ------------------------------------------------------------------------------------

/** Options every command accepts; any help page may mention them. */
const GLOBAL = ["--store", "--verbose", "--help", "--version"];

export interface HelpSpec {
  /** The command path as typed, e.g. "sync init". */
  cmd: string;
  /** Other spellings that must print the same help. */
  aliases?: string[];
  /** The long options that are this command's own (short forms are not checked). */
  options: string[];
}

/** Every command and subcommand with its own options, per docs/02-cli-spec.md. */
export const HELP_SPECS: HelpSpec[] = [
  { cmd: "add", aliases: ["a"], options: ["--project", "--global", "--agent", "--skill", "--list", "--yes", "--all", "--full-depth", "--json", "--copy", "--share", "--no-share"] },
  { cmd: "install", aliases: ["i", "experimental_install"], options: ["--dry-run", "--force", "--frozen-lockfile", "--no-frozen-lockfile"] },
  { cmd: "list", aliases: ["ls"], options: ["--global", "--agent", "--json"] },
  { cmd: "remove", aliases: ["rm", "r"], options: ["--project", "--global", "--agent", "--skill", "--yes", "--all"] },
  { cmd: "update", aliases: ["upgrade"], options: ["--global", "--project", "--yes"] },
  { cmd: "check", options: ["--global", "--project", "--yes"] },
  { cmd: "find", aliases: ["search", "f", "s"], options: ["--owner"] },
  { cmd: "init", options: ["--always"] },
  { cmd: "use", options: ["--skill", "--agent", "--full-depth"] },
  { cmd: "query", options: ["--agent", "--threshold", "--top", "--json"] },
  { cmd: "self", options: ["--agent", "--json"] },
  { cmd: "self setup", options: ["--agent"] },
  { cmd: "self update", options: [] },
  { cmd: "self doctor", options: ["--agent", "--json"] },
  { cmd: "sync", options: ["--share", "--no-readme"] },
  { cmd: "sync init", options: ["--share", "--no-readme"] },
  { cmd: "sync update", options: ["--no-readme"] },
  { cmd: "sync share", options: [] },
  { cmd: "sync disable", options: [] },
  { cmd: "sync enable", options: [] },
  { cmd: "sync status", options: [] },
];

const ALL_OPTIONS = [...new Set(HELP_SPECS.flatMap((s) => s.options))];
const mentions = (text: string, option: string) => new RegExp(`(?<![\\w-])${option}(?![\\w-])`).test(text);

/** `<cmd> --help` is that command's own help: a usage line for the command, every one of its
 *  options, and none of the options that belong only to other commands (so not the global page). */
export function expectCommandHelp(out: string, spec: HelpSpec): void {
  const text = plain(out);
  const usage = new RegExp(`^\\s*(?:usage:?\\s*)?\`?skill-library ${spec.cmd.replace(/ /g, "\\s+")}(?:[\\s\`|]|$)`, "im");
  expect(text, `usage line for ${spec.cmd}`).toMatch(usage);
  for (const o of spec.options) expect(mentions(text, o), `${spec.cmd} help should mention ${o}`).toBe(true);
  const foreign = ALL_OPTIONS.filter((o) => !spec.options.includes(o) && !GLOBAL.includes(o) && mentions(text, o));
  expect(foreign, `${spec.cmd} help mentions other commands' options`).toEqual([]);
}
