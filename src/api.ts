/**
 * Programmatic API for skill-library. Side-effect free: nothing runs on import, nothing is
 * printed, nothing prompts, and the agent gateway is never placed (only the CLI's `add` and `connect` do).
 *
 * @example
 *   import { add, query } from "skill-library";
 *   await add("anthropics/skills", { skills: ["frontend-design"], global: true });
 *   const { matches } = await query("design a landing page", { agent: "claude-code" });
 */
import { withWarnSink } from "./lib/cli.ts";
import { addSkills, type AddOptions, type AddResult } from "./core/add.ts";
import { installProject, type InstallOptions, type InstallResult } from "./core/install.ts";
import { listSkills, type ListOptions, type ListResult } from "./core/list.ts";
import { querySkills, type QueryOptions, type QueryResult } from "./core/query.ts";
import { removeSkills, type RemoveOptions, type RemoveResult } from "./core/remove.ts";
import { checkSkills, updateSkills, type UpdateOptions, type UpdateResult } from "./core/update.ts";

export type { AddOptions, AddResult, AddedSkill, NameClash } from "./core/add.ts";
export type { InstallOptions, InstallResult, InstallRow, InstallStatus } from "./core/install.ts";
export type { ListOptions, ListResult } from "./core/list.ts";
export type { QueryOptions, QueryResult, QueryMatch } from "./core/query.ts";
export type { RemoveOptions, RemoveResult, RemovedRow } from "./core/remove.ts";
export type { UpdateOptions, UpdateResult, UpdateRow, UpdateStatus } from "./core/update.ts";
export type { ScopedSkill, BaseOptions } from "./core/context.ts";
export type { AgentsValue } from "./lib/store.ts";
export { CliError as SkillLibraryError } from "./lib/cli.ts";

/** Each call collects warnings instead of printing them. */
function quiet<T>(warnings: string[] | undefined, fn: () => Promise<T>): Promise<T> {
  return withWarnSink((m: string) => warnings?.push(m), fn);
}

export interface ApiOptions {
  /** Receives warnings and notices that the CLI would print to stderr. */
  warnings?: string[];
}

/** Add skills from a source. Without `skills`, every discovered skill is added. */
export function add(source: string, opts: AddOptions & ApiOptions = {}): Promise<AddResult> {
  return quiet(opts.warnings, () => addSkills(source, opts));
}

/** Restore the project's skills from skill-library.json. */
export function install(opts: InstallOptions & ApiOptions = {}): Promise<InstallResult> {
  return quiet(opts.warnings, () => installProject(opts));
}

export function list(opts: ListOptions & ApiOptions = {}): Promise<ListResult> {
  return quiet(opts.warnings, () => listSkills(opts));
}

/** Remove skills by name or id. In a project only the reference goes; `global: true` deletes. */
export function remove(skills: string[], opts: RemoveOptions & ApiOptions = {}): Promise<RemoveResult> {
  return quiet(opts.warnings, () => removeSkills(skills, opts));
}

export function update(opts: UpdateOptions & ApiOptions = {}): Promise<UpdateResult> {
  return quiet(opts.warnings, () => updateSkills(opts));
}

export function check(opts: UpdateOptions & ApiOptions = {}): Promise<UpdateResult> {
  return quiet(opts.warnings, () => checkSkills(opts));
}

/** Score the library for a task with TypeSafe Jev. */
export function query(task: string, opts: QueryOptions & ApiOptions = {}): Promise<QueryResult> {
  return quiet(opts.warnings, () => querySkills(task, opts));
}
