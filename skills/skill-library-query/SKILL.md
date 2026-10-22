---
name: skill-library-query
description: Use when scoring the skill catalog for a task or tuning query results — thresholds, result caps, stdin input, or embedding skill content in the query output. The skill-library gateway runs this whenever a skill might help; read this skill when results need adjusting or the task text is long or multiline.
---

# skill-library query

Asks the TypeSafe Jev model which cataloged skills are needed for a task. One
positional: the task description (quote it). Output: JSON
`{"matches":[{id,name,description,path,dir,probability}...]}`, sorted by
probability descending.

```sh
skill-library query "<task text>"
```

## Flags

- `--threshold <0..1>` — minimum probability to include a match (default 0.7)
- `--top <n>` — cap the number of matches
- `--return-content` — embed each matched skill's full text in the output (saves
  a Read step at the cost of a larger output; prefer path + Read normally)
- `--pretty` — pretty-print JSON; `--store <dir>` — store override; `--verbose`
  — token usage on stderr

## Tips

- Long/multiline task text: `cat <<'EOF' | skill-library query - … EOF` or
  `skill-library query "$(cat task.md)"`
- `--threshold 0.8` (stricter) or `--threshold 0.5` (broader recall)
- Empty `matches` → proceed on your own judgment; a re-query at a lower
  threshold recovers misses
- Exit 2 → explain the stderr diagnostic. Missing `TYPESAFE_API_KEY` or HTTP 401
  means credentials need attention; a connection error can come from network,
  DNS, proxy, or sandbox restrictions and does not prove a service outage.
- When scoring fails, run `skill-library list` with the same store, select
  relevant names/descriptions locally, and read their returned `path` files.
  This needs no network or API key. If the local catalog also fails, continue
  with available guidance; avoid repeating the failed query until conditions change.
