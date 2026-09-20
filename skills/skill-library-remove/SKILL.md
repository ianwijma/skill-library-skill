---
name: skill-library-remove
description: Use when permanently deleting a skill from the library. Prints the deleted record including its full content so it stays recoverable from the transcript; confirm with the user before deleting.
---

# skill-library remove

```sh
skill-library remove <id>
```

- Output: `{id, name, description, content}` — the deleted skill, recoverable
  from the transcript
- No interactive prompt; confirm with the user before running (deletion safety)
- Unknown id → exit 1
