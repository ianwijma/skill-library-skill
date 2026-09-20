# 03 — Data Store

## Layout

```
~/.local/share/skill-library/        (XDG data dir; override: SKILL_LIBRARY_DIR / --store)
├── index.json                       metadata — authoritative for name/description
└── skills/
    ├── 9f3a1c2b.md                  skill content, verbatim copy, named by id
    └── 7d0e4f11.md
```

- Content files are named `<id>.md` regardless of the source filename; the
  original filename is irrelevant (the LLM reads content, not filenames).
- Content is stored **verbatim** — no frontmatter stripping or rewriting. The
  index carries the authoritative name/description, which may be curated versions
  that differ from the file's own frontmatter.

## `index.json` schema

```json
[
  {
    "id": "9f3a1c2b",
    "name": "frontend-design",
    "description": "Create distinctive, production-grade frontend interfaces. Use when building or styling web UI.",
    "source": "/home/ian/.opencode/skills/frontend-design/SKILL.md",
    "addedAt": "2026-09-20T21:04:11.520Z",
    "updatedAt": "2026-09-20T21:30:02.104Z",
    "contentFile": "skills/9f3a1c2b.md"
  }
]
```

| Field | Contract |
|---|---|
| `id` | 8 lowercase alphanumeric chars; generated at `add`; **never** changes (not even on `update --name`) |
| `name` | lowercase-hyphen, ≤64 chars; user-supplied at `add`, mutable via `update` |
| `description` | free text; the string Jev scores against — its quality determines matching quality |
| `source` | where the content was imported from (internal only, not in output records) — lets the importer verify refreshes |
| `addedAt` / `updatedAt` | ISO-8601 |
| `contentFile` | store-relative path of the content file |

Output records are a **projection** of this: `{id, name, description, path}` where
`path` = resolved absolute `contentFile` path.

## ID generation

- 8 chars from `crypto` randomness (lowercase a–z0–9).
- On collision with an existing id, regenerate (loop; collision odds negligible).
- Uniqueness is what allows duplicate names across skills without key conflicts —
  though the importer flow keeps names unique in practice. `add` warns on a
  duplicate name but does not block.

## Write protocol (atomicity)

Every mutation follows write-temp-then-rename, in the same directory:

```
write index.json.tmp   → fsync → rename over index.json
write <id>.md.tmp      → fsync → rename over <id>.md (update --path)
```

- Rename is atomic on the same filesystem → no torn index, even on crash mid-write.
- `add` order: content file first, then index entry (a record always has content).
- `remove` order: index entry first, then content file (a file without a record is
  garbage, never a dangling record).

## Concurrency

No locking in v1. Assumption: single interactive user; the LLM runs commands
sequentially. Atomic renames prevent corruption; last-writer-wins is acceptable.
(Revisit only if background automation is added — see doc 07 future work.)

## Corruption & recovery

- If `index.json` fails to parse: all commands exit 2 with
  `error: index.json is corrupted — fix or restore <path>` and stop (never
  silently rebuild, since name/description exist nowhere else).
- Orphaned content files (no index entry) are ignored by readers; `list` prints a
  stderr warning when it detects any.
- Backups: cutover runbook (doc 06) tars originals before any deletion.
