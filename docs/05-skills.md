# 05 — Wrapper Skills

Two small skills are installed into `~/.config/opencode/skills/` (opencode's
global auto-load location). They are the **only** skills that auto-load after
cutover. Both ship as files in this repo under `skills/` and are copied into place
by `install.sh` — the `sli` app has no install command (D9).

Because these load every session, both stay lean: workflow + command reference
only. Full drafts below; implementation copies them verbatim.

---

## `skill-library` — the always-on gateway

**Triggers**: every user message (per D3); also any skill-management request.
**Does not trigger**: never — this is the one skill that is always relevant.

```markdown
---
name: skill-library
description: MUST be used before working on every user message. Queries the skill library (sli) to discover and read the skills relevant to the current task, since skills are not loaded into context automatically. Also covers skill management via sli (list, get, add, update, remove). Always relevant, for every task and every message.
---

# Skill Library

Skills are NOT loaded into context automatically. They live in a managed library
and must be loaded on demand, per task.

## Workflow — every user message

1. Summarize the user's message into a 1–3 sentence task description (include key
   technologies, file types, and the goal), then run:

   ```sh
   sli query "<task description>"
   ```

2. If matches are returned: Read each returned `path` (absolute paths to skill
   markdown files) and absorb the instructions **before** working on the task.
3. If `matches` is empty, proceed on your own judgment.
4. Re-run the query for each new user message — different messages need different
   skills. (For a rapid follow-up that trivially continues the same task with the
   same context, reusing the skills already read is acceptable; when in doubt,
   re-query.)

## Query tips

- Long/multiline task text: `cat <<'EOF' | sli query - … EOF` or `sli query "$(cat task.md)"`
- `--return-content` embeds each matched skill's content directly in the query
  output (saves a Read step at the cost of a larger output). Prefer path + Read
  normally.
- `--threshold 0.8` (stricter) or `--threshold 0.5` (broader recall), `--top 3`
  (cap matches) tune results.

## Managing skills

```sh
sli list                                                        # catalog: id, name, description, path
sli get <id> [--return-content]                                 # one skill
sli add --name <name> --description "<desc>" --path <file>      # import a skill file
sli update <id> [--name …] [--description …] [--path <file>]    # edit fields / re-import content
sli remove <id>                                                 # delete (returns deleted content)
```

- All output is JSON on stdout; errors on stderr. `sli --help` for details.
- When adding a skill yourself, write the description for machine matching:
  front-load trigger keywords, third person ("Use when…"), what it does + when to
  use it, ≤ 2 sentences.

## Fallback

If `sli` is missing or exits 2: tell the user the skill library is unavailable and
continue with built-in knowledge — never block the task on the library.
```

---

## `skill-importer` — rerunnable onboarding

**Triggers**: "import/onboard/sync/refresh/add skills", bulk skill migration,
cutover completion. **Stays quiet** on ordinary task work.

```markdown
---
name: skill-importer
description: Use when the user asks to import, onboard, sync, refresh, or bulk-add skills into the skill library, or to complete the cutover from auto-loaded skills. Rerunnable at any time — it diffs new or changed skill files against the library and imports only the differences via sli add/update.
---

# Skill Importer

Rerunnable onboarding flow. Safe to run repeatedly; each run picks up exactly the
new and changed skills.

## Flow

1. **Sources** — default dirs: `~/.opencode/skills/*`, `~/.agents/skills/*`,
   `~/.claude/skills/*` (any subdir containing `SKILL.md`), or user-supplied
   paths/dirs.
2. **Discover** — Glob `**/SKILL.md` across the sources.
3. **Diff** — run `sli list --json`, then compare by `name`:
   - name not in library → plan `sli add`
   - name in library but source file content differs from `sli get <id> --return-content` → plan `sli update <id> --path <file>`
   - identical → skip
4. **Multi-file skills** — if a skill's content references sibling files/scripts
   (e.g. `ui-ux-pro-max` calls `scripts/search.py`): copy the **whole** source dir
   to `~/.local/share/skill-library/staging/<name>/` first, rewrite relative asset
   references in the SKILL.md to the staged absolute paths, then point
   `--path` at the staged SKILL.md. The library manages the markdown; staged
   assets stay where the skill's own references expect them.
5. **Plan & confirm** — show the user the add/update/skip list before executing.
6. **Curate descriptions** — for each skill being imported/updated, ensure the
   description is machine-matchable: front-loaded trigger keywords, third person
   ("Use when…"), what it does + when to use it, ≤ 2 sentences. Rewrite weak ones
   via `sli update <id> --description "…"`.
7. **Verify** — `sli list` and report the final catalog.

## Cutover completion (optional, destructive)

Only after the user **explicitly confirms**:

1. Back up the source dirs: `tar -czf ~/skill-sources-backup-$(date +%F).tar.gz <src dirs>`
2. Remove the originals from the auto-load dirs.
3. Remind the user to quit and restart opencode (skills/config are not hot-reloaded).

Never delete originals without confirmation. See docs/06-cutover-runbook.md for
the full runbook and rollback.
```

---

## Behavior contracts for both skills

| Concern | Contract |
|---|---|
| Fallback | `sli` missing/exit 2 → say the library is unavailable, continue unblocked |
| Deletion safety | `sli remove` and any file deletion only after user confirmation (importer step) |
| Description quality | Curated at import time; this is the main lever on Jev matching quality |
| Skill file reads | Use the `path` from library output — never reconstruct store paths by hand |
| Multi-file caveat | Handled by staging (step 4) — a known v1 limitation, not silent breakage |
