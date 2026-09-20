---
name: skill-library-get
description: Use when inspecting a single cataloged skill or retrieving its full SKILL.md content without reading the file by path. Takes one positional skill id; supports --return-content.
---

# skill-library get

```sh
skill-library get <id>                  # {id,name,description,path,dir}
skill-library get <id> --return-content # adds the full SKILL.md text
```

Use cases: pre-add review, refresh checks, content retrieval. Unknown id →
exit 1 (`error: unknown skill id '<id>'`).
