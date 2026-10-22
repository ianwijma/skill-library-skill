# Skill Library (skill-library)

Skills on demand — not always loaded.

One tiny gateway skill checks what a task needs. The `skill-library` binary
scores the catalog with [TypeSafe](https://docs.typesafe.ai)'s Jev model.
The agent reads only the skills that matter.

## What you get

| Deliverable | What it is |
|---|---|
| `skill-library` | Binary. Commands: `query`, `list`, `add`, `update`, `remove`, `get` |
| `skill-library` skills | The gateway. Plus one skill per command |
| `skill-importer` | Skill. Imports new and changed skills — whole directories, multi-file skills included — and removes their sources from the auto-load dirs. Journals every change |
| `skill-importer-undo` | Skill. Reverses an import run |

Status: **implemented** (v0.1.0). Docs below are the build contract.

## Docs

| Doc | Contents |
|---|---|
| [01 — overview](docs/01-overview.md) | Problem, goals, architecture |
| [02 — CLI spec](docs/02-cli-spec.md) | Commands, flags, JSON, exit codes |
| [03 — data store](docs/03-data-store.md) | Store layout, index schema, atomicity |
| [04 — query](docs/04-typesafe-query.md) | Jev integration, retries, thresholds |
| [05 — skills](docs/05-skills.md) | Skill behavior + full SKILL.md drafts |
| [06 — import runbook](docs/06-import-runbook.md) | Import flows, rollback |
| [07 — implementation plan](docs/07-implementation-plan.md) | Repo layout, milestones, tests |

## Quick start

Requires: [bun](https://bun.sh) >= 1.3 — it builds the binary. `query` also
needs `TYPESAFE_API_KEY`.

A skill is one file: `SKILL.md`.
The files for this repo live under `skills/`.
Installing a skill = putting its file in your agent's skills folder.
The `skill-library` binary behind them is built from `src/`.

### 1. Install the skills

**Option 1: `npx skills add`. Preferred.**

```sh
npx skills add ianwijma/skill-library-skill
```

Pick skills and agent when asked.

No prompts? Use this:

```sh
npx skills add ianwijma/skill-library-skill -g -a opencode -s '*' -y
```

**Option 2: ask your agent.**

Paste this into any agent (Claude Code, opencode, Cursor, …):

```text
Install the skill-library skills.

Run: npx skills add ianwijma/skill-library-skill --skill '*'
Select my agent when asked.

If npx is unavailable: save the SKILL.md files from
https://raw.githubusercontent.com/ianwijma/skill-library-skill/HEAD/skills/skill-library/SKILL.md
and the 8 companion skills at the same paths into my agent's skills folder.
Companions: skill-library-query, skill-library-list, skill-library-get,
skill-library-add, skill-library-update, skill-library-remove,
skill-importer, skill-importer-undo.
Use one method.

Then build the skill-library binary:

If ~/.config/skill-library-skill already exists, cd into it and pull it
(git pull) instead of cloning.

git clone https://github.com/ianwijma/skill-library-skill ~/.config/skill-library-skill
cd ~/.config/skill-library-skill
bun install && bun run build
install -m 755 dist/skill-library ~/.local/bin/skill-library

Restart the agent.
Use the skill-library skill whenever a skill might help — query often.
```

### 2. Build the binary

The skills drive the `skill-library` binary. Build it:

```sh
git clone https://github.com/ianwijma/skill-library-skill
cd skill-library-skill
bun install
bun run build
install -m 755 dist/skill-library ~/.local/bin/skill-library
```

`~/.local/bin` must be on your `PATH`.

### 3. Configure online scoring

Set your TypeSafe API key in the environment that launches your agent:

```sh
export TYPESAFE_API_KEY='<your TypeSafe API key>'
```

`query` sends the task text and cataloged skill names/descriptions to TypeSafe.
It needs outbound HTTPS access to `api.typesafe.ai`. An agent's sandbox can
block this even when the command works in your terminal. The other commands
use the local store and need neither an API key nor network access.

### 4. Try it

```sh
skill-library list
skill-library query "fix a failing next.js build"
```

Restart your agent so the skills load.

## Troubleshooting query failures

The gateway's “unavailable” message is a fallback, not a diagnosis. Run
`skill-library query "<task>"` and inspect stderr for the actual failure:

| Diagnostic | What to check |
|---|---|
| Command not found | Build the binary and put `~/.local/bin` on the agent's `PATH`; `npx skills add` installs only the skills |
| Missing `TYPESAFE_API_KEY` / HTTP 401 | Set a valid key in the environment that launches the agent |
| Connection error / timeout | Network access, DNS, proxy settings, and sandbox restrictions; use the agent's supported permission flow if available |
| Store error | Follow the reported store diagnostic; this is independent of TypeSafe |

There is no local service or daemon to start. A failed connection alone does
not establish a TypeSafe outage. If online scoring remains unavailable, run
`skill-library list`, select relevant skills by name/description, and read the
returned `path` files. Pass the same `--store` if you used a store override.
