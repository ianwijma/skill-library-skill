---
name: skill-library
description: TRIGGER — run `skill-library query -a <your-agent-id> "<task in 1-3 sentences>"` at the start of every task, and again whenever the work moves to a new language, framework, tool, file type or kind of work (tests, CI, release, docs, deploy). Do it even when the task looks well defined, because you cannot know which skills the library holds without querying. Then read every SKILL.md path it prints before continuing. Agent ids look like claude-code, codex, opencode, cursor or gemini-cli; an unknown id prints the valid list. Skills are not loaded into context automatically, so this query is the only way to find them. Load this skill for output details, options, failures and the offline fallback.
---

# Skill Library

Skills are NOT loaded into context automatically. They live in a managed library
and must be loaded on demand, per task.

## Workflow — query at the start of every task and on every shift

1. Run a query at the start of every task, and again whenever the work moves to
   a new language, framework, tool, file type or kind of work (tests, CI,
   release, docs, deploy). Do it even when the task looks well defined: you
   can't know which skills the library holds without querying. Summarize the
   task in 1–3 sentences (key technologies, file types and the goal), then run,
   passing your own agent id:

   ```sh
   skill-library query -a <your-agent-id> "<task description>"
   ```

   Agent ids look like `claude-code`, `codex`, `opencode`, `cursor`,
   `gemini-cli`. If you pass an id the CLI doesn't know, it prints
   `Invalid agents: …` followed by `Valid agents: …` — pick yours from that list
   and run the query again.

   This fires often, and that is fine: a query is cheap; a missed skill is not.

2. The output lists matching skills, each followed by a `└ <path>` line. Read
   every listed `SKILL.md` path **before** working on the task and follow it.
   Skills marked `(always)` are the user's always-on skills: they are returned
   for every task, so read them too.
3. `No matching skills. Continue without one.` → proceed on your own judgment.
4. If the output ends with `Sync changed your global skills — tell the user:`
   (`syncChanges` with `--json`), tell the user which skills were added,
   removed or updated, briefly, alongside your answer. These changes came
   from their skills repo (see below) and are only shown once.
5. For a rapid follow-up that trivially continues the same task with the same
   context, reusing the skills already read is acceptable; when in doubt,
   re-query.

## Query options

- Long or multiline task text: `skill-library query -a <id> - <<'EOF' … EOF`
  (`-` reads the task from stdin).
- `--threshold <0..1>` — minimum probability (default 0.7). Use `0.8` to be
  stricter, `0.5` to recover misses.
- `--top <n>` — cap the number of matches.
- `--json` — `{"matches":[{id,name,description,path,probability,scope,always}]}`.
- A stderr line `N project skills are not installed — run skill-library install`
  means the project's `skill-library.json` references skills this machine
  doesn't have yet; run that command when you are allowed to.

## Managing skills

`skill-library` follows the vercel-labs/skills command contract: `add`, `list`,
`remove`, `update`, `check`, `install`, `find`, `init`, `use`. Skills you add are
stored in the library, never in agent skill folders. Run
`skill-library --help` for the commands and flags.

Global skills can be synced with a git repo (`skill-library sync`). When it is
set up, `sync`, `sync init`, `sync update`, `sync enable` and the global `add -g`, `remove -g`
and `update` commands can pull in skills from other machines. When their output
lists skills as added (`+`), removed (`-`) or updated (`↑`), tell the user
which ones changed.

## When the query fails

Run the command before declaring a failure. If it fails, use its stderr and exit
code to explain the specific cause briefly:

- CLI missing: check `command -v skill-library` and `PATH`; install it with
  `npm i -g skill-library`.
- Missing `SKILL_LIBRARY_TYPESAFE_API_KEY` or HTTP 401: query needs a valid
  TypeSafe key in the agent's environment. Never print the key.
- Connection error or timeout: online scoring could not reach TypeSafe. Check
  network/DNS, proxy settings, and agent sandbox restrictions. This does not
  establish that the service is down. If the environment reports restricted
  networking, retry through its supported network-permission mechanism when
  allowed. Respect denials and use the offline fallback below.
- Other exit-2 errors: report the actual diagnostic (for example, an unreadable
  store), rather than labeling every runtime failure a service outage.

**Offline fallback** (needs neither network nor an API key): run

```sh
skill-library list --json -a <your-agent-id>
skill-library list -g --json -a <your-agent-id>
```

Ignore rows whose `status` is `untracked` or `missing`. When a project row and a
global row share a `name`, use the project row. Pick the relevant skills from the
names, then read `<path>/SKILL.md` for each before continuing. If the local
catalog also fails or has nothing relevant, continue with available guidance.
Never block the user's task on the library, and avoid repeating a known failing
query during the same task unless conditions change.
