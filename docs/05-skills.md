# 05 — Wrapper Skills

Nine small skills ship as files in this repo under `skills/`. They are installed
either with the skills CLI (`npx skills add ianwijma/skill-library-skill`, which
installs for any agent and copies only the skill files) or by copying the files
into the agent's skills folder by hand — the `skill-library` app has no
install command (D9). After cutover they are the only project skills that
auto-load.

The gateway (`skill-library`) is the only skill relevant to every message; it
stays lean so the per-message token floor stays small. Every subcommand gets its
own skill (D14) so each library capability has a focused, triggerable
description — a command skill's body is read only when that operation is needed.
Imports are reversible (D16): the importer journals every mutation, and
`skill-importer-undo` replays the journal. Full drafts below; implementation
copies them verbatim.

---

## `skill-library` — the always-on gateway

**Triggers**: every user message (per D3); also any skill-management request.
**Does not trigger**: never — this is the one skill that is always relevant.

```markdown
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
library. If the binary is missing because the skills were installed without it
(e.g. via `npx skills add`), tell the user to build and install it — the README
at https://github.com/ianwijma/skill-library-skill has the exact commands.
```

---

## `skill-library-query` — scoring the catalog

```markdown
---
name: skill-library-query
description: Use when scoring the skill catalog for a task or tuning query results — thresholds, result caps, stdin input, or embedding skill content in the query output. The skill-library gateway runs this on every user message; read this skill when results need adjusting or the task text is long or multiline.
---

# skill-library query

Asks the TypeSafe Jev model which cataloged skills are needed for a task. One
positional: the task description (quote it). Output: JSON
`{"matches":[{id,name,description,path,dir,probability}...]}`, sorted by
probability descending.

```sh
skill-library query "<task text>"
```

## Flags

- `--threshold <0..1>` — minimum probability to include a match (default 0.7)
- `--top <n>` — cap the number of matches
- `--return-content` — embed each matched skill's full text in the output (saves
  a Read step at the cost of a larger output; prefer path + Read normally)
- `--pretty` — pretty-print JSON; `--store <dir>` — store override; `--verbose`
  — token usage on stderr

## Tips

- Long/multiline task text: `cat <<'EOF' | skill-library query - … EOF` or
  `skill-library query "$(cat task.md)"`
- `--threshold 0.8` (stricter) or `--threshold 0.5` (broader recall)
- Empty `matches` → proceed on your own judgment; a re-query at a lower
  threshold recovers misses
- Missing `TYPESAFE_API_KEY` → exit 2; per the gateway fallback, continue
  unblocked and tell the user
```

---

## `skill-library-list` — the catalog

```markdown
---
name: skill-library-list
description: Use when browsing the skill catalog, checking what is in the library, or diffing source skill directories against the library for rerunnable imports. Prints every skill as JSON with id, name, description, and store path.
---

# skill-library list

Prints the catalog as JSON, sorted by name ascending:

```sh
skill-library list                      # {"skills":[{id,name,description,path}...]}
skill-library list --return-content     # each record also carries its full text
```

Use cases: cheap orientation; the diff source for rerunnable imports (compare
source dirs by `name`; `--return-content` shows what the library currently
stores). Orphaned store files trigger a stderr warning.
```

---

## `skill-library-get` — inspect one skill

```markdown
---
name: skill-library-get
description: Use when inspecting a single cataloged skill or retrieving its full SKILL.md content without reading the file by path. Takes one positional skill id; supports --return-content.
---

# skill-library get

```sh
skill-library get <id>                  # {id,name,description,path,dir}
skill-library get <id> --return-content # adds the full SKILL.md text
```

Use cases: pre-add review, refresh checks, content retrieval. Unknown id →
exit 1 (`error: unknown skill id '<id>'`).
```

---

## `skill-library-add` — import a skill

```markdown
---
name: skill-library-add
description: Use when importing a skill into the library for the first time — onboarding new skills or registering a skill just written. Requires --name, --description, and --path (a skill directory or a SKILL.md file); the description is what gets machine-matched, so curate it.
---

# skill-library add

Copies a skill verbatim into the store and registers it. `--path` takes a skill
**directory** (copied wholesale — SKILL.md plus sibling scripts/data, so
relative references keep working) or a bare `SKILL.md` file:

```sh
skill-library add --name <name> --description "<desc>" --path <skill-dir-or-file>
```

- `--name` lowercase-hyphen, ≤64 chars; duplicate names warn on stderr but
  proceed (ids stay unique)
- The returned `path` is the STORE copy of SKILL.md, not the source; `dir` is
  the skill's directory root
- Description quality drives matching — front-load trigger keywords, third
  person ("Use when…"), what it does + when to use it, ≤ 2 sentences
```

---

## `skill-library-update` — edit a skill

