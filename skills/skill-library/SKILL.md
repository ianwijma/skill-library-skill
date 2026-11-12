---
name: skill-library
description: Use whenever a task might benefit from a skill — query often, erring on the side of querying. Skills are not loaded into context automatically; this skill queries the skill library (skill-library CLI) to discover and read the skills relevant to the current task.
---

# Skill Library

Skills are NOT loaded into context automatically. Load them on demand, per task,
with `skill-library query`. It is the only way to find skills: read only the
`SKILL.md` paths it prints, and don't look for skills anywhere else.

## Workflow: query whenever a skill might help

1. Whenever you think a skill might be needed (before starting a task, when the
   work shifts into new territory, or when unsure), summarize the task into a
   1–3 sentence description (include key technologies, file types, and the goal),
   then run, passing your own agent id:

   ```sh
   skill-library query -a <your-agent-id> "<task description>"
   ```

   Agent ids look like `claude-code`, `codex`, `opencode`, `cursor`,
   `gemini-cli`. If you pass an id the CLI doesn't know, it prints
   `Invalid agents: …` followed by `Valid agents: …`. Pick yours from that list
   and run the query again.

   This fires very often, and that is fine: a query is cheap; a missed skill is
   not.

2. The output lists matching skills, each followed by a `└ <path>` line. Read
   every listed `SKILL.md` path **before** working on the task and follow it.
   Skills marked `(always)` are the user's always-on skills: they are returned
   for every task, so read them too.
3. `No matching skills. Continue without one.` → proceed on your own judgment.
4. If the output ends with `Your skills changed — tell the user:`, tell the
   user which skills were added, removed or updated, briefly, alongside your
   answer.
5. For a rapid follow-up that trivially continues the same task with the same
   context, reusing the skills already read is acceptable; when in doubt,
   re-query.

## Query options

- Long or multiline task text: `skill-library query -a <id> - <<'EOF' … EOF`
  (`-` reads the task from stdin).
- `--threshold <0..1>`: minimum probability (default 0.7). Use `0.8` to be
  stricter, `0.5` to recover misses.
- `--top <n>`: cap the number of matches.
- Use the plain output. Don't add `--json`: it is for scripts, and the plain
  output is what this workflow expects.
- Any other line the command prints on stderr is meant for the user: pass it on
  briefly.

## When the query fails

Run the command before declaring a failure. If it fails, use its stderr and exit
code to tell the user the specific cause briefly, then continue the task without
skills. Never block the user's task on the library, and don't repeat a query that
keeps failing in the same way during the same task.

- CLI missing (`command not found`): the user can install it with
  `npm i -g skill-library`.
- Missing `SKILL_LIBRARY_TYPESAFE_API_KEY` or HTTP 401: query needs a valid
  TypeSafe key in the agent's environment. Never print the key.
- Connection error or timeout: the query could not reach TypeSafe. Check
  network/DNS, proxy settings, and agent sandbox restrictions. This does not
  establish that the service is down. If the environment reports restricted
  networking, retry through its supported network-permission mechanism when
  allowed, and respect denials.
- Other exit-2 errors: report the actual diagnostic rather than labeling every
  failure a service outage.
