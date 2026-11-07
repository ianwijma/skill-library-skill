import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

/** The published tarball works on its own: bin, ESM import, types (bundler and node10), gateway. */
describe("packed package", () => {
  test("npm pack → install elsewhere → bin, import and types work", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-pack-"));
    const out = execFileSync("npm", ["pack", "--pack-destination", dir, "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
    const info = JSON.parse(out)[0];
    const files: string[] = info.files.map((f: any) => f.path).sort();
    expect(files).toContain("dist/skill-library");
    expect(files).toContain("dist/index.js");
    expect(files).toContain("dist/api.d.ts");
    expect(files).toContain("LICENSE");
    expect(files).toContain("ThirdPartyNotices.txt");
    expect(files.some((f) => f.startsWith("src/") || f.startsWith("test/") || f.startsWith("skills/"))).toBe(false);

    const consumer = path.join(dir, "consumer");
    await fsp.mkdir(consumer);
    await fsp.writeFile(path.join(consumer, "package.json"), JSON.stringify({ name: "c", private: true, type: "module" }));
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--offline", path.join(dir, info.filename)], { cwd: consumer, stdio: "ignore" });
    const bin = path.join(consumer, "node_modules", ".bin", "skill-library");
    expect(execFileSync(bin, ["--version"], { encoding: "utf8" })).toBe("0.1.0\n");

    await fsp.writeFile(
      path.join(consumer, "use.mjs"),
      `import * as sl from "skill-library";\nconsole.log(Object.keys(sl).sort().join(","));\n`,
    );
    const keys = execFileSync(process.execPath, ["use.mjs"], { cwd: consumer, encoding: "utf8" }).trim();
    expect(keys).toBe("SkillLibraryError,add,check,install,list,query,remove,update");

    await fsp.writeFile(
      path.join(consumer, "use.ts"),
      `import { add, query, type QueryMatch } from "skill-library";\nconst m: QueryMatch[] = (await query("x")).matches;\nvoid add; void m;\nexport {};\n`,
    );
    const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
    for (const resolution of [["--module", "nodenext", "--moduleResolution", "nodenext"], ["--module", "esnext", "--moduleResolution", "bundler"], ["--module", "node16", "--moduleResolution", "node16"]]) {
      execFileSync(process.execPath, [tsc, "--noEmit", "--strict", "--target", "es2022", "--skipLibCheck", "false", "--types", "node", "--typeRoots", path.join(root, "node_modules", "@types"), ...resolution, "use.ts"], { cwd: consumer, stdio: "pipe" });
    }
    const gw = await fsp.readFile(path.join(consumer, "node_modules", "skill-library", "dist", "skill-library"), "utf8");
    expect(gw).toContain("skill-library query -a <your-agent-id>");
  });
});
