import pc from "picocolors";

/** Error carrying the process exit code (1 = usage/validation, 2 = runtime). */
export class CliError extends Error {
  readonly exitCode: 1 | 2;
  readonly fix: string | undefined;

  constructor(exitCode: 1 | 2, message: string, fix?: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.fix = fix;
  }
}

export function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Render an error the way vercel's diagnostics do: the message, then the fix on its own line(s). */
export function formatError(err: unknown): string {
  if (err instanceof CliError) return err.fix ? `${err.message}\n${err.fix}` : err.message;
  return msgOf(err);
}

let warnSink: ((message: string) => void) | undefined;

/** Route warnings somewhere other than stderr (the programmatic API collects them). */
export function setWarnSink(sink: ((message: string) => void) | undefined): void {
  warnSink = sink;
}

export function warn(message: string): void {
  if (warnSink) warnSink(message);
  else console.error(`${pc.yellow("warning:")} ${message}`);
}

/** Notices that must never reach stdout (JSON mode keeps stdout to one value). */
export function note(message: string): void {
  if (warnSink) warnSink(message);
  else console.error(message);
}

// 256-color grays used by vercel's CLI — visible on light and dark backgrounds.
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[38;5;102m";
export const TEXT = "\x1b[38;5;145m";
export const CYAN = "\x1b[36m";
export const YELLOW = "\x1b[33m";

/** Strip terminal escapes from untrusted strings (port of vercel's sanitize.ts, MIT). */
export function stripTerminalEscapes(str: string): string {
  return str
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\)/g, "")
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
    .replace(/\x1b[\x20-\x7e]/g, "")
    .replace(/[\x80-\x9f]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function sanitizeMetadata(str: string): string {
  return stripTerminalEscapes(str).replace(/[\r\n]+/g, " ").trim();
}
