// Help. The top-level page lists everything; `<command> --help` (and `-h`) is that command's own
// page. Help never runs the command.
//
// Per-command help is being built (moving the CLI to a library). Commands that don't have it yet
// are marked `test.fails`: their test is *expected* to fail for now. When a command gets its own
// help, its test starts passing, vitest reports the unexpected pass, and the command moves into
// HAS_OWN_HELP below.
import { describe, expect, test } from "vitest";
import { HELP_SPECS, expectCommandHelp } from "./contract.ts";
import { exists, plain, world } from "./harness.ts";

/** Commands whose `--help` is already their own page. */
const HAS_OWN_HELP = new Set(["remove", "use", "self"]);

describe("help", () => {
  test("--help and -h print the top-level page: every command and the global options; exit 0", async () => {
    const w = await world();
    const main = plain((await w.ok(["--help"])).stdout);
    expect(plain((await w.ok(["-h"])).stdout)).toBe(main);
    for (const cmd of ["add", "install", "list", "remove", "update", "check", "find", "init", "query", "sync", "self", "use"]) expect(main).toContain(cmd);
    for (const opt of ["--store", "--verbose", "--version"]) expect(main).toContain(opt);
  });

  test("--help / -h after any command or subcommand (and alias) exits 0 and runs nothing", async () => {
    const w = await world();
    for (const spec of HELP_SPECS) {
      for (const cmd of [spec.cmd, ...(spec.aliases ?? [])]) {
        for (const flag of ["--help", "-h"]) {
          const r = await w.run([...cmd.split(" "), flag]);
          expect(r.code, `${cmd} ${flag}`).toBe(0);
          expect(r.stdout.trim(), `${cmd} ${flag}`).not.toBe("");
        }
      }
    }
    expect(await exists(w.store)).toBe(false);
    expect(await exists(`${w.home}/.config`)).toBe(false);
  });

  for (const spec of HELP_SPECS) {
    const t = HAS_OWN_HELP.has(spec.cmd) ? test : test.fails;
    t(`${spec.cmd} --help is ${spec.cmd}'s own page${spec.aliases ? ` (also ${spec.aliases.join(", ")})` : ""}`, async () => {
      const w = await world();
      const own = (await w.ok([...spec.cmd.split(" "), "--help"])).stdout;
      expectCommandHelp(own, spec);
      expect(plain((await w.ok([...spec.cmd.split(" "), "-h"])).stdout)).toBe(plain(own));
      for (const alias of spec.aliases ?? []) expect(plain((await w.ok([alias, "--help"])).stdout), alias).toBe(plain(own));
    });
  }
});
