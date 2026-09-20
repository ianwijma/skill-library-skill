---
name: skill-library-add
description: Use when importing a skill into the library for the first time — onboarding new skills or registering a skill just written. Requires --name, --description, and --path (a skill directory or a SKILL.md file); the description is what gets machine-matched, so curate it.
---

# skill-library add

Copies a skill verbatim into the store and registers it. `--path` takes a skill
**directory** (copied wholesale — SKILL.md plus sibling scripts/data, so
relative references keep working) or a bare `SKILL.md` file:

```sh
skill-library add --name <name> --description "<desc>" --path <skill-dir-or-file>
```

- `--name` lowercase-hyphen, ≤64 chars; duplicate names warn on stderr but
  proceed (ids stay unique)
- The returned `path` is the STORE copy of SKILL.md, not the source; `dir` is
  the skill's directory root
- Description quality drives matching — front-load trigger keywords, third
  person ("Use when…"), what it does + when to use it, ≤ 2 sentences
