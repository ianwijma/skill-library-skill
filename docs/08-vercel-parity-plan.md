# Plan: align the `skill-library` CLI with the vercel-labs/skills command contract

Status: **v6 (slim)** — v5 plus both final v5 reviews (Astra, Opus). No open questions.
The older, larger v2 plan is kept at `scratchpad/plans/plan-final.md` for reference.
Reference: vercel-labs/skills v1.7.6 (commit `d3701c1`). We copy its **command contract only** —
command names, aliases, flags, prompts, diagnostics and output style. We do not depend on its
package or copy its repository, logo, telemetry or security audit. Deliberate differences are marked
**(differs)**.

---

## 0. Decisions (from the user, not reopened)

| # | Decision |
|---|---|
| D1 | Skills are never installed into agent skill folders. The only file we put there is the **gateway** skill. All other skills live in the store and are reached through `skill-library query`. |
| D2 | One store, global: `~/.local/share/skill-library` (or `$SKILL_LIBRARY_DIR`). Every stored skill has a `global` flag. Project skills are stored there with `global: false`; a project references them by id from `skill-library.json` at its root. (Exception, §2.3: folders inside the project are read in place.) |
| D3 | Inside a project, `query` sees global skills plus the project's skills. On a name clash the project's skill wins. |
| D4 | One store entry per skill; adding a skill that is already in the store only adds a reference (or flips `global`). Versions live side by side inside that entry (D15). |
| D5 | `remove` inside a project drops only the project's reference; the skill stays in the store but is unusable (not global, in no query) until added again. `list -g` still shows it, tagged `(not global)`. `remove -g` deletes it from the store. |
| D6 | Skill ids come from where the skill came from (§1): `repo://`, `local://`, `home://`, `path://`. Same id = same skill. The version is not part of the id. |
| D7 | Project skills work on another machine: `skill-library install` fetches every referenced skill that is missing, at the **pinned version**, and verifies its content hash (protection against tampered sources). |
| D8 | `-a, --agent` on `add` records which agents a skill is for. `query -a <agent>` filters on that. Unknown agent names fail with the list of valid names so the LLM can retry. Jev scoring is unchanged and knows nothing about agents. |
| D9 | One gateway skill = today's `skill-library` skill with the `skill-library-query` content merged in. Only `add` places the gateway (§6); no other command writes agent folders. |
| D10 | Only the `skill-library` binary. No telemetry. No security audit. Our own logo. Node floor `>=22`. No refresh of local skills. No description editing. |
| D11 | `query` prints plain text: path lines plus an instruction for the agent to read them. |
| D12 | Programmatic API exported from the package. |
| D13 | Publish to npm as `skill-library@0.1.0`, MIT license, with `repository` set. |
| D14 | Small first. `sync` is dropped; `use` is kept. Anything else not needed is deferred. |
| D15 | The store is versioned: one folder per skill, one sub-folder per version. Projects pin a version; global scope uses `current`. `update` pulls the newest content from the original source. |

---

## 1. Skill ids

