# 05 — Wrapper Skills

Nine small skills ship as files in this repo under `skills/`. They are installed
either with the skills CLI (`npx skills add ianwijma/skill-library-skill`, which
installs for any agent and copies only the skill files) or by copying the files
into the agent's skills folder by hand — the `skill-library` app has no
install command (D9). Once the importer has run, these are the only project
skills that auto-load: importing removes every other skill's source.

The gateway (`skill-library`) is the only skill relevant to (almost) every
message — it triggers whenever a skill might help; the LLM is told to err on
the side of querying. It stays lean so the per-message token floor stays small. Every subcommand gets its
own skill (D14) so each library capability has a focused, triggerable
description — a command skill's body is read only when that operation is needed.
Imports are reversible (D16): the importer journals every mutation, and
`skill-importer-undo` replays the journal. Full drafts below; implementation
copies them verbatim.

---

## `skill-library` — the always-on gateway

**Triggers**: whenever a skill might help — which is very often (per D3); also
any skill-management request.
**Does not trigger**: never — erring on the side of querying is the default.

```markdown
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
```

---

## `skill-library-query` — scoring the catalog

```markdown
---
name: skill-library-query
description: Use when scoring the skill catalog for a task or tuning query results — thresholds, result caps, stdin input, or embedding skill content in the query output. The skill-library gateway runs this whenever a skill might help; read this skill when results need adjusting or the task text is long or multiline.
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
"complete the cutover" (importing now removes the sources itself). **Stays
quiet** on ordinary task work.

```markdown
---
name: skill-importer
description: Use when the user asks to import, onboard, sync, refresh, or bulk-add skills into the skill library, or to complete the cutover from auto-loaded skills. Rerunnable at any time — it diffs skill directories against the library, imports only the differences (whole directories, multi-file skills included) via skill-library add/update, then removes the imported skills' sources from the auto-load dirs, writing an undo journal so every change can be reversed.
---

# Skill Importer

Rerunnable onboarding flow. Safe to run repeatedly; each run picks up exactly the
new and changed skills, then removes the sources of everything it has safely in
the library, so imported skills stop auto-loading. Every mutation is journaled,
so any run can be reversed later (see the `skill-importer-undo` skill).

## Flow

1. **Sources** — default dirs: `~/.config/opencode/skills/*`,
   `~/.opencode/skills/*`, `~/.agents/skills/*`, `~/.claude/skills/*` (any
   subdir containing `SKILL.md`), or user-supplied paths/dirs.
2. **Discover** — Glob `**/SKILL.md` across the sources; the skill's directory is
   the `SKILL.md`'s parent. **Skip every skill in the "Excluded skills" list
   below** — library infrastructure that runs the library itself; it must stay
   in the auto-load dirs: never import it, never plan changes for it.
3. **Diff** — run `skill-library list`, then compare by `name`:
   - name not in library → plan `skill-library add --path <skill dir>`
   - name in library: compare the source SKILL.md bytes against
     `skill-library get <id> --return-content` → differ → plan
     `skill-library update <id> --path <skill dir>`
   - identical → skip the import; the library already holds this exact skill
4. **Multi-file skills are just imports** — pass the skill **directory** to
   `--path`; the whole folder (scripts, data, everything except junk like
   `__pycache__`) is copied verbatim into the store, so relative references keep
   working with no rewriting.
5. **Curate descriptions** — for each skill being imported or updated, ensure the
   description is machine-matchable: front-loaded trigger keywords, third person
   ("Use when…"), what it does + when to use it, ≤ 2 sentences. Plan a
   `skill-library update <id> --description "…"` for weak ones.
6. **Plan & confirm** — show the user the add/update/skip list plus the source
   removals that follow every skill ending the run safely in the library
   (added, updated, or verified-identical). Never mutate anything before
   explicit approval.
7. **Journal** — before the first mutation, create the undo journal:
   `<store>/imports/<yyyy-MM-ddTHH-mm-ss>/journal.json`. For each planned update,
   first capture the current record (`skill-library get <id> --return-content`):
   prior `name`/`description` go into the journal entry, prior content is written
   to the staged prior skill dir `prior-<id>/` in the same run dir. Adds need no prior state. For each
   planned removal, `src` is the original skill dir and `backup` names the staged
   full copy `removed-<name>/` in the same run dir, created in step 10 right
   before deletion. Journal format:
   ```json
   {
     "run": "<dir name>",
     "startedAt": "<ISO-8601>",
     "actions": [
       { "op": "add", "name": "frontend-design", "id": null, "done": false },
       { "op": "update", "id": "9f3a1c2b", "name": "frontend-design",
         "prior": { "name": "…", "description": "…", "content": "prior-9f3a1c2b" },
         "done": false },
       { "op": "remove-source", "name": "frontend-design",
         "src": "/home/me/.opencode/skills/frontend-design",
         "backup": "removed-frontend-design", "done": false }
     ]
   }
   ```