```markdown
---
name: skill-library-update
description: Use when editing an existing cataloged skill — renaming it, rewriting a weak description for better matching, or re-importing changed content from its source directory. Only provided flags change; the id never changes.
---

# skill-library update

```sh
skill-library update <id> [--name <n>] [--description <d>] [--path <skill-dir-or-file>]
```

- `--description` — the main lever on query matching quality; rewrite weak ones
- `--path` — re-imports content verbatim (replaces the stored skill dir,
  siblings included)
- `--name` — rename; the id stays stable across renames

Unknown id → exit 1; no flags → exit 1 (nothing to do).
```

---

## `skill-library-remove` — delete a skill

```markdown
---
name: skill-library-remove
description: Use when permanently deleting a skill from the library. Prints the deleted record including its full SKILL.md content and imported file list so it stays recoverable from the transcript; confirm with the user before deleting.
---

# skill-library remove

```sh
skill-library remove <id>
```

- Output: `{id, name, description, content, files}` — the deleted skill
  (SKILL.md text + every imported relative file path), recoverable from the
  transcript
- No interactive prompt; confirm with the user before running (deletion safety)
- Unknown id → exit 1
```

---

## `skill-importer` — rerunnable onboarding

**Triggers**: "import/onboard/sync/refresh/add skills", bulk skill migration,
cutover completion. **Stays quiet** on ordinary task work.

```markdown
---
name: skill-importer
description: Use when the user asks to import, onboard, sync, refresh, or bulk-add skills into the skill library, or to complete the cutover from auto-loaded skills. Rerunnable at any time — it diffs new or changed skill directories against the library and imports only the differences (whole directories, multi-file skills included) via skill-library add/update, writing an undo journal so every change can be reversed.
---

# Skill Importer

Rerunnable onboarding flow. Safe to run repeatedly; each run picks up exactly the
new and changed skills. Every mutation is journaled, so any run can be reversed
later (see the `skill-importer-undo` skill).

## Flow

1. **Sources** — default dirs: `~/.config/opencode/skills/*`,
   `~/.opencode/skills/*`, `~/.agents/skills/*`, `~/.claude/skills/*` (any
   subdir containing `SKILL.md`), or user-supplied paths/dirs.
2. **Discover** — Glob `**/SKILL.md` across the sources; the skill's directory is
   the `SKILL.md`'s parent. **Skip library infrastructure**: any skill whose
   frontmatter `name` (or directory name) is `skill-library` or starts with
   `skill-library-` (e.g. `skill-library-add`, `skill-library-query`), plus the
   importer's own skills `skill-importer` and `skill-importer-undo`. These run
   the library and must stay in the auto-load dirs — never import them, never
   plan changes for them.
3. **Diff** — run `skill-library list`, then compare by `name`:
   - name not in library → plan `skill-library add --path <skill dir>`
   - name in library: compare the source SKILL.md bytes against
     `skill-library get <id> --return-content` → differ → plan
     `skill-library update <id> --path <skill dir>`
   - identical → skip
4. **Multi-file skills are just imports** — pass the skill **directory** to
   `--path`; the whole folder (scripts, data, everything except junk like
   `__pycache__`) is copied verbatim into the store, so relative references keep
   working with no rewriting.
5. **Curate descriptions** — for each skill being imported or updated, ensure the
   description is machine-matchable: front-loaded trigger keywords, third person
   ("Use when…"), what it does + when to use it, ≤ 2 sentences. Plan a
   `skill-library update <id> --description "…"` for weak ones.
6. **Plan & confirm** — show the user the add/update/skip list before executing.
   Never mutate anything before explicit approval.
7. **Journal** — before the first mutation, create the undo journal:
   `<store>/imports/<yyyy-MM-ddTHH-mm-ss>/journal.json`. For each planned update,
   first capture the current record (`skill-library get <id> --return-content`):
   prior `name`/`description` go into the journal entry, prior content is written
   to the staged prior skill dir `prior-<id>/` in the same run dir. Adds need no prior state. Journal
   format:
   ```json
   {
     "run": "<dir name>",
     "startedAt": "<ISO-8601>",
     "actions": [
       { "op": "add", "name": "frontend-design", "id": null, "done": false },
       { "op": "update", "id": "9f3a1c2b", "name": "frontend-design",
         "prior": { "name": "…", "description": "…", "content": "prior-9f3a1c2b" },
         "done": false }
     ]
   }
   ```
8. **Execute** — run the planned adds/updates (read the `skill-library-add` and
   `skill-library-update` skills for the exact contracts), setting `done: true`
   per entry after it succeeds.
9. **Verify** — `skill-library list`; for each update, confirm
   `skill-library get <id> --return-content` matches the source byte-for-byte.
   Report the final catalog and the journal path.

The store dir is the parent of the `skills/` dir in any returned `dir`
(default `~/.local/share/skill-library`; override via `SKILL_LIBRARY_DIR` or
`--store`).

## Safety rules

- Plan & confirm first; journal before the first mutation.
- Never delete anything: importing only adds and updates. Deletions are
  `skill-library remove` (user-confirmed) or cutover (explicitly confirmed).
- Library infrastructure is out of scope: `skill-library`, `skill-library-*`,
  `skill-importer`, and `skill-importer-undo` are skipped in every phase —
  diff, import, and cutover removal.
- Rerun-safe: identical skills are skipped, so a rerun picks up only differences.
- Multi-file skills are imported whole (directory in, directory stored) — never
  referenced from the original location.
- If a run fails mid-way, stop and tell the user; the journal records exactly
  what was executed, and `skill-importer-undo` can reverse it.

## Cutover completion (optional, destructive)

Only after the user **explicitly confirms**:

1. Back up the source dirs: `tar -czf ~/skill-sources-backup-$(date +%F).tar.gz <src dirs>`
2. Remove the originals from the auto-load dirs, **except** the library
   infrastructure (`skill-library`, `skill-library-*`, `skill-importer`,
   `skill-importer-undo`) — those must keep living in the auto-load dirs or the
   library becomes unmanageable.
3. Remind the user to quit and restart opencode (skills/config are not hot-reloaded).

Never delete originals without confirmation. See docs/06-cutover-runbook.md for
the full runbook; the `skill-importer-undo` skill reverses this too.
```

