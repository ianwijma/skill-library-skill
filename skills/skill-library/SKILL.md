---
name: skill-library
description: MUST be used before working on every user message. Skills are not loaded into context automatically; this skill queries the skill library (skill-library CLI) to discover and read the skills relevant to the current task. Always relevant, for every task and every message.
---

# Skill Library

Skills are NOT loaded into context automatically. They live in a managed library
and must be loaded on demand, per task.

## Workflow — every user message

1. Summarize the user's message into a 1–3 sentence task description (include key
   technologies, file types, and the goal), then run:

   ```sh
   skill-library query "<task description>"
   ```

2. If matches are returned: Read each returned `path` (absolute paths to skill
   markdown files) and absorb the instructions **before** working on the task.
3. If `matches` is empty, proceed on your own judgment.
4. Re-run the query for each new user message — different messages need different
   skills. (For a rapid follow-up that trivially continues the same task with the
   same context, reusing the skills already read is acceptable; when in doubt,
   re-query.)

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
library.
