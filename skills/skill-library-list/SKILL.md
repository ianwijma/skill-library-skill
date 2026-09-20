---
name: skill-library-list
description: Use when browsing the skill catalog, checking what is in the library, or diffing source skill directories against the library for rerunnable imports. Prints every skill as JSON with id, name, description, store path, and directory.
---

# skill-library list

Prints the catalog as JSON, sorted by name ascending:

```sh
skill-library list                      # {"skills":[{id,name,description,path,dir}...]}
skill-library list --return-content     # each record also carries its SKILL.md text
```

Use cases: cheap orientation; the diff source for rerunnable imports (compare
source dirs by `name`; `--return-content` shows what the library currently
stores). Orphaned store dirs trigger a stderr warning.
