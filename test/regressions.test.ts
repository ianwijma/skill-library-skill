import { describe, expect, test, vi } from "vitest";
import { promises as fsp } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { gitRepo, project, readJson, run, sandbox, skillMd, writeFiles, type Sandbox } from "./helpers.ts";

const fresh = (sb: Sandbox, name = "store2"): Sandbox => ({ ...sb, env: { ...sb.env, SKILL_LIBRARY_DIR: path.join(sb.root, name) } });

async function editManifest(dir: string, fn: (m: any) => void): Promise<void> {
  const file = path.join(dir, "skill-library.json");
  const m = await readJson(file);
  fn(m);
  await fsp.writeFile(file, JSON.stringify(m));
}

describe("manifest is validated before any work", () => {
  test("option-like or non-SHA commit pins never reach git", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "r", { "SKILL.md": skillMd("solo", "Solo") });
    const dir = await project(sb);
    await run(sb, ["add", repo.url, "-y"], { cwd: dir });
    const marker = path.join(sb.root, "pwned");
    for (const commit of [`--upload-pack=touch ${marker}`, "main"]) {
      await editManifest(dir, (m) => {
        for (const e of Object.values(m.skills) as any[]) e.commit = commit;
      });
      const r = await run(fresh(sb), ["install"], { cwd: dir });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("commit must be a full 40-hex commit SHA");
    }
    await expect(fsp.access(marker)).rejects.toThrow();
    await expect(fsp.access(path.join(sb.root, "store2"))).rejects.toThrow();
  });

  test("missing hash, escaping local:// and traversing git path are rejected", async () => {
    const sb = await sandbox();
    const dir = await project(sb);
    const cases: Array<Record<string, unknown>> = [
      { "home://x/bar": { source: "~/x/bar", agents: "all" } },
      { "local://../../outside": { agents: "all" } },
      { "repo://localhost/r/s": { source: "file:///tmp/r.git", path: "../../etc", commit: "a".repeat(40), hash: `sha256-${"0".repeat(64)}`, agents: "all" } },
      { "repo://localhost/r/s": { source: "--upload-pack=x", commit: "a".repeat(40), hash: `sha256-${"0".repeat(64)}`, agents: "all" } },
    ];
    for (const skills of cases) {
      await fsp.writeFile(path.join(dir, "skill-library.json"), JSON.stringify({ version: 1, skills }));
      const r = await run(sb, ["install"], { cwd: dir });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("invalid entry");
    }
    await expect(fsp.access(path.join(sb.store, "index.json"))).rejects.toThrow();
  });
});

