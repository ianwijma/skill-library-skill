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

    for (const entry of entries) {
      if (SKIP_BASENAMES.has(entry.name)) {
        continue;
      }

      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;

      if (entry.isDirectory()) {
        await walk(relPath);
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  }

  await walk("");

  return out;
}

function compareBytes(left: Buffer, right: Buffer): number {
  return Buffer.compare(left, right);
}

function u64(value: number): Buffer {
  const bytes = Buffer.alloc(8);

  bytes.writeBigUInt64BE(BigInt(value));

  return bytes;
}

/**
 * Content hash of a skill folder, stable across machines and locales.
 * Per file (UTF-8 relative path, sorted by byte value):
 *   uint64-BE(len(path)) ‖ path ‖ uint64-BE(len(content)) ‖ content
 * Result: "sha256-<lowercase hex>".
 */
export async function hashSkillDir(root: string): Promise<string> {
  const files = (await skillFiles(root)).map((relPath) => Buffer.from(relPath, "utf8")).sort(compareBytes);
  const hasher = createHash("sha256");

  for (const pathBytes of files) {
    const content = await fsp.readFile(path.join(root, pathBytes.toString("utf8")));

    hasher.update(u64(pathBytes.length));
    hasher.update(pathBytes);
    hasher.update(u64(content.length));
    hasher.update(content);
  }

  return `sha256-${hasher.digest("hex")}`;
}

/** Hash of in-memory files (same format), used by tests and the fixed test vector. */
export function hashFiles(files: Record<string, string | Buffer>): string {
  const entries = Object.entries(files)
    .map(([relPath, content]) => [
      Buffer.from(relPath, "utf8"),
      Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"),
    ] as const)
    .sort((left, right) => compareBytes(left[0], right[0]));
  const hasher = createHash("sha256");

  for (const [pathBytes, content] of entries) {
    hasher.update(u64(pathBytes.length));
    hasher.update(pathBytes);
    hasher.update(u64(content.length));
    hasher.update(content);
  }

  return `sha256-${hasher.digest("hex")}`;
}

export function hexOf(hash: string): string {
  return hash.startsWith("sha256-") ? hash.slice("sha256-".length) : hash;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