---

## `skill-importer-undo` — reverse an import or cutover

**Triggers**: "undo/reverse the import", "restore skills to their previous
state", "put the skills back", "roll back the cutover".

```markdown
---
name: skill-importer-undo
description: Use when the user asks to undo or reverse an import, restore skills to their previous state, or roll back the cutover from auto-loaded skills. Replays the latest import journal in reverse — removes skills that were added, restores the prior name, description, and content of skills that were updated — after showing the reversal plan and getting explicit confirmation.
---

# Skill Importer Undo

Reverses a previous import run (or a cutover) using its journal. Nothing is
undone without the user's explicit confirmation of the reversal plan.

## Undo an import run

1. **Find the journal** — list latest first:
   `ls -t <store>/imports/*/journal.json`
   (store default `~/.local/share/skill-library`; override via
   `SKILL_LIBRARY_DIR` / `--store`). If several runs exist, confirm with the
   user which one to undo, or use the one they name.
2. **Plan the reversal** — read `journal.json`; for every entry with
   `done: true`, plan the inverse in reverse order:
   - `add` (with an `id`) → plan `skill-library remove <id>` — its output
     returns the deleted content, so the removal stays recoverable from the
     transcript
   - `update` → plan `skill-library update <id>` with the journal's prior
     values: `--name` and/or `--description` when captured, and
     `--path <run>/prior-<id>/` when prior content was captured
   - `id: null` adds and `done: false` entries were never executed → nothing
     to undo for them
3. **Confirm** — show the remove/update list and get explicit approval.
4. **Execute** — in reverse journal order (read the `skill-library-remove` and
   `skill-library-update` skills for the exact contracts).
5. **Verify** — `skill-library list`; spot-check restored skills with
   `skill-library get <id> --return-content` against the staged prior copies.
6. **Report** — what was removed and what was restored; journals stay on disk.

Re-running undo on the same journal is safe: already-removed ids fail with
`unknown skill id` (skip them), and re-applied prior values are no-ops.

## Undo the cutover

Puts the original skill dirs back into the auto-load locations:

1. Locate the backup: `ls -t ~/skill-sources-backup-*.tar.gz`
2. Inspect it first (`tar -tzf`), then restore: `tar -xzf <backup> -C ~/`
3. Remind the user to restart opencode — originals auto-load again; the library
   keeps working in parallel (duplicate guidance is harmless temporarily)
4. Optionally remove the corresponding library records — only with explicit
   confirmation, via `skill-library remove <id>`

See docs/06-cutover-runbook.md § Rollback for the human runbook.
```

---

## Behavior contracts for all skills

| Concern | Contract |
|---|---|
| Fallback | `skill-library` missing/exit 2 → say the library is unavailable, continue unblocked; skills-only installs (`npx skills add`) → point at the repo README to build the binary |
| Deletion safety | `skill-library remove` and any file deletion only after user confirmation (importer/undo step) |
| Reversibility | Every import journals prior state before mutating (D16); undo replays the journal in reverse |
| Description quality | Curated at import time; this is the main lever on Jev matching quality |
| Skill file reads | Use the `path` from library output — never reconstruct store paths by hand |
| Multi-file skills | Imported whole via directory `--path`; run sibling scripts from the record's `dir` |
| Gateway leanness | Only the gateway is relevant to every message; command skills stay out of the per-message path |
