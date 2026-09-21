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

git clone https://github.com/ianwijma/skill-library-skill
cd skill-library-skill
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

### 3. Try it

```sh
skill-library list
skill-library query "fix a failing next.js build"
```

Restart your agent so the skills load.
