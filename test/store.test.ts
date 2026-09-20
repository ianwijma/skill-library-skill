import { describe, expect, test } from "bun:test";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateName } from "../src/lib/cli.ts";
import { generateId, randomId } from "../src/lib/ids.ts";
import {
  loadIndex,
  resolveSource,
  saveIndex,
  writeFileAtomic,
} from "../src/lib/store.ts";

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "sli-unit-"));
}

describe("ids", () => {
  test("randomId is 8 lowercase alphanumeric chars", () => {
    for (let i = 0; i < 50; i++) expect(randomId()).toMatch(/^[a-z0-9]{8}$/);
  });

  test("generateId avoids collisions with existing ids", () => {
    const existing = new Set<string>();
    for (let i = 0; i < 100; i++) existing.add(randomId());
    const id = generateId(existing);
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(existing.has(id)).toBe(false);
  });

  test("generateId regenerates on forced collision", () => {
    const id = randomId();
    expect(generateId([id])).not.toBe(id);
  });
});

describe("validateName", () => {
  test.each(["frontend-design", "sli", "a1-b2-c3", "x"])("%s is valid", (name) => {
    expect(() => validateName(name)).not.toThrow();
  });

  test.each(["", "UPPER", "-lead", "trail-", "dou--ble", "under_score", "sp ace", "a".repeat(65)])(
    "'%s' is rejected",
    (name) => {
      expect(() => validateName(name)).toThrow();
    },
  );
});

describe("writeFileAtomic", () => {
  test("writes content and leaves no tmp file behind", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "x.md");
    await writeFileAtomic(file, "hello");
    expect(await fsp.readFile(file, "utf8")).toBe("hello");
    expect(await fsp.readdir(dir)).toEqual(["x.md"]);
  });

  test("overwrites existing content atomically", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "x.md");
    await writeFileAtomic(file, "one");
    await writeFileAtomic(file, "two");
    expect(await fsp.readFile(file, "utf8")).toBe("two");
    expect(await fsp.readdir(dir)).toEqual(["x.md"]);
  });
});

describe("index", () => {
  test("missing store reads as empty index", async () => {
    const store = path.join(await tmpDir(), "missing");
    expect(await loadIndex(store)).toEqual([]);
  });

  test("save/load roundtrip", async () => {
    const store = await tmpDir();
    const entry = {
      id: "9f3a1c2b",
      name: "frontend-design",
      description: "d",
      source: "/tmp/src",
      addedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      contentDir: "skills/9f3a1c2b",
    };
    await saveIndex(store, [entry]);
    expect(await loadIndex(store)).toEqual([entry]);
  });

  test("corrupted index throws exit-2 error, never rebuilds", async () => {
    const store = await tmpDir();
    await fsp.writeFile(path.join(store, "index.json"), "{not json");
    expect(loadIndex(store)).rejects.toThrow("corrupted");
    await fsp.writeFile(path.join(store, "index.json"), '{"not":"an array"}');
    expect(loadIndex(store)).rejects.toThrow("corrupted");
  });
});

describe("resolveSource", () => {
  test("resolves an existing file to an absolute path", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "SKILL.md");
    await fsp.writeFile(file, "content");
    const src = await resolveSource(file);
    expect(src.kind).toBe("file");
    expect(src.abs).toBe(file);
  });

  test("resolves a skill directory containing SKILL.md", async () => {
    const dir = await tmpDir();
    const skill = path.join(dir, "my-skill");
    await fsp.mkdir(skill);
    await fsp.writeFile(path.join(skill, "SKILL.md"), "content");
    const src = await resolveSource(skill);
    expect(src.kind).toBe("dir");
    expect(src.abs).toBe(skill);
  });

  test("missing file exits 1", async () => {
    const dir = await tmpDir();
    expect(resolveSource(path.join(dir, "nope.md"))).rejects.toThrow("--path not found");
  });

  test("directory without SKILL.md exits 1", async () => {
    expect(resolveSource(await tmpDir())).rejects.toThrow("no readable SKILL.md");
  });
});
