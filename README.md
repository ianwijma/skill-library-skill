# Skill Library (sli)

Replace always-loaded skills with a single on-demand gateway: one tiny skill that
routes the LLM into a skill library app, which scores the catalog against the
current task with [TypeSafe](https://docs.typesafe.ai)'s Jev model and returns the
paths of the skills worth reading.

Three deliverables, built in this repo:

| Deliverable | What it is |
|---|---|
| `sli` | Compiled Bun/TypeScript binary — the skill library app (`query`, `list`, `add`, `update`, `remove`, `get`) |
| `skill-library` skill | Installed into `~/.config/opencode/skills/`; instructs the LLM to run `sli query` before every user message and read the returned skill files |
| `skill-importer` skill | Rerunnable onboarding skill: diffs skill directories against the library and imports new/changed skills via `sli add` / `sli update` |

Status: **planning** — the documents below are the build contract.

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
./install.sh                 # build binary → ~/.local/bin/sli (+ skill-library alias),
                             # install the two skills into ~/.config/opencode/skills/
sli list                     # browse the catalog
sli query "fix a failing next.js build"
```

Environment: `bun >= 1.3` to build; `TYPESAFE_API_KEY` for `sli query`.
