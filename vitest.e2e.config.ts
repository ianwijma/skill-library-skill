import { defineConfig } from "vitest/config";

/**
 * End-to-end suite: `npm run test:e2e`. The global setup builds the package, packs it with
 * `npm pack` and installs the tarball with `npm i -g` into a private prefix; every test runs that
 * installed `skill-library` from PATH, in its own sandboxed HOME, against local git repositories
 * and local stand-ins for the TypeSafe API, skills.sh and the npm registry. Nothing touches the
 * network or the real home directory.
 */
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    globalSetup: ["./test/e2e/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
