# 06 — Cutover Runbook

The importer skill (doc 05) is **rerunnable**: every run diffs source dirs against
the library and imports only new/changed skills. This runbook is the same flow,
written down for humans — the skill carries the LLM-facing version.

## First run (build skills exist but originals still auto-load)

```
State: 4 skills auto-load on every session (frontend-design, typesafe-ai,
       ui-ux-pro-max, context7-mcp). Library empty.
```

1. **Import**
   ```sh
   sli add --name frontend-design \
     --description "Create distinctive, production-grade frontend interfaces with high design quality. Use when building or styling web components, pages, dashboards, or artifacts." \
     --path ~/.opencode/skills/frontend-design/SKILL.md
   # …repeat for typesafe-ai, ui-ux-pro-max, context7-mcp
   ```
   (Or invoke the importer skill and let the LLM drive steps 2–7 of its flow.)
2. **Calibrate** — probe `sli query` with representative tasks; confirm expected skills score ≥ 0.7 (doc 04 checklist).
3. **Verify retrieval** — `sli get <id> --return-content` matches the originals byte-for-byte.

## Ongoing runs (rerunnable sync)

Whenever a new skill appears in a source dir (or anywhere):

1. Importer skill: discover → diff vs `sli list` → import/refresh → curate descriptions → verify.
2. Nothing to clean up: auto-load dirs only lose files during cutover completion.

## Cutover completion (destructive — only after explicit confirmation)

1. Back up:
   ```sh
   tar -czf ~/skill-sources-backup-$(date +%F).tar.gz \
     ~/.opencode/skills ~/.agents/skills
   ```
2. Remove the four original skill dirs from `~/.opencode/skills/` and
   `~/.agents/skills/` (keep the repo copies under `skills/` in this repo as the
   canonical source for the two wrapper skills).
3. Restart opencode. Expected session skills: `skill-library`, `skill-importer`,
   built-in `customize-opencode` (built-in, cannot be removed).
4. Smoke test: any user message → `sli query` runs → matched skill content read →
   task work informed by it.

## Rollback

1. Restore: `tar -xzf ~/skill-sources-backup-<date>.tar.gz -C ~/` (paths inside
   the tarball are absolute-ish home-relative — verify with `tar -tzf` first).
2. Restart opencode — originals auto-load again; the library keeps working in
   parallel (duplicate guidance is harmless temporarily).
3. Optionally `sli remove <id>` for anything that should not stay in the store.

## Known limitations (documented, by design)

| Limitation | Mitigation |
|---|---|
| Library stores single markdown files; sibling assets (scripts, data) are not managed | Importer staging step copies whole dirs to `~/.local/share/skill-library/staging/<name>/` and rewrites asset references to absolute staged paths |
| Descriptions in the index may drift from a skill's own frontmatter | Index is authoritative by design (D5); curation at import time is the fix |
| `customize-opencode` stays built-in | Accepted — small, and removal is not supported by opencode |
| Old skills auto-load until cutover completes | Duplicate guidance is harmless; cutover is explicit and confirmed |
