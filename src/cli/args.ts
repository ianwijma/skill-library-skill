import { warn } from "../lib/cli.ts";

export interface FlagSpec {
  /** Canonical name → aliases (e.g. global: ["-g", "--global"]). */
  booleans?: Record<string, string[]>;
  /** Flags taking one value. */
  values?: Record<string, string[]>;
  /** Flags collecting values until the next flag (vercel's -a/-s style). */
  lists?: Record<string, string[]>;
  /** Error on unknown flags instead of warning (vercel's `use`). */
  strict?: boolean;
}

export interface Parsed {
  positionals: string[];
  booleans: Set<string>;
  values: Map<string, string>;
  lists: Map<string, string[]>;
  unknown: string[];
  /** Flags given without a required value. */
  missing: string[];
}

export function parseFlags(argv: string[], spec: FlagSpec): Parsed {
  const out: Parsed = { positionals: [], booleans: new Set(), values: new Map(), lists: new Map(), unknown: [], missing: [] };
  const find = (table: Record<string, string[]> | undefined, flag: string): string | undefined => {
    if (!table) return undefined;
    for (const [name, aliases] of Object.entries(table)) if (aliases.includes(flag)) return name;
    return undefined;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      out.positionals.push(arg);
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    let name: string | undefined;
    if ((name = find(spec.booleans, flag))) {
      out.booleans.add(name);
    } else if ((name = find(spec.values, flag))) {
      const v = inline ?? argv[i + 1];
      if (v === undefined || (inline === undefined && v.startsWith("-") && v !== "-")) out.missing.push(flag);
      else {
        out.values.set(name, v);
        if (inline === undefined) i++;
      }
    } else if ((name = find(spec.lists, flag))) {
      const list = out.lists.get(name) ?? [];
      const start = list.length;
      if (inline !== undefined) list.push(...inline.split(",").filter(Boolean));
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) list.push(argv[++i]!);
      if (list.length === start) out.missing.push(flag);
      out.lists.set(name, list);
    } else {
      out.unknown.push(arg);
    }
  }
  if (!spec.strict) for (const u of out.unknown) warn(`ignoring unknown option ${u}`);
  return out;
}
