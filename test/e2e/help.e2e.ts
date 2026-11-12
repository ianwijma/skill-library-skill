// Help. The top-level page lists everything; `<command> --help` (and `-h`) is that command's own
// page. Help never runs the command.
import { describe, expect, test } from "vitest";
import { HELP_SPECS, expectCommandHelp } from "./contract.ts";
import { exists, plain, world } from "./harness.ts";

describe("help", () => {
  test("--help and -h print the top-level page: every command and the global options; exit 0", async () => {
    const testWorld = await world();
    const main = plain((await testWorld.ok(["--help"])).stdout);

    expect(plain((await testWorld.ok(["-h"])).stdout)).toBe(main);

    for (const cmd of ["add", "install", "list", "remove", "update", "check", "find", "init", "query", "sync", "self", "use"]) {
      expect(main).toContain(cmd);
    }

    for (const opt of ["--store", "--verbose", "--version"]) {
      expect(main).toContain(opt);
    }
  });

  test("--help / -h after any command or subcommand (and alias) exits 0 and runs nothing", async () => {
    const testWorld = await world();

    for (const spec of HELP_SPECS) {
      for (const cmd of [spec.cmd, ...(spec.aliases ?? [])]) {
        for (const flag of ["--help", "-h"]) {
          const result = await testWorld.run([...cmd.split(" "), flag]);

          expect(result.code, `${cmd} ${flag}`).toBe(0);
          expect(result.stdout.trim(), `${cmd} ${flag}`).not.toBe("");
        }
      }
    }

    expect(await exists(testWorld.store)).toBe(false);
    expect(await exists(`${testWorld.home}/.config`)).toBe(false);
  });

  for (const spec of HELP_SPECS) {
    test(`${spec.cmd} --help is ${spec.cmd}'s own page${spec.aliases ? ` (also ${spec.aliases.join(", ")})` : ""}`, async () => {
      const testWorld = await world();
      const own = (await testWorld.ok([...spec.cmd.split(" "), "--help"])).stdout;

      expectCommandHelp(own, spec);
      expect(plain((await testWorld.ok([...spec.cmd.split(" "), "-h"])).stdout)).toBe(plain(own));

      for (const alias of spec.aliases ?? []) {
        expect(plain((await testWorld.ok([alias, "--help"])).stdout), alias).toBe(plain(own));
      }
    });
  }
});
