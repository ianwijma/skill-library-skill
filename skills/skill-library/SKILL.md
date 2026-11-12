---
name: skill-library
description: TRIGGER — run `skill-library query -a <your-agent-id> "<task in 1-3 sentences>"` at the start of every task, and again whenever the work moves to a new language, framework, tool, file type or kind of work (tests, CI, release, docs, deploy). Do it even when the task looks well defined, because you cannot know which skills the library holds without querying. Then read every SKILL.md path it prints before continuing. Agent ids look like claude-code, codex, opencode, cursor or gemini-cli; an unknown id prints the valid list. Skills are not loaded into context automatically, so this query is the only way to find them. Load this skill for how to read the output and what to do when the query fails.
---

# Skill Library

## Workflow

1. Query at the start of every task, and again whenever the work moves to a
   new language, framework, tool, file type or kind of work (tests, CI,
   release, docs, deploy). Do it even when the task looks well defined: you
   can't know which skills the library holds without querying. Summarize the
   task in 1–3 sentences (key technologies, file types, and the goal) and run:

   ```sh
   skill-library query -a <your-agent-id> "<task description>"
   ```

   Agent ids look like `claude-code`, `codex`, `opencode`, `cursor`,
   `gemini-cli`. An unknown id prints `Valid agents: …`; pick yours and run
   again. Query often: a query is cheap, a missed skill is not.

2. Read every `SKILL.md` listed (the `└ <path>` lines) **before** working on
   the task, and follow it. These paths are the only skills to use: don't look
   for skills anywhere else. `(always)` skills come back for every task; read
   them too. `No matching skills.` means continue on your own judgment.
3. If the output ends with `Your skills changed — tell the user:`, or the query
   succeeds but prints a note on stderr, pass it on to the user briefly.
4. A quick follow-up on the same task can reuse the skills already read; when in
   doubt, query again.

## When the query fails

If the query exits non-zero, tell the user the cause in a sentence and continue
the task without skills. Don't retry a query that keeps failing the same way.

- CLI missing (`command not found`): the user can set it up by following
  https://github.com/ianwijma/skill-library-skill#quick-start.
- Missing `SKILL_LIBRARY_TYPESAFE_API_KEY` or HTTP 401: the agent's environment
  needs a valid TypeSafe key (same setup link). Never print the key.
- Connection error or timeout: TypeSafe was unreachable (network, proxy or
  sandbox restrictions, not necessarily an outage). If your environment offers
  a way to request network access, use it, and respect a denial.
- Anything else: report the actual error message.
