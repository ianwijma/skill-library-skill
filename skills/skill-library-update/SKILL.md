---
name: skill-library-update
description: Use when editing an existing cataloged skill — renaming it, rewriting a weak description for better matching, or re-importing changed content from its source file. Only provided flags change; the id never changes.
---

# skill-library update

```sh
skill-library update <id> [--name <n>] [--description <d>] [--path <file>]
```

- `--description` — the main lever on query matching quality; rewrite weak ones
- `--path` — re-imports content (replaces the stored file verbatim)
- `--name` — rename; the id stays stable across renames

Unknown id → exit 1; no flags → exit 1 (nothing to do).
