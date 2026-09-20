---
name: skill-importer
description: Use when the user asks to import, onboard, sync, refresh, or bulk-add skills into the skill library, or to complete the cutover from auto-loaded skills. Rerunnable at any time — it diffs new or changed skill files against the library and imports only the differences via skill-library add/update, writing an undo journal so every change can be reversed.
---

# Skill Importer

Rerunnable onboarding flow. Safe to run repeatedly; each run picks up exactly the
new and changed skills. Every mutation is journaled, so any run can be reversed
later (see the `skill-importer-undo` skill).

## Flow

1. **Sources** — default dirs: `~/.config/opencode/skills/*`,
   `~/.opencode/skills/*`, `~/.agents/skills/*`, `~/.claude/skills/*` (any
   subdir containing `SKILL.md`), or user-supplied paths/dirs.
2. **Discover** — Glob `**/SKILL.md` across the sources.
3. **Diff** — run `skill-library list`, then compare by `name`:
   - name not in library → plan `skill-library add`
   - name in library: compare the source file bytes against
     `skill-library get <id> --return-content` → differ → plan
     `skill-library update <id> --path <file>`
   - identical → skip
4. **Multi-file skills** — if a skill's content references sibling files/scripts
   (e.g. `ui-ux-pro-max` calls `scripts/search.py`): copy the **whole** source dir
   to `<store>/staging/<name>/` first, rewrite relative asset references in the
   SKILL.md to the staged absolute paths, then point `--path` at the staged
   SKILL.md. The library manages the markdown; staged assets stay where the
   skill's own references expect them.
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
   to `prior-<id>.md` in the same run dir. Adds need no prior state. Journal
   format:
   ```json
   {
     "run": "<dir name>",
     "startedAt": "<ISO-8601>",
     "actions": [
       { "op": "add", "name": "frontend-design", "id": null, "done": false },
       { "op": "update", "id": "9f3a1c2b", "name": "frontend-design",
         "prior": { "name": "…", "description": "…", "content": "prior-9f3a1c2b.md" },
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

The store dir is the parent of the `skills/` dir in any returned `path`
(default `~/.local/share/skill-library`; override via `SKILL_LIBRARY_DIR` or
`--store`).

## Safety rules

- Plan & confirm first; journal before the first mutation.
- Never delete anything: importing only adds and updates. Deletions are
  `skill-library remove` (user-confirmed) or cutover (explicitly confirmed).
- Rerun-safe: identical skills are skipped, so a rerun picks up only differences.
- Multi-file skills are staged, never referenced from the original location.
- If a run fails mid-way, stop and tell the user; the journal records exactly
  what was executed, and `skill-importer-undo` can reverse it.

## Cutover completion (optional, destructive)

Only after the user **explicitly confirms**:

1. Back up the source dirs: `tar -czf ~/skill-sources-backup-$(date +%F).tar.gz <src dirs>`
2. Remove the originals from the auto-load dirs.
3. Remind the user to quit and restart opencode (skills/config are not hot-reloaded).

Never delete originals without confirmation. See docs/06-cutover-runbook.md for
the full runbook; the `skill-importer-undo` skill reverses this too.