| Source | Id |
|---|---|
| GitHub — any transport (`owner/repo`, `owner/repo@skill`, `github:…`, `https://github.com/…`, `git@github.com:…`, `ssh://git@github.com/…`) | `repo://github.com/<owner>/<repo>/<skill-name>` |
| Other git host (`https://gitlab.com/g/sub/repo`, `git@host:g/repo.git`) | `repo://<host>/<repo-path>/<skill-name>`, e.g. `repo://gitlab.com/group/repo/my-skill` |
| Folder inside the current project — **project scope only** | `local://<path-from-project-root>`, e.g. `local://skills/foo` |
| Folder under `$HOME` | `home://<path-from-home>`, e.g. `home://my-skills/foo` |
| Any other folder or file | `path://<absolute-path>`, e.g. `path:///home/my-user/some-folder/my-skills/foo` (warning: won't work on other machines) |

Rules:
- Host lower-cased; for GitHub, owner/repo lower-cased too. Scheme, user, port and `.git` are dropped.
  Other hosts keep path case.
- `<skill-name>` is the frontmatter `name`. If one git source contains two different skill folders with
  the same name, `add` refuses both with an error naming the two paths **(differs**: vercel dedupes
  silently; we can't, because the id must be unique).
- For folder sources the id is the **discovered skill folder's** path (for a `.md` file, the file's path),
  not the path given to `add`. `add ~/my-skills` finding `foo` and `bar` gives `home://my-skills/foo` and
  `home://my-skills/bar`.
- `local://` ids exist only in a project's `skill-library.json`, never in the store. `add -g` of a folder
  that happens to be inside a project gets a `home://` / `path://` id and is copied into the store.
- Ids are opaque after derivation, with one exception: a `local://` id is resolved against the
  manifest's directory to find the folder (it has no separate `source`). Other source details live in
  the record (§2.1) and the project entry (§2.2).
- The id is **never sent to TypeSafe**: Jev questions use opaque keys `s0…sN`, mapped back locally (§5.1).
- Selectors (`-s`, positional names) match by skill name like vercel; the full id is also accepted.
  When a name matches several skills in scope: TTY → pick; non-TTY → error listing the ids, exit 1.
- Prefixes need no shell quoting. `repo://` is not a git URL scheme, so an id is never mistaken for a
  source by `add`.
- **The gateway is never a stored skill.** Discovery skips skills named `skill-library` or
  `skill-library-*`. `add ianwijma/skill-library-skill` therefore
  stores nothing and only places the gateway (§6).

## 2. Store and project file

### 2.1 Store (`index.json` version 1, versioned)

```
~/.local/share/skill-library/
  index.json
  index.lock                            # only while writing
  skills/
    frontend-design-3f9c1a2e/      # <safe-slug(name)>-<first 8 hex of sha256(id)>
      3f2a9c1d07e4/                     # git: first 12 hex of the commit
      8e01b7a4c2f9/
    my-notes-a1b2c3d4/
      h-5d41402abc4b/                   # local copy: "h-" + first 12 hex of the content hash
```

```jsonc
{
  "version": 1,
  "skills": [{
    "id": "repo://github.com/anthropics/skills/frontend-design",
    "source": { "type": "git", "url": "https://github.com/anthropics/skills.git",
                "ref": null, "path": "skills/frontend-design" },   // global follow target
    "dir": "skills/frontend-design-3f9c1a2e",
    "versions": {
      "3f2a9c1d07e4": { "commit": "3f2a9c1d07e4…", "tree": "9b1c…", "hash": "sha256-…",
                        "name": "frontend-design", "description": "…", "addedAt": "…" },
      "8e01b7a4c2f9": { "commit": "8e01b7a4c2f9…", "tree": "77ad…", "hash": "sha256-…",
                        "name": "frontend-design", "description": "…", "addedAt": "…" }
    },
    "current": "8e01b7a4c2f9",           // version used in global scope
    "global": true,
    "agents": "all",                     // "all" | ["codex", …] — global usage only (§4)
    "addedAt": "…", "updatedAt": "…"
  }]
}
```

- `source.type`: `git` | `folder` | `file`. `ref`: branch/tag followed (`null` = default branch); an
  explicit full-SHA source is fixed and never moved by `update`. `tree`: the skill folder's git tree id
  (`git rev-parse <commit>:<path>`), used by `check`.
- **Name and description are per version**, read from that version's `SKILL.md`. `query` and `list` always use the metadata of the version they
  will print, so a project pinned to an older version is scored on that version's description.
- `record.source` is the **global** follow target. Project operations use the manifest entry's
  `source/ref/path` (§2.2) and never change `record.source`, `current` or `global`. A global `add` of an
  existing id replaces `record.source` with the new source.
- Version key: 12 hex; matching an existing key always compares the **full** commit/hash. A different
  full value with the same 12-hex prefix gets a 16-hex key instead (never discarded, never merged).
- A version folder is written once and not modified, with **one exception**: `install --force` repairing
  a folder whose hash no longer matches its record (§2.4).
- Old versions are not deleted automatically (the store doesn't know which other projects pin them).
  `remove -g` deletes the skill with all versions. A `prune` command is a later addition.
- **Writes.** Network work (clone, discovery, hashing) happens in a temp dir **before** taking the lock.
  Then take `index.lock` (O_EXCL, contains PID + host), re-read `index.json`, rename the staged folder
  into place as a new version folder (discarded if that full version already exists), update the record,
  release. A lock held by a dead PID on this host is reclaimed; a lock from another host, or unreadable,
  fails with `index.lock held by <pid>@<host>; delete <path> if no skill-library is running` (exit 2).
  `index.json` and `skill-library.json` are each written to a temp file and renamed. No journals.

### 2.2 `skill-library.json` (project root, committed)

```jsonc
{
  "version": 1,
  "skills": {
    "repo://github.com/anthropics/skills/frontend-design": {
      "source": "https://github.com/anthropics/skills.git",
      "ref": null,
      "path": "skills/frontend-design",
      "commit": "3f2a9c1d07e4…",
      "hash": "sha256-…",
      "agents": ["claude-code"]
    },
    "local://skills/foo": { "agents": "all" },
    "home://my-skills/bar": { "source": "~/my-skills/bar", "hash": "sha256-…", "agents": "all" }
  }
}
```

- Every stored entry carries what is needed to fetch and verify it again: `source` + `hash`, plus `ref`,
  `path`, `commit` for git. `home://`/`path://` entries keep their `hash` — it selects their version
  folder. `local://` entries have neither (read in place).
- `agents` here is this project's assignment, independent of the store record's global `agents`.
- Keys sorted, 2-space JSON, trailing newline.

**Project root** = nearest ancestor of cwd containing `skill-library.json`; if none, cwd (like vercel;
no git-root discovery — run your first project `add` from the intended root). If there is no manifest
and cwd is `$HOME`, project-scope commands behave as `-g` and print `No project here; using global
scope.` (stderr). `query`/`list` there are global-only.

### 2.3 Folders inside the project (`local://`)

Read **in place** from the checkout: no store copy, nothing to install elsewhere (git carries them),
always current. Not hashed.

### 2.4 Hashing, pinning, `install`, `update`

- **Hash** (our own, not vercel's): walk the skill folder with the same rules the copier uses (skip
  `.git`, `node_modules`, `__pycache__`, `.DS_Store`; regular files only); relative POSIX paths, UTF-8,
  sorted by byte value; per file feed `uint64-BE(len(pathBytes)) ‖ pathBytes ‖ uint64-BE(len(content)) ‖
  content` into one `sha256`; written as `sha256-<lowercase hex>`. One function, always run on the
  staged copy, in `add`, `install` and `update`. A fixed test vector pins the format.
- All git commands run with `-c core.autocrlf=false` so checkouts hash the same on every OS.
- **Pin = version.** A project entry's `commit` (git) or `hash` (`home://`/`path://`) names a version
  folder. `add` in a project pins whatever it fetched; if that version isn't in the store yet it becomes
  a new version folder. Two projects can pin different versions of the same skill side by side.
- **Global `add` of an existing id** adds the fetched version (if new), makes it `current`, and replaces
  `record.source`.
- **`install`** (no source), per stored entry:
  - pinned version present → nothing to do;
  - git, missing → fetch exactly `commit` (`git fetch --depth 1 origin <sha>`, fallback full clone),
    hash, **refuse on mismatch** (nothing written);
  - `home://`/`path://`, missing → copy from `source`, hash, refuse on mismatch with
    `bar changed since it was pinned; run skill-library add <source> to re-pin`; missing folder → reported;
  - `--force`: additionally re-hash every present pinned version folder; only a folder whose hash no
    longer matches is re-fetched, verified and swapped in (old → backup, staged → folder, delete backup;
    rollback on failure — today's `commitSkillDir(replace)`, `src/lib/store.ts:174–205`). Pins, `current`
    and `record.source` never change.
  - Exit 1 if anything was refused or missing, else 0. `--frozen-lockfile` (or CI, as vercel) with an
    empty manifest → exit 1; otherwise frozen flags are no-ops (install never rewrites the manifest).
- **`update`** pulls the newest content from the original source:
  - project scope: follows the manifest entry's `source/ref/path`; adds the version; moves only this
    project's pin;
  - `-g`: follows `record.source`; adds the version; moves `current`. Non-global records are skipped.
  - Other projects keep their pins. Local sources are skipped as `Local path` (D10).
- **`check`/`update` compare the skill folder's tree id** (`git fetch --depth 1 --filter=blob:none
  origin <ref>` then `rev-parse FETCH_HEAD:<path>`), so commits to other skills in a monorepo are not
  updates. Path gone upstream → `removed upstream`, skipped. `check -g` skips non-global records.

## 3. Commands (vercel 1.7.6 contract)

General rules:
- Output style as vercel (`@clack/prompts`, `picocolors`), `skills` → `skill-library` in every message.
  Diagnostics use vercel's wording and streams: `Invalid agents: x` / `Valid agents: a, b, …`
  (`src/diagnostics.ts:20–23`); `Unknown command: x` / `Run skill-library --help for usage.` on stdout,
  exit 1 (`src/cli.ts:453–456`).
- Logo only for `find`, `init`, `install`/`experimental_install` and `add` (not with `--json`), and only
  when stdout is a TTY and no agent is detected (`src/cli.ts:339–404`).
- **Agent detection:** port of `@vercel/detect-agent`'s env-var checks plus vercel's Cursor fix-up
  (`src/detect-agent.ts`), with attribution; no dependency.
- **Inside a detected agent, `add` and `remove` behave as with `-y`** (vercel, `src/add.ts:2299–2302`).
  The detected agent is not recorded **(differs**: vercel also selects it).
- `-y` defaults: scope = project unless `-g`; every discovered skill when `-s` is absent; agents `all`.
- Every listed short flag also has vercel's long spelling (`-g/--global`, `-y/--yes`, `-s/--skill`,
  `-a/--agent`, `-p/--project`, `-l/--list`).
- Unknown flags: ignored with one stderr warning **(differs**: vercel ignores silently), except `use`,
  which errors like vercel (`src/use.ts:131–132`).
- Prompts need a TTY; without one (and no agent detected), vercel's "pass -y" message and exit 1.
- **`--json` mode:** stdout carries exactly one JSON value; every notice (`$HOME` note,
  gateway line, warnings) goes to stderr; no logo, no ANSI.
- Argument validation runs before anything else.

### 3.1 Phase 1 (0.1.0)

| Command | Aliases | Flags | Behaviour |
|---|---|---|---|
| `add <source>` | `a`, `install <source>`, `i <source>` | `-g`, `-a <agents...>`, `-s <skills...>`, `-l`, `-y`, `--all`, `--full-depth`, `--copy`, `--json` | Fetch, discover (vercel's discovery rules), prompt for skills and scope, write store + `skill-library.json` (unless `-g`), then place the gateway (§6). **No agent prompt**: only `-a` records agents; default `all`. `-l` lists, writes nothing. `--copy` accepted, no effect. `--all` = `-s '*' -a '*' -y` (as vercel; overrides `-a`). `--json` needs `-y` (or a detected agent), rejects `-l`. |
| `install` (no source) | `i`, `experimental_install` | `--dry-run`, `--force`, `--frozen-lockfile`, `--no-frozen-lockfile`, `-a` | §2.4. `-a` accepted, no effect. |
| `list` | `ls` | `-g`, `-a <agents...>`, `--json` | Project: its skills (`installed` / `missing`). `-g`: all store skills; non-global ones tagged `(not global)`. `-a` filters like `query`. |
| `remove [skills...]` | `rm`, `r` | `-g`, `-a <agents...>`, `-s <skills...>`, `-y`, `--all` | D5 + §4 rules. `-g` can target non-global store skills; warns if the current project still references it. Project `remove x` matching only a global skill → `x is global; use -g`. No match exits 0 (vercel). |
| `update [skills...]` | `upgrade` | `-g`, `-p`, `-y` | §2.4. Scope: no flag → project if `skill-library.json` has entries, else global; `-g -p` = both; named skills → both **(differs**: vercel's named branch is global-first, `src/update.ts:217–225`). No scope prompt (D14). |
| `check [skills...]` | | `-g`, `-p`, `-y` | Same scope rules; writes nothing; exit 1 if any update or failure. |
| `find [query]` | `search`, `f`, `s` | `--owner <name>` | skills.sh search (`SKILLS_API_URL`). With a query: print results and return. Without: interactive picker on a TTY (selection runs our `add`), usage hint otherwise. |
| `init [name]` | | | No name → `./SKILL.md`; name → `<name>/SKILL.md`; existing → message, exit 0. |
| `use <source>[@skill]` | | `-s <name>`, `-a <claude-code\|codex\|sarvam-code>`, `--full-depth` | As vercel (`src/use.ts`): fetch into a temp dir. **No `-a`: print vercel's prompt** (`buildUsePrompt`, SKILL.md + support-dir note) to stdout, for piping into an agent. **`-a`: spawn that agent** with the prompt as last argument and pass its exit code through; missing binary → `… command not found`. `-a '*'`, several agents, or unsupported agents → vercel's errors. Several skills and no selector → error (no picker); `@skill` vs `-s` conflict → error. Temp dir kept when it has support files. No logo; no store, manifest or agent-folder writes. |
| no args | | | Banner (TTY, no agent) + hint lines, exit 0. |
| `--help`/`-h`, `<cmd> --help` | | | vercel layout (general help for every command except `remove`), plus an "Add-ons" section (`query`). |
| `--version`/`-v` | | | Bare version (`0.1.0`). |

Source forms in phase 1: GitHub shorthand, `owner/repo@skill`, `#ref`, `github:` prefix, GitHub tree
URLs, any https/ssh/scp-style git URL, local folders and `.md` files. Fetch with the system `git`
(shallow clone into a temp dir). Private GitHub: `GITHUB_TOKEN`/`GH_TOKEN`, passed only for
`github.com` via `GIT_CONFIG_COUNT/KEY_0/VALUE_0` env vars (never argv or URL), stripped from any
printed error.

JSON shapes (vercel's):
- `list --json`: top-level array of `{name, path, scope, agents, source, sourceUrl, sourceType, status}`.
  `path` = the selected version folder (`current`, or the pin in a project; in-place folder for
  `local://`). `agents` = display names (`all` → every registry display name). `status` keeps vercel's
  meaning: `tracked` = known to this scope (store record or manifest entry), `untracked` = in the store
  but not usable here (`(not global)`), `missing` = referenced but not installed (`path: null`).
- `add --json`: top-level array, one row per skill, `status` = `installed` | `skipped` | `failed`, `path` =
  the version folder (or in-place folder). No audit fields. Exit 1 if any row failed.

Today's global flags: keep `--store <dir>` and `--verbose` (never `-v`); drop `--pretty` and
`--return-content` (old-command guard, §3.3); `--json` becomes per-command.

### 3.2 Deferred and dropped

Deferred: well-known / archive / skills.sh-pack / Notion sources, GitLab `/-/tree/` URLs, `--subagent`,
`--metadata`, the interactive agent prompt, the interactive scope prompt for `update`. Recognised
deferred source forms print `… is not supported by skill-library yet` and exit 1 (never misparsed as
generic git).

Dropped: `experimental_sync` / `sync` → `Unknown command` like any other.

## 4. Agents

- Registry: ported from vercel's agent table (id, display name, global skills dir, detection), with
  attribution. It is the list of valid `-a` values.
- Invalid `-a` anywhere → vercel's `Invalid agents` / `Valid agents` diagnostic, exit 1.
- `agents` value per scope (store record = global usage; project entry = that project):
  - `add` without `-a` (or `-a '*'`) → `all`. `add -a x` when the scope's value is `all` → stays `all`.
    `add -a x` on `[y]` → `[y, x]`. First `add -g -a x` of a project-only record → `[x]`.
  - `remove -a x` on `[x, y]` → `[y]`; on `[x]` → removes the reference (project) or the skill (`-g`).
    On `all` → `x is available to all agents; remove it without -a`, exit 0.
- The agent a command runs inside is never recorded.
- Query filter: a skill passes `-a x` if its applicable value (project entry inside a project, else
  store record) is `all` or contains `x`.

## 5. Add-ons

### 5.1 `query`

```
skill-library query "<task>" | -  [-a|--agent <agent>] [--threshold 0..1 (0.7)] [--top n] [--json]
```

Candidate selection, in this order:
1. Collect: `local://` skills, referenced skills (pinned version), global store skills (`current`).
2. **Shadow by name first:** priority `local://` > referenced > global. A lower-priority skill with the
   same name is dropped **even if the winner is later unavailable or filtered out** (a missing or
   Claude-only project skill never lets a same-name global skill through). Different ids at the same
   priority are both kept.
3. Drop unavailable ones (pinned version not installed → stderr
   `2 project skills are not installed — run skill-library install`).
4. Apply the `-a` filter (§4). Without `-a`: no filter.
5. Skip empty descriptions (warning).

Jev: same question template, criteria and thresholds, using each candidate's version metadata;
question keys `s0…sN` instead of ids.

Output:

```
Read these skill files before continuing with the task:

frontend-design (91%)
└ /home/ian/.local/share/skill-library/skills/frontend-design-3f9c1a2e/8e01b7a4c2f9/SKILL.md

nextjs-build (78%, project)
└ /repo/skills/nextjs-build/SKILL.md
```

No match: `No matching skills. Continue without one.`
`--json`: `{"matches":[{id,name,description,path,probability,scope}]}`.
Exit codes: 0 / 1 (usage, incl. invalid agent) / 2 (runtime: API key, network, lock).

## 6. Gateway

- **One byte-identical gateway everywhere** (no per-agent templates): it tells the agent to run
  `skill-library query -a <your agent id> "<task>"` and says an invalid id prints the valid list.
- Source: `skills/skill-library/SKILL.md`, embedded at build time (`--loader:.md=text`, typed by
  `src/md.d.ts`). Content: when to query, the query command and its output, and failures (missing
  key, network). **`query` is the only command the gateway names**: no `list`, no management
  commands, no sync, no store layout. It doesn't
  mention `--json` or the tuning flags (`--threshold`, `--top`, stdin `-`): only `-a`. The agent reads only the paths `query` prints and is told not
  to look for skills anywhere else, so it never browses the library folder, the sync clone or its
  git history. When `query` exits non-zero, the agent reports the cause and continues without skills; stderr notes
  on a successful query are passed on to the user. A missing CLI or key points to the repo's quick start.
- **Placement only during `add`** (after a successful add, not with `-l`; also when the source held only
  the gateway): for each installed agent with a global skills dir (plus agents named with `-a`), grouped
  by resolved physical dir, if `<dir>/skill-library/SKILL.md` is missing or differs, write it and print
  one stderr line `Updated skill-library gateway for Claude Code, Codex`. Agents without a global dir are
  skipped. Opt-out `SKILL_LIBRARY_NO_GATEWAY=1`. The API never places it.
- **Failures are never fatal** (read-only sandboxes): exit code unchanged, at most one stderr line.
- **Ownership / symlinks:** `lstat` first. A symlinked `skill-library` folder (e.g. a vercel install) is
  unlinked (never its target) and replaced with a real folder. A real folder is overwritten only if its
  frontmatter `name` is `skill-library`.
- Repo `skills/` keeps only `skill-library/`.

## 7. Programmatic API

```ts
import { add, install, list, remove, update, check, query } from "skill-library";
```

- Separate side-effect-free entry `src/api.ts` → `dist/index.js`; `src/index.ts` (CLI) → `dist/skill-library`.
- Options mirror the CLI flags (`{ cwd, global, agents, skills, force, … }`); returns plain data; never
  prompts, prints or places the gateway. `add` without `skills` adds every discovered skill.
- Types: `tsconfig.build.json` extends `tsconfig.json` with `noEmit: false`, `declaration`,
  `emitDeclarationOnly`, `rootDir: "src"`, `outDir: "dist"`, `files: ["src/api.ts"]`,
  `rewriteRelativeImportExtensions`. A test checks a consumer resolves the types (also with
  `moduleResolution: node10`).

## 8. Packaging and release

- `package.json`: drop `"private"`; `"main": "dist/index.js"`, `"types": "dist/api.d.ts"`,
  `"exports": { ".": { "types": "./dist/api.d.ts", "default": "./dist/index.js" } }`; `bin`
  `skill-library` → `dist/skill-library`; `files: ["dist", "README.md", "LICENSE", "ThirdPartyNotices.txt"]`;
  `license: "MIT"`; `repository: "github:ianwijma/skill-library-skill"`;
  `prepublishOnly`: typecheck, test, build, `npm pack --dry-run`.
- `LICENSE` (MIT). Attribution for the ported agent table, agent detection and any ported vercel code
  (vercel-labs/skills is MIT).
- `@clack/prompts`, `picocolors`, `@typesafe-ai/sdk` are bundled → devDependencies; no runtime
  dependencies. Build generates `ThirdPartyNotices.txt` with their license texts. `git` is a runtime
  requirement for remote sources.
- Build: two esbuild entries (API, CLI), `--loader:.md=text`, then `tsc -p tsconfig.build.json`.
- Smoke check on the packed tarball, installed outside the repo: bin runs, `import` works, types
  resolve, gateway embedded.
- Release: confirm `npm view skill-library` is still free, `npm publish` 0.1.0, tag `v0.1.0`.

## 9. Docs

- README: `npm i -g skill-library` / `npx skill-library`; the gateway is placed by `add`; command table
  (vercel-compatible + `query`); `skill-library.json`, ids and versions; `SKILL_LIBRARY_TYPESAFE_API_KEY`.
- `docs/`: contract docs updated; old per-command docs removed.

## 10. Tests

- **Isolation:** every spawned CLI gets a temp `HOME`, `XDG_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `SKILL_LIBRARY_DIR`; `SKILL_LIBRARY_NO_GATEWAY=1` except in gateway tests. Git fixtures set
  `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL`, `GIT_CONFIG_NOSYSTEM=1`. Nothing touches the real
  home.
- **Unit:** id derivation for every source form (GitHub https/ssh/scp/shorthand → same id; duplicate names
  in one source refused; folder source with two skills → two ids; gateway source skipped); project-root
  lookup (nested first use, ancestor manifest, `$HOME`); agent rules (§4, every row); query candidate
  order (§5.1: missing project winner shadows global; Claude-only project winner + `-a codex` shadows
  global; same-priority clash keeps both); hash (fixed test vector, non-ASCII path, binary file, skipped
  files); version-key prefix collision; manifest serialisation.
- **Integration** with local bare git repos (`file://`; one fixture with
  `uploadpack.allowAnySHA1InWant=true` for the fetch-by-commit path, one without for the fallback): add
  global/project, global add of existing id replaces `record.source`, list, remove (D5, orphans,
  `-g` warning), install at pin, hash-mismatch refusal, `home://` folder edited after pinning →
  refused with re-pin hint, `install --force` repairing a corrupted folder (and rollback when the swap
  fails), two projects pinning different versions side by side, per-version descriptions (project pinned
  to the old one is scored on the old description), update moving only this project's pin and `-g`
  moving only `current`, check on a monorepo (other skill changed → no update), `--frozen-lockfile` with
  an empty manifest, JSON shapes (one JSON value on stdout even when the gateway is placed) and exit codes, add inside a detected agent (implicit `-y`), one concurrent-add test,
  foreign-host lock.
- **`use`:** stdout prompt without `-a`, stub `claude` on `PATH` with `-a` (exit code passed through),
  conflicting selectors, several skills without selector.
- **`find`:** `SKILLS_API_URL` pointed at a local stub.
- **Gateway:** placed only by `add` (no other command writes agent folders), symlinked old install,
  shared dirs, read-only dir (non-fatal), adding this repo's gateway source stores nothing.
- **Jev** mocked; golden test: request body identical to today's except question keys.
- Help/diagnostic text snapshots.

## 11. Milestones

| M | Content |
|---|---|
| M1 | Store with version folders, ids, hash, lock; `query` (text, `-a`, candidate order, opaque keys) |
| M2 | Source parsing, git fetch, discovery; `add`/`list`/`remove` global and project; `skill-library.json` |
| M3 | `install` (pinned, verified, `--force` repair), `update`, `check` (tree ids) |
| M4 | Gateway: merged SKILL.md, embedding, placement by `add`, symlink replacement; delete other skills from `skills/` |
| M5 | vercel-style output and diagnostics, agent detection, `init`, `use`, `--json`, help, `find` (first to slip if needed) |
| M6 | API entry, types, README/docs, LICENSE, notices, packaging, smoke check, publish 0.1.0 |

## 12. Open questions

None.
