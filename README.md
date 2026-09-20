# Skill Library (skill-library)

Replace always-loaded skills with a single on-demand gateway: one tiny skill that
routes the LLM into a skill library app, which scores the catalog against the
current task with [TypeSafe](https://docs.typesafe.ai)'s Jev model and returns the
paths of the skills worth reading.

Three deliverables, built in this repo:

| Deliverable | What it is |
|---|---|
| `skill-library` | Compiled Bun/TypeScript binary — the skill library app (`query`, `list`, `add`, `update`, `remove`, `get`) |
| `skill-library` skills | Installed into `~/.config/opencode/skills/`: the always-on gateway (run `skill-library query` before every user message, read returned files) plus one skill per subcommand (query, list, get, add, update, remove) |
| `skill-importer` skill | Rerunnable onboarding skill: diffs skill directories against the library and imports new/changed skills (whole directories — multi-file skills included) via `skill-library add` / `skill-library update`, journaling every change |
| `skill-importer-undo` skill | Reverses an import run (or the cutover) from its journal: removes added skills, restores prior name/description/content |

Status: **implemented** (skill-library v0.1.0) — the documents below remain the build contract.

## Document index

| Doc | Contents |
|---|---|
| [docs/01-overview.md](docs/01-overview.md) | Problem, goals, architecture, decision log, data flow |
| [docs/02-cli-spec.md](docs/02-cli-spec.md) | Full CLI contract: every command, flags, JSON shapes, exit codes |
| [docs/03-data-store.md](docs/03-data-store.md) | Store layout, index schema, ID generation, atomicity |
| [docs/04-typesafe-query.md](docs/04-typesafe-query.md) | Jev integration: request/response shapes, question design, retries, thresholds |
| [docs/05-skills.md](docs/05-skills.md) | The two wrapper skills: behavior + full SKILL.md drafts |
| [docs/06-cutover-runbook.md](docs/06-cutover-runbook.md) | Rerunnable import flows, cutover completion, rollback |
| [docs/07-implementation-plan.md](docs/07-implementation-plan.md) | Repo layout, milestones, test plan, risks, future work |

## Quick start (planned)

```sh
./install.sh                 # build binary → ~/.local/bin/skill-library (+ sli alias),
                             # install the two skills into ~/.config/opencode/skills/
skill-library list                     # browse the catalog
skill-library query "fix a failing next.js build"
```

Environment: `bun >= 1.3` to build; `TYPESAFE_API_KEY` for `skill-library query`.
