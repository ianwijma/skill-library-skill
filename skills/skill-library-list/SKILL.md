---
name: skill-library-list
description: Use when browsing the skill catalog, checking what is in the library, or diffing source skill directories against the library for rerunnable imports. Prints every skill as JSON with id, name, description, and store path.
---

# skill-library list

Prints the catalog as JSON, sorted by name ascending:

```sh
skill-library list                      # {"skills":[{id,name,description,path}...]}
skill-library list --return-content     # each record also carries its full text
```

Use cases: cheap orientation; the diff source for rerunnable imports (compare
source dirs by `name`; `--return-content` shows what the library currently
stores). Orphaned store files trigger a stderr warning.
