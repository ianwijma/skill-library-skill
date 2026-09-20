# 02 — CLI Specification

`skill-library` — the skill library CLI. Single compiled binary (Bun/TypeScript). All
commands print results as JSON on **stdout**; all errors as plain text on
**stderr**. Exit codes signal outcome class.

## Conventions

- **Global flags** (accepted by every command):
  - `--return-content` — include the skill's full text as a `content` field in each returned record
  - `--store <dir>` — override the store directory (default `~/.local/share/skill-library`; env `SKILL_LIBRARY_DIR` takes precedence over the default, flag over both)
  - `--pretty` — pretty-print JSON (2-space indent). Default is compact single-line (primary consumer is the LLM; compact saves context tokens)
  - `--help`, `--version`
- **Record shape** (wherever a skill is returned):
  ```json
  { "id": "9f3a1c2b", "name": "frontend-design", "description": "…", "path": "/home/ian/.local/share/skill-library/skills/9f3a1c2b.md" }
  ```
  `--return-content` adds `"content": "…"`. Extra internal metadata (`source`,
  `addedAt`, `updatedAt`) lives in `index.json` only and is **not** part of the
  output contract.
- **Exit codes**: `0` success · `1` usage/validation error (bad args, unknown id, missing file) · `2` runtime failure (network, TypeSafe API, filesystem IO).

## `skill-library query "<task text>"` — score the catalog for a task

The core command. Asks Jev which cataloged skills are needed for the described task.

| | |
|---|---|
| Args | Task description as one positional string. Use `-` to read the task text from stdin (long/multiline descriptions). If both are given, positional wins. |
| Flags | `--threshold <0..1>` (default `0.7`) · `--top <n>` (cap number of matches) |
| Behavior | Load index → one `POST /v1/systemone` call with one Noul question per skill → filter by threshold → sort by probability desc (tie-break by name asc) → apply `--top` |
| Output | `{"matches": [record…, "probability": <n>]}` — each match is the record shape plus `"probability"` |
| Edge cases | Empty store → `{"matches":[]}` · missing `TYPESAFE_API_KEY` → exit 2 with hint · skill with empty description → excluded from scoring, warning on stderr |

Examples:

```sh
skill-library query "fix a failing Next.js production build"
# {"matches":[{"id":"9f3a1c2b","name":"nextjs-build","description":"…","path":"/home/ian/.local/share/skill-library/skills/9f3a1c2b.md","probability":0.91}]}

skill-library query --threshold 0.8 --top 3 "design a dark dashboard with charts"
cat task.md | skill-library query -
skill-library query --return-content "review this PR for accessibility issues"
```

## `skill-library list` — the catalog

| | |
|---|---|
| Args | none |
| Output | `{"skills": [record…]}` — stable order (name asc) |
| Use | The LLM's diff source for rerunnable imports; cheap orientation |

```sh
skill-library list
skill-library list --return-content
```

## `skill-library add --name <n> --description <d> --path <file>` — create

| | |
|---|---|
| Args | All three flags required: explicit name, description, and path to the skill file to import |
| Behavior | Read the file → generate a fresh 8-char `id` → copy content verbatim into the store as `<skills>/<id>.md` → append record to index (atomic write). `path` in the returned record is the **store** path, not the source. |
| Validation | `--path` must exist and be a readable file (else exit 1) · `name` must be non-empty, lowercase-hyphen, ≤64 chars (else exit 1) · duplicate name → warning on stderr, still proceeds (IDs are unique) |
| Output | The created record (plus `content` with `--return-content`) |

```sh
skill-library add --name context7-mcp --description "Use when questions involve libraries, frameworks, or APIs; fetch current docs via Context7 MCP." --path ~/.agents/skills/context7-mcp/SKILL.md
```

## `skill-library update <id> --name <n> --description <d> --path <file>` — update

| | |
|---|---|
| Args | `id` positional + any of the three flags; only provided fields change. The `id` never changes. |
| Behavior | With `--name`/`--description`: rewrite index fields. With `--path`: read the file, **replace** the store file's content atomically. `updatedAt` refreshed on any change. |
| Validation | Unknown id → exit 1 · `--path` unreadable → exit 1 |
| Output | The updated record (plus `content` with `--return-content`) |

```sh
skill-library update 9f3a1c2b --description "Rewritten description front-loading trigger keywords."
skill-library update 9f3a1c2b --path ~/.opencode/skills/frontend-design/SKILL.md
```

## `skill-library remove <id>` — delete

| | |
|---|---|
| Args | `id` positional |
| Behavior | Read the record **and its content**, delete the store file, remove the index entry (atomic write). No interactive prompt. |
| Output | `{"id":…, "name":…, "description":…, "content":…}` — the deleted skill, recoverable from the transcript |
| Edge cases | Unknown id → exit 1 |

## `skill-library get <id>` — inspect one skill

| | |
|---|---|
| Args | `id` positional |
| Output | The record (plus `content` with `--return-content`) |
| Use | Pre-`add` review, refresh checks, content retrieval without reading via path |

## Error output format

Plain text on stderr, one line, actionable where possible:

```
error: unknown skill id 'deadbeef'
error: --path not found: /nope/SKILL.md
error: TYPESAFE_API_KEY is not set (required for query). Export it and retry.
error: typesafe api 429 after 3 retries — try again shortly
```

## Help text

`skill-library --help` lists the six commands with one-line summaries and the global flags;
each command also accepts `skill-library <cmd> --help`.