describe("ambiguous names", () => {
  test("remove -g with a name matching two ids fails and deletes nothing; the id works", async () => {
    const sb = await sandbox();
    await writeFiles(path.join(sb.root, "one"), { "react/SKILL.md": skillMd("react", "one") });
    await writeFiles(path.join(sb.root, "two"), { "react/SKILL.md": skillMd("react", "two") });
    await run(sb, ["add", path.join(sb.root, "one", "react"), "-g", "-y"]);
    await run(sb, ["add", path.join(sb.root, "two", "react"), "-g", "-y"]);
    const r = await run(sb, ["remove", "-g", "react", "-y"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('"react" matches several skills');
    expect((await readJson(path.join(sb.store, "index.json"))).skills).toHaveLength(2);
    const id = `path://${path.join(sb.root, "one", "react")}`;
    expect((await run(sb, ["remove", "-g", id, "-y"])).code).toBe(0);
    expect((await readJson(path.join(sb.store, "index.json"))).skills.map((s: any) => s.id)).toEqual([`path://${path.join(sb.root, "two", "react")}`]);
  });

  test("project remove with an ambiguous name changes nothing", async () => {
    const sb = await sandbox();
    const dir = await project(sb);
    await writeFiles(dir, { "a/react/SKILL.md": skillMd("react", "one"), "b/react/SKILL.md": skillMd("react", "two") });
    await run(sb, ["add", "./a/react", "-y"], { cwd: dir });
    await run(sb, ["add", "./b/react", "-y"], { cwd: dir });
    const before = await fsp.readFile(path.join(dir, "skill-library.json"), "utf8");
    expect((await run(sb, ["remove", "react", "-y"], { cwd: dir })).code).toBe(1);
    expect(await fsp.readFile(path.join(dir, "skill-library.json"), "utf8")).toBe(before);
  });
});

describe("repair and staging", () => {
  test("install repairs a version folder whose SKILL.md was deleted", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "r", { "SKILL.md": skillMd("solo", "Solo") });
    const dir = await project(sb);
    await run(sb, ["add", repo.url, "-y"], { cwd: dir });
    const rows = JSON.parse((await run(sb, ["ls", "--json"], { cwd: dir })).stdout);
    await fsp.rm(path.join(rows[0].path, "SKILL.md"));
    const r = await run(sb, ["install"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Repaired");
    expect(await fsp.readFile(path.join(rows[0].path, "SKILL.md"), "utf8")).toContain("Solo");
  });

  test("re-adding an existing version leaves no staged copies behind", async () => {
    const sb = await sandbox();
    await writeFiles(path.join(sb.root, "s"), { "bar/SKILL.md": skillMd("bar", "Bar") });
    for (let i = 0; i < 3; i++) expect((await run(sb, ["add", path.join(sb.root, "s", "bar"), "-g", "-y"])).code).toBe(0);
    const staging = path.join(sb.store, ".staging");
    const left = await fsp.readdir(staging).catch(() => []);
    expect(left).toEqual([]);
  });

  test("replaceVersionDir rolls back when the swap fails", async () => {
    const { replaceVersionDir } = await import("../src/lib/store.ts");
    const sb = await sandbox();
    const dest = path.join(sb.root, "v");
    await writeFiles(dest, { "SKILL.md": "old" });
    await expect(replaceVersionDir(path.join(sb.root, "does-not-exist"), dest)).rejects.toThrow(/cannot replace/);
    expect(await fsp.readFile(path.join(dest, "SKILL.md"), "utf8")).toBe("old");
  });
});

describe("concurrency", () => {
  test("concurrent adds and removes in one project never lose or resurrect entries", async () => {
    const sb = await sandbox();
    const dir = await project(sb);
    const names = ["a", "b", "c", "d", "e", "f"];
    await writeFiles(path.join(sb.root, "src"), Object.fromEntries(names.map((n) => [`${n}/SKILL.md`, skillMd(n, n)])));
    await writeFiles(dir, { "local/x/SKILL.md": skillMd("x", "x") });
    await run(sb, ["add", "./local/x", "-y"], { cwd: dir });
    const results = await Promise.all([
      ...names.map((n) => run(sb, ["add", path.join(sb.root, "src", n), "-y"], { cwd: dir })),
      run(sb, ["remove", "x", "-y"], { cwd: dir }),
    ]);
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    const m = await readJson(path.join(dir, "skill-library.json"));
    expect(Object.keys(m.skills).map((k) => k.split("/").pop()).sort()).toEqual(names);
  });
});

describe("confirmation without a TTY", () => {
  test("named remove and single-skill add without -y fail and change nothing", async () => {
    const sb = await sandbox();
    await writeFiles(path.join(sb.root, "s"), { "bar/SKILL.md": skillMd("bar", "Bar") });
    const add = await run(sb, ["add", path.join(sb.root, "s", "bar"), "-g"]);
    expect(add.code).toBe(1);
    expect(add.stderr).toContain("not a TTY");
    await expect(fsp.access(path.join(sb.store, "index.json"))).rejects.toThrow();
    const sel = await run(sb, ["add", path.join(sb.root, "s"), "-g", "-s", "bar"]);
    expect(sel.code).toBe(1);
    await run(sb, ["add", path.join(sb.root, "s", "bar"), "-g", "-y"]);
    const rm = await run(sb, ["remove", "-g", "bar"]);
    expect(rm.code).toBe(1);
    expect((await readJson(path.join(sb.store, "index.json"))).skills).toHaveLength(1);
  });
});

describe("selectors and reserved names", () => {
  test("add accepts full ids as -s selectors (git and local)", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "r", { "skills/a/SKILL.md": skillMd("a", "A"), "skills/b/SKILL.md": skillMd("b", "B") });
    const id = `repo://localhost${repo.bare.replace(/\.git$/, "")}/b`;
    const r = await run(sb, ["add", repo.url, "-g", "-y", "-s", id]);
    expect(r.code, r.stderr).toBe(0);
    expect((await readJson(path.join(sb.store, "index.json"))).skills.map((s: any) => s.id)).toEqual([id]);
    await writeFiles(path.join(sb.root, "loc"), { "c/SKILL.md": skillMd("c", "C"), "d/SKILL.md": skillMd("d", "D") });
    const lid = `path://${path.join(sb.root, "loc", "d")}`;
    expect((await run(sb, ["add", path.join(sb.root, "loc"), "-g", "-y", "-s", lid])).code).toBe(0);
    expect((await readJson(path.join(sb.store, "index.json"))).skills.map((s: any) => s.id)).toContain(lid);
  });

  test("a bare gateway or reserved-name markdown file is never stored", async () => {
    const sb = await sandbox();
    await writeFiles(path.join(sb.root, "f"), { "gw.md": skillMd("skill-library", "gateway"), "h.md": skillMd("skill-library-get", "helper") });
    for (const f of ["gw.md", "h.md"]) {
      const r = await run(sb, ["add", path.join(sb.root, "f", f), "-g", "-y"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("only contains the skill-library gateway");
    }
    await expect(fsp.access(path.join(sb.store, "index.json"))).rejects.toThrow();
  });
});

describe("missing project skills keep their real name", () => {
  test("a missing home:// skill whose folder name differs still shadows the global skill", async () => {
    const sb = await sandbox();
    const dir = await project(sb);
    await writeFiles(path.join(sb.home, "skills"), { "folder-name/SKILL.md": skillMd("react", "project react") });
    await writeFiles(path.join(sb.root, "g"), { "react/SKILL.md": skillMd("react", "global react") });
    await run(sb, ["add", path.join(sb.home, "skills", "folder-name"), "-y"], { cwd: dir });
    const other = fresh(sb);
    await run(other, ["add", path.join(sb.root, "g", "react"), "-g", "-y"]);
    const bodies: any[] = [];
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "m", answers: {}, usage: {} }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await run(other, ["query", "task"], { cwd: dir, env: { TYPESAFE_API_KEY: "k", TYPESAFE_API_BASE: url } });
    server.close();
    expect(r.stderr).toContain("1 project skill is not installed");
    expect(bodies).toHaveLength(0);
  });
});

describe("API", () => {
  test("overlapping calls keep their own warnings and print nothing", async () => {
    const api = await import("../src/api.ts");
    const sb = await sandbox();
    const prevHome = process.env.HOME;
    await writeFiles(path.join(sb.root, "s"), { "bar/SKILL.md": skillMd("bar", "Bar"), "bad/SKILL.md": "no frontmatter" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.env.HOME = sb.home;
      const w1: string[] = [];
      const w2: string[] = [];
      const [a, l] = await Promise.all([
        api.add(path.join(sb.root, "s"), { store: sb.store, cwd: sb.home, warnings: w1 }),
        api.list({ store: path.join(sb.root, "other"), global: true, warnings: w2 }),
      ]);
      expect(a.skills.map((s) => s.name)).toEqual(["bar"]);
      expect(l.skills).toEqual([]);
      expect(w1.some((m) => m.includes("No project here"))).toBe(true);
      expect(w1.some((m) => m.includes("missing required frontmatter"))).toBe(true);
      expect(w2).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      process.env.HOME = prevHome;
      spy.mockRestore();
      log.mockRestore();
    }
  });
});

describe("second review", () => {
  test("two contenders reclaiming the same stale lock never hold it together", async () => {
    const { withFileLock } = await import("../src/lib/store.ts");
    const sb = await sandbox();
    const file = path.join(sb.root, "x.lock");
    const os = await import("node:os");
    let inside = 0;
    let max = 0;
    for (let round = 0; round < 5; round++) {
      await fsp.writeFile(file, JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), at: "", token: `dead${round}` }));
      await Promise.all(
        [0, 1, 2].map(() =>
          withFileLock(file, async () => {
            inside++;
            max = Math.max(max, inside);
            await new Promise((r) => setTimeout(r, 20));
            inside--;
          }),
        ),
      );
    }
    expect(max).toBe(1);
    await expect(fsp.access(file)).rejects.toThrow();
  });

  test("update refuses an upstream SKILL.md symlink and keeps the old pin", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "r", { "SKILL.md": skillMd("solo", "Solo") });
    const dir = await project(sb);
    await run(sb, ["add", repo.url, "-y"], { cwd: dir });
    const before = await fsp.readFile(path.join(dir, "skill-library.json"), "utf8");
    await fsp.writeFile(path.join(repo.work, "other.md"), skillMd("solo", "Solo v2"));
    await fsp.rm(path.join(repo.work, "SKILL.md"));
    await fsp.symlink("other.md", path.join(repo.work, "SKILL.md"));
    await repo.commit({});
    const u = await run(sb, ["update", "-y"], { cwd: dir });
    expect(u.code).toBe(1);
    expect(u.stdout).toContain("not a regular file");
    expect(await fsp.readFile(path.join(dir, "skill-library.json"), "utf8")).toBe(before);
    expect(JSON.parse((await run(sb, ["ls", "--json"], { cwd: dir })).stdout)[0].status).toBe("tracked");
  });

  test("update keeps the manifest name in step with a renamed skill", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "r", { "SKILL.md": skillMd("old", "Old") });
    const dir = await project(sb);
    await run(sb, ["add", repo.url, "-y"], { cwd: dir });
    await repo.commit({ "SKILL.md": skillMd("new", "New") });
    expect((await run(sb, ["update", "-y"], { cwd: dir })).code).toBe(0);
    const m = await readJson(path.join(dir, "skill-library.json"));
    expect((Object.values(m.skills)[0] as any).name).toBe("new");
  });

  test("a gateway-only source without -y and without a TTY places nothing", async () => {
    const sb = await sandbox();
    await writeFiles(path.join(sb.root, "gw"), { "skill-library/SKILL.md": skillMd("skill-library", "gateway") });
    await fsp.mkdir(path.join(sb.home, ".claude"), { recursive: true });
    const r = await run(sb, ["add", path.join(sb.root, "gw"), "-g", "-a", "claude-code"], { env: { SKILL_LIBRARY_NO_GATEWAY: undefined } });
    expect(r.code).toBe(1);
    await expect(fsp.access(path.join(sb.home, ".claude", "skills", "skill-library"))).rejects.toThrow();
  });

  test("folder names the writer accepts are read back (a:b, back\\\\slash on POSIX)", async () => {
    const sb = await sandbox();
    const dir = await project(sb);
    await writeFiles(dir, { "a:b/SKILL.md": skillMd("colon", "C"), "x\\y/SKILL.md": skillMd("slash", "S") });
    expect((await run(sb, ["add", "./a:b", "-y"], { cwd: dir })).code).toBe(0);
    expect((await run(sb, ["add", "./x\\y", "-y"], { cwd: dir })).code).toBe(0);
    const rows = JSON.parse((await run(sb, ["ls", "--json"], { cwd: dir })).stdout);
    expect(rows.map((r: any) => r.name).sort()).toEqual(["colon", "slash"]);
  });

  test("list --json keeps stdout to one JSON value on errors", async () => {
    const sb = await sandbox();
    const bad = await run(sb, ["ls", "--json", "-a", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe("[]\n");
    expect(bad.stderr).toContain("Invalid agents: nope");
    const dir = await project(sb);
    await fsp.writeFile(path.join(dir, "skill-library.json"), "{nope");
    const broken = await run(sb, ["ls", "--json"], { cwd: dir });
    expect(broken.stdout).toBe("[]\n");
    expect(broken.stderr).toContain("not valid JSON");
  });
});

