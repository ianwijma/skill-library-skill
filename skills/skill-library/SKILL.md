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

Run the command before declaring a failure. If it fails, use its stderr and
exit code to explain the specific cause briefly:

- Binary missing: check `command -v skill-library` and `PATH`. Installing via
  `npx skills add` installs the skills only; build and install the binary using
  the [README](https://github.com/ianwijma/skill-library-skill).
- Missing `TYPESAFE_API_KEY` or HTTP 401: query needs a valid key in the agent's
  environment. Never print the key.
- Connection error or timeout: online scoring could not reach TypeSafe. Check
  network/DNS, proxy settings, and agent sandbox restrictions. This does not
  establish that the service is down; there is no local daemon to start. If the
  environment reports restricted networking, retry through its supported
  network-permission mechanism when allowed. Respect denials and use the local
  fallback when network access is unavailable.
- Other exit-2 errors: report the actual diagnostic (for example, an unreadable
  store), rather than labeling every runtime failure a service outage.

When online scoring fails, run `skill-library list` (with the same `--store`, if
used). It needs neither network access nor an API key. Select relevant skills
from the returned names and descriptions, then read their `path` files before
continuing. If the local catalog also fails or has no relevant skills, continue
with available guidance. Never block the user's task on the library, and avoid
repeating a known failing query during the same task unless conditions change.
