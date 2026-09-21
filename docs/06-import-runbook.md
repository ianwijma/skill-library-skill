# 06 — Import Runbook

The importer skill (doc 05) is **rerunnable**: every run diffs source dirs against
the library, imports only new/changed skills, and then removes the sources of
everything it has safely in the library — cutover is built into every import.
This runbook is the same flow, written down for humans — the skill carries the
LLM-facing version.

## First run (build skills exist but originals still auto-load)

```
State: 4 skills auto-load on every session (frontend-design, typesafe-ai,
       ui-ux-pro-max, context7-mcp). Library empty.
```

1. **Import**
   ```sh
   skill-library add --name frontend-design \
     --description "Create distinctive, production-grade frontend interfaces with high design quality. Use when building or styling web components, pages, dashboards, or artifacts." \
     --path ~/.opencode/skills/frontend-design
   # …repeat for typesafe-ai, ui-ux-pro-max, context7-mcp
   ```
   Multi-file skills (e.g. `ui-ux-pro-max` with `scripts/` and `data/`) import
   the same way — pass the skill directory and everything comes along.
   (Or invoke the importer skill and let the LLM drive steps 2–11 of its flow.)
2. **Calibrate** — probe `skill-library query` with representative tasks; confirm expected skills score ≥ 0.7 (doc 04 checklist).
3. **Verify retrieval** — `skill-library get <id> --return-content` matches the original SKILL.md byte-for-byte; sibling files live under the record's `dir`.
4. **Remove sources** — after verification, the importer stages each source into
   the run dir (`<store>/imports/<run>/removed-<name>/`) and deletes it from the
   auto-load dir. Excluded skills keep living there.
5. Restart opencode. Expected session skills: `skill-library` (gateway) + its six
   per-command skills, `skill-importer`, `skill-importer-undo`,
   built-in `customize-opencode` (built-in, cannot be removed).
6. Smoke test: give the agent a task → `skill-library query` runs → matched skill
   content read → task work informed by it.

## Ongoing runs (rerunnable sync)

Whenever a new skill appears in a source dir (or anywhere):

1. Importer skill: discover → diff vs `skill-library list` → journal →
   import/refresh → curate descriptions → verify → remove verified sources.
2. Nothing else to clean up: sources of verified imports are removed in the
   same run; excluded skills stay put.

## Undo an import run

Every import writes an undo journal: `<store>/imports/<run>/journal.json` with
each executed add/update, the prior name/description/content of updated skills,
and every removed source (original path + staged copy in the run dir). To
reverse a run, use the `skill-importer-undo` skill (or by hand):

1. Read the journal; plan the inverses in reverse order.
2. Added skills → `skill-library remove <id>` (content returns in the output).
3. Updated skills → `skill-library update <id>` with the journal's prior
   values, including `--path <run>/prior-<id>/` for prior content.
4. Removed sources → recreate the parent dir, then
   `cp -a <run>/removed-<name> <src>`.
5. Verify with `skill-library list`, `skill-library get <id> --return-content`,
   and `ls <src>/SKILL.md`.

## Rollback

Restore removed sources from the run dir (via the undo skill, or by hand):

```sh
mkdir -p "$(dirname <src>)"
cp -a ~/.local/share/skill-library/imports/<run>/removed-<name> <src>
```

Restart opencode — originals auto-load again; the library keeps working in
parallel (duplicate guidance is harmless temporarily). Optionally
`skill-library remove <id>` for anything that should not stay in the store.

## Known limitations (documented, by design)

| Limitation | Mitigation |
|---|---|
| Descriptions in the index may drift from a skill's own frontmatter | Index is authoritative by design (D5); curation at import time is the fix |
| `customize-opencode` stays built-in | Accepted — small, and removal is not supported by opencode |
| Sources from user-supplied paths outside the auto-load dirs are not removed automatically | Only auto-load-dir sources are removed by default; user-supplied paths need explicit inclusion in the confirmed plan |
