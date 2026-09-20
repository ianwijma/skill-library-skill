export type ExitCode = 0 | 1 | 2;

export interface Globals {
  store: string;
  pretty: boolean;
  returnContent: boolean;
  verbose: boolean;
}

export class CliError extends Error {
  readonly exitCode: 1 | 2;

  constructor(exitCode: 1 | 2, message: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function warn(message: string): void {
  console.error(`warning: ${message}`);
}

export function printJson(value: unknown, pretty: boolean): void {
  console.log(JSON.stringify(value, null, pretty ? 2 : undefined));
}

export type FlagKind = "string" | "boolean";

export interface ArgSpec {
  flags?: Record<string, FlagKind>;
  minPositionals?: number;
  maxPositionals?: number;
  positionalHint?: string;
}

export interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

export function parseArgs(argv: string[], spec: ArgSpec): ParsedArgs {
  const flags = spec.flags ?? {};
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]!);
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let inline: string | undefined;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const kind = flags[name];
    if (!kind) throw new CliError(1, `unknown flag '--${name}'`);
    if (kind === "boolean") {
      if (inline !== undefined) throw new CliError(1, `flag '--${name}' does not take a value`);
      booleans.add(name);
    } else {
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined) throw new CliError(1, `flag '--${name}' requires a value`);
      values.set(name, value);
    }
  }
  const min = spec.minPositionals ?? 0;
  const max = spec.maxPositionals ?? Infinity;
  if (positionals.length < min) {
    throw new CliError(1, `missing required argument: ${spec.positionalHint ?? "positional"}`);
  }
  if (positionals.length > max) {
    const extra = positionals[max] ?? "";
    throw new CliError(1, `unexpected argument '${extra}'${spec.positionalHint ? ` (expected ${spec.positionalHint})` : ""}`);
  }
  return { positionals, values, booleans };
}

export function requireFlag(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined) throw new CliError(1, `missing required flag --${name}`);
  return value;
}

export function validateName(name: string): void {
  if (name.length === 0 || name.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new CliError(1, `--name must be lowercase-hyphen, at most 64 chars (got '${name}')`);
  }
}
