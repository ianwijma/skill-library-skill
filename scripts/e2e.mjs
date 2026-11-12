// `npm run test:e2e [vitest args…]`: run the end-to-end suite in a throwaway Docker container.
//
// The suite never runs on the host. The container gets a copy of the source and nothing else:
// no host home directory, agents, npm prefix, git config, SSH keys or tokens. It runs without a
// network (`--network none`), so it can't reach GitHub, the TypeSafe API, npm or any sync
// repository. Git, the sync remotes and every service are local to the container.
//
// E2E_LIVE=1 is the one exception: it allows the network so test/e2e/live.e2e.ts can read from
// real GitHub and (with SKILL_LIBRARY_TYPESAFE_API_KEY) score against the real TypeSafe API. Those
// tests only read. No credentials are passed in, and git pushes to any remote host are
// blocked inside the container, so even then nothing outside it can change.
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const image = "skill-library-e2e";
const live = process.env.E2E_LIVE === "1";

function docker(args, opts = {}) {
  const r = spawnSync("docker", args, { stdio: "inherit", cwd: root, ...opts });
  if (r.error) {
    console.error(`Error: can't run docker (${r.error.message}). The end-to-end tests only run in Docker; install it from https://docs.docker.com/get-docker/`);
    process.exit(1);
  }
  return r.status ?? 1;
}

// CI builds the image itself (with a layer cache) and sets E2E_IMAGE_BUILT=1.
if (process.env.E2E_IMAGE_BUILT !== "1") {
  const build = ["build", "--file", "test/e2e/Dockerfile", "--tag", image];
  if (process.env.E2E_NODE_VERSION) build.push("--build-arg", `NODE_VERSION=${process.env.E2E_NODE_VERSION}`);
  build.push(".");
  const built = docker(build);
  if (built !== 0) process.exit(built);
}

const run = ["run", "--rm", "--init"];
if (!live) run.push("--network", "none");
if (process.stdout.isTTY) run.push("--tty");
// Only these reach the container; `-e NAME` copies the value without putting it on the command line.
for (const name of ["E2E_LIVE", "E2E_LIVE_SOURCE", "E2E_LIVE_SKILL", "CI"]) if (process.env[name] !== undefined) run.push("-e", name);
if (live && process.env.SKILL_LIBRARY_TYPESAFE_API_KEY) run.push("-e", "SKILL_LIBRARY_TYPESAFE_API_KEY");
run.push(image, "npx", "vitest", "run", "--config", "vitest.e2e.config.ts", ...process.argv.slice(2));
process.exit(docker(run));
