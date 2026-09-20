---
name: skill-library-add
description: Use when importing a skill file into the library for the first time — onboarding new skills or registering a skill just written. Requires --name, --description, and --path; the description is what gets machine-matched, so curate it.
---

# skill-library add

Copies a skill file verbatim into the store and registers it:

```sh
skill-library add --name <name> --description "<desc>" --path <file>
```

- `--name` lowercase-hyphen, ≤64 chars; duplicate names warn on stderr but
  proceed (ids stay unique)
- The returned `path` is the STORE copy, not the source
- Description quality drives matching — front-load trigger keywords, third
  person ("Use when…"), what it does + when to use it, ≤ 2 sentences
