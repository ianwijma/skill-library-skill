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
   the `SKILL.md`'s parent. **Skip every skill in the "Excluded skills" list
   below** — library infrastructure that runs the library itself; it must stay
   in the auto-load dirs: never import it, never plan changes for it.
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

## Excluded skills

Library infrastructure — these skills run the library and must keep living in
the auto-load dirs. They are never imported, updated, or touched by cutover.
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

- Plan & confirm first; journal before the first mutation.
- Never delete anything: importing only adds and updates. Deletions are
  `skill-library remove` (user-confirmed) or cutover (explicitly confirmed).
- Library infrastructure is out of scope: every skill in the "Excluded skills"
  list is skipped in every phase — diff, import, and cutover removal.
- Rerun-safe: identical skills are skipped, so a rerun picks up only differences.
- Multi-file skills are imported whole (directory in, directory stored) — never
  referenced from the original location.
- If a run fails mid-way, stop and tell the user; the journal records exactly
  what was executed, and `skill-importer-undo` can reverse it.

## Cutover completion (optional, destructive)

Only after the user **explicitly confirms**:

1. Back up the source dirs: `tar -czf ~/skill-sources-backup-$(date +%F).tar.gz <src dirs>`
2. Remove the originals from the auto-load dirs, **except** the excluded skills
   ("Excluded skills" list) — those must keep living in the auto-load dirs or
   the library becomes unmanageable.
3. Remind the user to quit and restart opencode (skills/config are not hot-reloaded).

Never delete originals without confirmation. See docs/06-cutover-runbook.md for
the full runbook; the `skill-importer-undo` skill reverses this too.