8. **Execute** — run the planned adds/updates (read the `skill-library-add` and
   `skill-library-update` skills for the exact contracts), setting `done: true`
   per entry after it succeeds.
9. **Verify** — `skill-library list`; for each update, confirm
   `skill-library get <id> --return-content` matches the source byte-for-byte.
   A skill that fails verification keeps its source: its removal entry is not
   executed.
10. **Remove sources** — for every skill that was added, updated, or verified
    identical and discovered in the default auto-load dirs: stage a full copy
    into the run dir (`cp -a <src> <run>/removed-<name>/`), then delete `<src>`.
    Sources from user-supplied paths outside the auto-load dirs are removed only
    if the user explicitly included them in the confirmed plan. Never remove
    excluded skills. Set `done: true` per entry as it completes.
11. **Report** — `skill-library list` summary, the journal path, and remind the
    user to quit and restart opencode (skills/config are not hot-reloaded);
    removed skills now load on demand via `skill-library query`.

The store dir is the parent of the `skills/` dir in any returned `dir`
(default `~/.local/share/skill-library`; override via `SKILL_LIBRARY_DIR` or
`--store`).

## Excluded skills

Library infrastructure — these skills run the library and must keep living in
the auto-load dirs. They are never imported, updated, or removed.
Match on the frontmatter `name` (or directory name), exact match:

- `skill-library`
- `skill-library-add`
- `skill-library-get`
- `skill-library-list`
- `skill-library-query`
- `skill-library-remove`
- `skill-library-update`
- `skill-importer`
- `skill-importer-undo`

## Safety rules

- Plan & confirm first (adds, updates, and source removals); journal before the
  first mutation.
- Sources are deleted only after their import succeeded and verified; a failed
  or unverified import never removes its source. Removals are staged
  (`removed-<name>/` in the run dir) before deletion.
- Library records are never deleted by this flow: `skill-library remove` stays
  a separate, user-confirmed operation.
- Library infrastructure is out of scope: every skill in the "Excluded skills"
  list is skipped in every phase — diff, import, and source removal.
- Rerun-safe: adds/updates are planned only for differences; a rerun over an
  already-imported set plans only the leftover source removals.
- Multi-file skills are imported whole (directory in, directory stored) — never
  referenced from the original location.
- If a run fails mid-way, stop and tell the user; the journal records exactly
  what was executed, and `skill-importer-undo` can reverse it — including
  restoring removed sources.

See docs/06-import-runbook.md for the human runbook.
```

---

## `skill-importer-undo` — reverse an import run

**Triggers**: "undo/reverse the import", "restore skills to their previous
state", "put the skills back", "roll back the cutover".

```markdown
---
name: skill-importer-undo
description: Use when the user asks to undo or reverse an import, restore skills to their previous state, put removed skills back into their auto-load dirs, or roll back the cutover from auto-loaded skills. Replays the latest import journal in reverse — removes skills that were added, restores the prior name, description, and content of skills that were updated, and restores source skills that were removed from the auto-load dirs — after showing the reversal plan and getting explicit confirmation.
---

# Skill Importer Undo

Reverses a previous import run using its journal. Nothing is undone without the
user's explicit confirmation of the reversal plan.

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
     `--path <run>/prior-<id>/` when prior content was captured (a staged copy
     of the prior skill directory)
   - `remove-source` → plan restoring the staged copy back to its original
     path: `mkdir -p "$(dirname <src>)" && cp -a <run>/<backup> <src>` (the
     journal entry carries the original `src` path and the `backup` dir name)
   - `id: null` adds and `done: false` entries were never executed → nothing
     to undo for them
3. **Confirm** — show the remove/update/restore list and get explicit approval.
4. **Execute** — in reverse journal order (read the `skill-library-remove` and
   `skill-library-update` skills for the exact contracts).
5. **Verify** — `skill-library list`; spot-check restored skills with
   `skill-library get <id> --return-content` against the prior copies staged in
   the run dir; for restored sources, confirm `<src>/SKILL.md` exists.
6. **Report** — what was removed, what was restored, and remind the user to
   restart opencode; journals stay on disk.

Re-running undo on the same journal is safe: already-removed ids fail with
`unknown skill id` (skip them), re-applied prior values are no-ops, and an
already-restored source exists again — skip removal entries whose `src` dir
already exists (copying into it would only nest a duplicate).

See docs/06-import-runbook.md § Rollback for the human runbook.
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
| Gateway leanness | Only the gateway is relevant to (almost) every message; command skills stay out of the per-message path |
