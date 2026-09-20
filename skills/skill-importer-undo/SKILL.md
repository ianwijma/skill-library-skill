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
