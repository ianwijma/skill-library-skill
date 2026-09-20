---
name: skill-library-query
description: Use when scoring the skill catalog for a task or tuning query results — thresholds, result caps, stdin input, or embedding skill content in the query output. The skill-library gateway runs this on every user message; read this skill when results need adjusting or the task text is long or multiline.
---

# skill-library query

Asks the TypeSafe Jev model which cataloged skills are needed for a task. One
positional: the task description (quote it). Output: JSON
`{"matches":[{id,name,description,path,probability}...]}`, sorted by
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
- Missing `TYPESAFE_API_KEY` → exit 2; per the gateway fallback, continue
  unblocked and tell the user
