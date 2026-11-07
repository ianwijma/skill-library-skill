import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

/** Files and folders never copied into the store and never hashed. */
export const SKIP_BASENAMES = new Set([".git", "node_modules", "__pycache__", ".DS_Store"]);

/** Relative POSIX paths of the regular files a skill folder contributes (copier and hasher agree). */
export async function skillFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_BASENAMES.has(e.name)) continue;
      const relPath = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(relPath);
      else if (e.isFile()) out.push(relPath);
    }
  }
  await walk("");
  return out;
}

function compareBytes(a: Buffer, b: Buffer): number {
  return Buffer.compare(a, b);
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/**
 * Content hash of a skill folder, stable across machines and locales.
 * Per file (UTF-8 relative path, sorted by byte value):
 *   uint64-BE(len(path)) ‖ path ‖ uint64-BE(len(content)) ‖ content
 * Result: "sha256-<lowercase hex>".
 */
export async function hashSkillDir(root: string): Promise<string> {
  const files = (await skillFiles(root)).map((p) => Buffer.from(p, "utf8")).sort(compareBytes);
  const h = createHash("sha256");
  for (const p of files) {
    const content = await fsp.readFile(path.join(root, p.toString("utf8")));
    h.update(u64(p.length));
    h.update(p);
    h.update(u64(content.length));
    h.update(content);
  }
  return `sha256-${h.digest("hex")}`;
}

/** Hash of in-memory files (same format), used by tests and the fixed test vector. */
export function hashFiles(files: Record<string, string | Buffer>): string {
  const entries = Object.entries(files)
    .map(([p, c]) => [Buffer.from(p, "utf8"), Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8")] as const)
    .sort((a, b) => compareBytes(a[0], b[0]));
  const h = createHash("sha256");
  for (const [p, c] of entries) {
    h.update(u64(p.length));
    h.update(p);
    h.update(u64(c.length));
    h.update(c);
  }
  return `sha256-${h.digest("hex")}`;
}

export function hexOf(hash: string): string {
  return hash.startsWith("sha256-") ? hash.slice("sha256-".length) : hash;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
