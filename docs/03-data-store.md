# 03 — Data Store

## Layout

```
~/.local/share/skill-library/        (XDG data dir; override: SKILL_LIBRARY_DIR / --store)
├── index.json                       metadata — authoritative for name/description
├── skills/
│   ├── 9f3a1c2b/                    one directory per skill, copied verbatim
│   │   ├── SKILL.md                 skill entry point (what `path` points to)
│   │   ├── scripts/                 sibling assets come along…
│   │   │   └── tool.py              …so relative references keep working
│   │   └── data/
│   │       └── reference.csv
│   └── 7d0e4f11/
│       └── SKILL.md
└── imports/                         undo journals (importer skill only)
    └── <yyyy-MM-ddTHH-mm-ss>/       one dir per import run
        └── journal.json             executed adds/updates + prior name/description
```

- The `imports/` subdirectory is created and consumed by the importer/undo
  skills, not by the app; all app commands ignore it.

- Every skill lives in its own directory `skills/<id>/`, always containing a
  `SKILL.md` (the entry point). `add --path` accepts either a skill **directory**
  (copied wholesale, verbatim) or a bare `SKILL.md` file (stored as a single-file
  skill). Because siblings travel with the skill, relative references like
  `scripts/tool.py` resolve inside the store — no path rewriting, no staging.

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
    "source": "/home/ian/.opencode/skills/frontend-design",
    "addedAt": "2026-09-20T21:04:11.520Z",
    "updatedAt": "2026-09-20T21:30:02.104Z",
    "contentDir": "skills/9f3a1c2b"
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
| `contentDir` | store-relative path of the skill's directory (`skills/<id>`) |

Output records are a **projection** of this: `{id, name, description, path, dir}`
where `path` = `<store>/<contentDir>/SKILL.md` (what the LLM should Read) and
`dir` = the skill's directory root (what `remove` deletes wholesale; handy for
scripts that need to run sibling assets).

## ID generation

- 8 chars from `crypto` randomness (lowercase a–z0–9).
- On collision with an existing id, regenerate (loop; collision odds negligible).
- Uniqueness is what allows duplicate names across skills without key conflicts —
  though the importer flow keeps names unique in practice. `add` warns on a
  duplicate name but does not block.

## Write protocol (atomicity)

Every mutation follows write-temp-then-rename, in the same directory:

```
write index.json.tmp            → fsync → rename over index.json
stage skills/<id>.tmp/          → copy whole tree → rename over skills/<id>/
                                  (update: old dir swapped out via skills/<id>.old)
```

- Rename is atomic on the same filesystem → no torn index, even on crash mid-write.
- `add` order: skill dir first, then index entry (a record always has content).
- `remove` order: index entry first, then the skill dir (a dir without a record is
  garbage, never a dangling record).
- Import skips junk (`__pycache__`, `.git`, `node_modules`, `.DS_Store`); any other
  non-regular file triggers a stderr warning and is skipped.

## Concurrency

No locking in v1. Assumption: single interactive user; the LLM runs commands
sequentially. Atomic renames prevent corruption; last-writer-wins is acceptable.
(Revisit only if background automation is added — see doc 07 future work.)

## Corruption & recovery

- If `index.json` fails to parse: all commands exit 2 with
  `error: index.json is corrupted — fix or restore <path>` and stop (never
  silently rebuild, since name/description exist nowhere else).
- Orphaned skill dirs (no index entry) are ignored by readers; `list` prints a
  stderr warning when it detects any.
- Backups: cutover runbook (doc 06) tars originals before any deletion.
