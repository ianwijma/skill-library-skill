// Build: CLI bundle (dist/skill-library), side-effect-free API bundle (dist/index.js),
// declarations (dist/api.d.ts) and ThirdPartyNotices.txt for everything bundled.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

rmSync(dist, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  loader: { ".md": "text" },
  metafile: true,
  logLevel: "warning",
  // The CLI's --version; package.json is the only place the version is kept.
  define: { __SKILL_LIBRARY_VERSION__: JSON.stringify(version) },
  // Some bundled CJS deps call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __slCreateRequire } from 'node:module'; const require = __slCreateRequire(import.meta.url);" },
};

const cli = await build({
  ...common,
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(dist, "skill-library"),
  banner: { js: `#!/usr/bin/env node\n${common.banner.js}` },
});

chmodSync(path.join(dist, "skill-library"), 0o755);
// Built-in skills ship as files next to the bundles (see src/lib/builtin.ts).
cpSync(path.join(root, "assets/builtin"), path.join(dist, "builtin"), { recursive: true });
const api = await build({ ...common, entryPoints: [path.join(root, "src/api.ts")], outfile: path.join(dist, "index.js") });

execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(root, "tsconfig.build.json")], { stdio: "inherit" });

// Declarations: point relative imports at .js so every resolver (and older TypeScript) finds the .d.ts.
for (const entry of readdirSync(dist, { recursive: true })) {
  const file = path.join(dist, String(entry));

  if (!file.endsWith(".d.ts")) {
    continue;
  }

  const text = readFileSync(file, "utf8");

  writeFileSync(file, text.replace(/(from\s+["'])(\.{1,2}\/[^"']+)\.ts(["'])/g, "$1$2.js$3"));
}

// Third-party notices: every node_modules package that ended up in a bundle, plus ported code.
const pkgs = new Map();

for (const meta of [cli.metafile, api.metafile]) {
  for (const input of Object.keys(meta.inputs)) {
    const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);

    if (match) {
      pkgs.set(match[1], path.join(root, "node_modules", match[1]));
    }
  }
}

const sections = [
  "skill-library bundles or adapts the following third-party software.",
  "",
  "=".repeat(78),
  "vercel-labs/skills (adapted: agent table, agent detection, discovery, source parsing, CLI text)",
  "https://github.com/vercel-labs/skills",
  "-".repeat(78),
  readFileSync(path.join(root, "third_party/vercel-labs-skills.LICENSE"), "utf8").trim(),
];

for (const [name, dir] of [...pkgs.entries()].sort()) {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const licFile = readdirSync(dir).find((fileName) => /^(license|licence|copying)(\..*)?$/i.test(fileName));
  const text = licFile ? readFileSync(path.join(dir, licFile), "utf8").trim() : `License: ${pkg.license ?? "unknown"}`;

  sections.push("", "=".repeat(78), `${name}@${pkg.version} (${pkg.license ?? "unknown"})`, "-".repeat(78), text);
}

writeFileSync(path.join(root, "ThirdPartyNotices.txt"), sections.join("\n") + "\n");

if (!existsSync(path.join(dist, "api.d.ts"))) {
  throw new Error("dist/api.d.ts was not emitted");
}

console.log(`built dist/skill-library, dist/index.js, dist/api.d.ts; notices for ${pkgs.size} packages`);
