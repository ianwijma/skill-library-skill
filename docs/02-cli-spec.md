# 02 — CLI spec

`skill-library` follows the vercel-labs/skills v1.7.6 command contract. Differences
are marked **(differs)**. Global options anywhere on the line: `--store <dir>`
(or `SKILL_LIBRARY_DIR`), `--verbose`.

## Scope

- **Global** (default): the whole library.
- **Project** (`-p`): the nearest ancestor of the working directory with a
  `skill-library.json`. There is no project without that file: every command
  then works on the global library, and nothing creates the file except
  `add -p` (in the working directory; never in `$HOME`).

`add` and `remove` **(differs)**: global by default. In a folder with a
`skill-library.json` and no `-p`/`-g`, they ask which scope to use. Without a
prompt (`-y`, no TTY, inside an agent) both fail until `-p` or `-g` is given:
`-y` skips confirmations but never picks the scope, so nothing is pinned or
deleted by guessing. `-p -g` together is an error.

## Commands

| Command | Aliases | Flags | Behaviour |
|---|---|---|---|
| `add <source>` | `a`, `install <source>`, `i <source>` | `-p/--project`, `-g/--global`, `-a/--agent <agents…>`, `-s/--skill <skills…>`, `-l/--list`, `-y/--yes`, `--all`, `--full-depth`, `--json`, `--copy`, `--share`, `--no-share` | Fetch, discover skills, write them to the library and (project scope) to `skill-library.json`; then place the gateway. `--all` = `-s '*' -a '*' -y`. `--copy` has no effect. **(differs)** no agent prompt: only `-a` records agents (default: all). Global: a skill whose name another global skill already uses offers to replace it (`-y` replaces; the old one is kept, not global). `--share`/`--no-share`: see [09](09-global-sync-options.md). |
| `install` | `i`, `experimental_install` | `--dry-run`, `--force`, `--frozen-lockfile`, `--no-frozen-lockfile`, `-a` | Restore the project's skills at their pinned versions, verifying content hashes. `--force` repairs versions whose content no longer matches. `-a` is accepted and ignored. |
| `list` | `ls` | `-g`, `-a <agents…>`, `--json` | Project (with a `skill-library.json`): its skills (`installed` / `missing`). `-g`, or no `skill-library.json`: the whole library; skills only a project used are tagged `(not global)`. |
| `remove [skills…]` | `rm`, `r` | `-p`, `-g`, `-a <agents…>`, `-s <skills…>`, `-y`, `--all` | Global: delete from the library. `-p`: drop the project's reference (the skill stays in the library, unusable). `-a` removes agents from the skill's list. No match exits 0. |
| `update [skills…]` | `upgrade` | `-g`, `-p/--project`, `-y` | Pull the newest content from each skill's source. Project: moves this project's pin. `-g`: moves `current`. Local sources are skipped. |
| `check [skills…]` | | `-g`, `-p`, `-y` | Report updates (compares the skill folder's git tree, so commits to other skills in a monorepo don't count). Writes nothing; exit 1 if any update or failure. |
| `find [query]` | `search`, `f`, `s` | `--owner <name>` | Search skills.sh (`SKILLS_API_URL`). With a query: print results. Without: interactive picker on a TTY. |
| `init [name]` | | `--always` | Create `<name>/SKILL.md` or `./SKILL.md`. `--always` adds `metadata.always: true`. |
| `use <source>[@skill]` | | `-s <skill>`, `-a <claude-code\|codex\|sarvam-code>`, `--full-depth` | Print a prompt for one skill (pipe it into an agent), or start the agent with `-a`. Writes nothing to the library. Unknown options are errors. |
| `self setup` | | `-a <agents…>` | Add-on; the one-step install. 1) Checks the machine: npm is on `PATH` and can write its global folder (`npm root -g`), `git`, `SKILL_LIBRARY_TYPESAFE_API_KEY`; on any failure prints the fixes and exits 1 with nothing installed. 2) Installs skill-library with `npm i -g` when it isn't installed globally or npm has a newer release (`latest`, plus `next` for prereleases; registry `SKILL_LIBRARY_NPM_REGISTRY`, default `https://registry.npmjs.org`). 3) Hands over to the globally installed copy (`SKILL_LIBRARY_SELF_HANDOFF=1`), which installs (or refreshes) the gateway skill in every detected agent, or only the `-a` agents, and runs the doctor; exit 1 when the doctor finds a problem. Re-running it updates everything. Typical first run: `npx skill-library self setup`. |
| `self update` | | | Add-on. Update the global npm install to the newest release (`npm i -g`), then, run by the installed copy, refresh the gateway skill in every agent whose global skills folder already has it (agents without it are left alone). Exit 1 when skill-library isn't installed with `npm -g`; exit 2 when the registry can't be reached or npm fails. |
| `self doctor` | | `-a <agents…>`, `--json` | Add-on. Read-only checks, each `ok`, `warn` or `fail`: `install` (global npm install and `skill-library` on `PATH`), `release` (newer release: warn), `gateway` (missing or outdated in detected or `-a` agents), `api-key` (with where to create one: https://console.typesafe.ai/keys), `git`. `--json`: `{checks: [{id, status, message, fix?}], ok}`. Exit 1 on any `fail`. |
| `query "<task>" \| -` | | `-a <agent>`, `--threshold <0..1>`, `--top <n>`, `--json` | Add-on. See [04](04-typesafe-query.md). |
| `sync [init <git-url> \| update <git-url> \| share <skill...> \| enable \| disable \| status]` | | `--share <skills>` (init), `--no-readme` (init, update) | Add-on. Keep global skills in a git repository. See [09](09-global-sync-options.md). |

Scope rules for `update`/`check`: `-g -p` = both; no flag → project if
`skill-library.json` has entries, else global; named skills → both **(differs**:
vercel's named-skill path is global-first).

## Common behaviour

- Inside a detected agent (Claude Code, Codex, Cursor agent, …), `add` and
  `remove` behave as with `-y`. The detected agent is not recorded.
- Without a TTY and without `-y`, commands that would prompt fail with vercel's
  "Interactive prompt required but stdin is not a TTY" message.
- Unknown options print one warning and are ignored **(differs**: vercel ignores
  them silently), except for `use`, which errors like vercel.
- Invalid agents: `Invalid agents: x` / `Valid agents: …`, exit 1.
- An option whose value is used fails without one, exit 1: `-a` at the end of the line,
  `--threshold=` (empty), or `--top -1` (an option where the value should be). `-a` and
  `--agent` (and every other short/long pair) behave identically.
- Unknown command: `Unknown command: x` / `Run skill-library --help for usage.` on stdout, exit 1.
- `--version`/`-v` prints the bare version. No arguments prints the banner, exit 0.
- `--help`/`-h` lists every command; `<command> --help`, `<command> <subcommand> --help` and
  `help <command>` show that command's own usage, options and examples, exit 0. Help never runs the command.
- The logo shows only for `add`, `install`, `find`, `init` on a TTY outside agents.
- `--json` modes print exactly one JSON value on stdout; every notice goes to stderr.

## JSON

`list --json` — array of
`{name, path, scope, agents, source, sourceUrl, sourceType, status, id}`.
`path` is the version folder (or the in-place folder); `agents` are display
names; `status` is `tracked`, `untracked` (in the library but unusable here) or
`missing` (`path: null`).

`add --json` — array of `{id, name, status, source, ref, hash, path, scope, agents}`,
`status` = `installed` | `skipped` | `failed` (+ `error`). Exit 1 if any failed.

## Supported sources (0.1.0)

GitHub shorthand (`owner/repo`, `owner/repo@skill`, `owner/repo/path`, `#ref`,
`github:`), GitHub URLs (incl. `/tree/<ref>/<path>`), any https/ssh/scp-style git
URL, `file://` repositories, local folders and `.md` files. Well-known endpoints,
archives, skills.sh packs, Notion and GitLab `/-/tree/` URLs print
`… not supported by skill-library yet` and exit 1. Private GitHub repos use
`GITHUB_TOKEN` / `GH_TOKEN` (sent only to github.com, never on the command line).

## Exit codes

vercel's for the vercel commands (`remove` with no match → 0, `check` with updates → 1,
`add` with a failed skill → 1). `query`: 0 ok · 1 usage · 2 runtime.
