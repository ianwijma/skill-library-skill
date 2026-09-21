---
name: skill-library
description: Use whenever a task might benefit from a skill — query often, erring on the side of querying. Skills are not loaded into context automatically; this skill queries the skill library (skill-library CLI) to discover and read the skills relevant to the current task.
---

# Skill Library

Skills are NOT loaded into context automatically. They live in a managed library
and must be loaded on demand, per task.

## Workflow — query whenever a skill might help

1. Whenever you think a skill might be needed — before starting a task, when the
   work shifts into new territory, or when unsure — summarize the task into a
   1–3 sentence description (include key technologies, file types, and the goal),
   then run:

   ```sh
   skill-library query "<task description>"
   ```

   This fires very often, and that is fine: a query is cheap; a missed skill is
   not.

2. If matches are returned: Read each returned `path` (absolute paths to skill
   markdown files) and absorb the instructions **before** working on the task.
3. If `matches` is empty, proceed on your own judgment.
4. For a rapid follow-up that trivially continues the same task with the same
   context, reusing the skills already read is acceptable; when in doubt,
   re-query.

## Managing skills

Each subcommand has its own skill with the full contract — read it when doing
that operation:

- `skill-library-query` — scoring the catalog (thresholds, `--top`, stdin, tuning)
- `skill-library-list` — browsing the catalog
- `skill-library-get` — inspecting one skill / retrieving its content
- `skill-library-add` — importing a skill (directory or file)
- `skill-library-update` — renaming, rewriting descriptions, re-importing content
- `skill-library-remove` — deleting a skill

All commands output JSON on stdout, errors on stderr; exit codes 0/1/2.
`skill-library --help` for the overview.

## Fallback

If `skill-library` is missing or exits 2: tell the user the skill library is
unavailable and continue with built-in knowledge — never block the task on the
library. If the binary is missing because the skills were installed without it
(e.g. via `npx skills add`), tell the user to build and install it — the README
at https://github.com/ianwijma/skill-library-skill has the exact commands.