describe("third review", () => {
  test("an abandoned reclaim guard is never removed automatically; contenders fail closed", async () => {
    const { withFileLock } = await import("../src/lib/store.ts");
    const sb = await sandbox();
    const os = await import("node:os");
    const file = path.join(sb.root, "y.lock");
    await fsp.writeFile(file, JSON.stringify({ pid: 2 ** 22 + 54321, host: os.hostname(), at: "", token: "dead" }));
    await fsp.mkdir(`${file}.reclaim`);
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(`${file}.reclaim`, old, old);
    let entered = 0;
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        withFileLock(
          file,
          async () => {
            entered++;
          },
          300,
        ),
      ),
    );
    expect(entered).toBe(0);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect(String((r as PromiseRejectedResult).reason)).toContain("could not be reclaimed");
    }
    await fsp.access(`${file}.reclaim`);
    await fsp.access(file);
  });

  test("update never advances to a damaged version already cached by another scope", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "r", { "SKILL.md": skillMd("solo", "v1") });
    const dir = await project(sb);
    await run(sb, ["add", repo.url, "-g", "-y"]);
    const c2 = await repo.commit({ "SKILL.md": skillMd("solo", "v2") });
    await run(sb, ["add", repo.url, "-y"], { cwd: dir });
    const index = await readJson(path.join(sb.store, "index.json"));
    const rec = index.skills[0];
    await fsp.rm(path.join(sb.store, rec.dir, c2.slice(0, 12), "SKILL.md"));
    const u = await run(sb, ["update", "-g", "-y"]);
    expect(u.code).toBe(0);
    const rows = JSON.parse((await run(sb, ["ls", "-g", "--json"])).stdout);
    expect(rows[0].status).toBe("tracked");
    expect(await fsp.readFile(path.join(rows[0].path, "SKILL.md"), "utf8")).toContain("v2");
  });
});
