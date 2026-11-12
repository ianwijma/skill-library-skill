// Run an end-to-end suite in a throwaway Docker container. Two suites, two commands:
//
//   npm run test:e2e [vitest args…]       The main suite, WITHOUT a network (`--network none`): it
//                                          can't reach GitHub, the TypeSafe API, npm or any sync
//                                          repository. Git, the sync remotes and every service are
//                                          local to the container. No credentials are passed in.
//   npm run test:e2e:live [vitest args…]  Only test/e2e/live.e2e.ts, WITH a network: it reads from
//                                          real GitHub and skills.sh and, when
//                                          SKILL_LIBRARY_TYPESAFE_API_KEY is set, scores against the
//                                          real TypeSafe API. That key is the only credential passed
//                                          in. The tests only read, and git pushes to any remote host
//                                          are blocked inside the container.
//
// Neither suite ever runs on the host: a container gets a copy of the source and nothing else (no
// host home directory, agents, npm prefix, git config, SSH keys or tokens).
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const image = "skill-library-e2e";
const LIVE_FILE = "test/e2e/live.e2e.ts";
// package.json's test:e2e:live passes --live first; everything else goes to vitest.
const live = process.argv[2] === "--live";
const args = process.argv.slice(live ? 3 : 2);

function docker(dockerArgs) {
  const r = spawnSync("docker", dockerArgs, { stdio: "inherit", cwd: root });
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
for (const name of ["CI", ...(live ? ["E2E_LIVE_SOURCE", "E2E_LIVE_SKILL"] : [])]) if (process.env[name] !== undefined) run.push("-e", name);
const vitest = ["npx", "vitest", "run", "--config", "vitest.e2e.config.ts"];
if (live) {
  if (!process.env.SKILL_LIBRARY_TYPESAFE_API_KEY) {
    console.warn("\n⚠ SKILL_LIBRARY_TYPESAFE_API_KEY is not set: the real TypeSafe query test will be skipped.\n");
  } else {
    run.push("-e", "SKILL_LIBRARY_TYPESAFE_API_KEY");
  }
  run.push("-e", "E2E_LIVE=1");
  run.push(image, ...vitest, LIVE_FILE, ...args);
} else {
  run.push(image, ...vitest, "--exclude", LIVE_FILE, ...args);
}
process.exit(docker(run));
