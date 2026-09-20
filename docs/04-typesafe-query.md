# 04 — TypeSafe Query Integration

`skill-library query` uses TypeSafe's System One API (flagship model **Jev**) to score the
skill catalog against a task. Jev returns typed probabilities — one **Noul**
(yes/no) question per skill — instead of generated text.

Implementation: the official [`@typesafe-ai/sdk`](https://docs.typesafe.ai/sdk/javascript)
client sends the request below. Retry/timeout policy is configured on the client:
max 3 retries, 1s initial backoff doubling, `Retry-After` honored (capped at 30s),
30s per-attempt timeout, connection failures retried. Error classes (401/422/429,
connection, timeout) map to the CLI behaviors in "Failure handling".

## Endpoint

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

- Model: `"jev-latest"`.
- All questions travel in **one** request and evaluate in parallel — latency
  barely grows with catalog size.
- Credentials stay in the environment; never logged, never written to the store.

## Request shape

```json
{
  "state": { "task": "<the task text passed to skill-library query>" },
  "model": "jev-latest",
  "questions": {
    "9f3a1c2b": {
      "type": "noul",
      "instructions": {
        "skill": {
          "name": "frontend-design",
          "description": "Create distinctive, production-grade frontend interfaces. Use when building or styling web UI."
        },
        "question": "Would reading the skill `skill.name`, described below, improve how the assistant handles `state.task`?"
      },
      "criteria": {
        "true": "The skill is directly relevant to the task and would change or guide how it is done",
        "false": "The skill is unrelated, redundant, or would not meaningfully help"
      }
    },
    "7d0e4f11": { "…same shape, next skill…" : null }
  }
}
```

Design notes (grounded in TypeSafe's docs):

- **One proposition per Noul.** No compound conditions like "relevant AND
  up-to-date" — each would dilute the probability's meaning.
- **Phrased so a high value means yes.** Never invert ("is the skill
  unnecessary…") — downstream code would read it backwards.
- **Question ids are skill ids.** Ids are for code only; the model never sees
  them, so all meaning lives in `instructions`/`criteria`.
- **Structured instructions** carry each skill's name/description; the template
  question text stays identical across skills (code-built, like TypeSafe's
  duplicate-detection example).
- `criteria` descriptions sharpen the yes/no boundary; keep them as drafted
  unless calibration shows otherwise.

## Response shape

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "9f3a1c2b": { "type": "noul", "noul": 0.91 },
    "7d0e4f11": { "type": "noul", "noul": 0.03 }
  },
  "usage": { "input_tokens": 535, "output_tokens": 58 }
}
```

Mapping to CLI output: each answer id → its skill record; `noul` → `probability`.

## Threshold policy

| Value | Meaning | Action |
|---|---|---|
| ≥ `--threshold` (default **0.7**) | likely relevant | included in `matches` |
| 0.3 – 0.7 | unclear | **excluded** (v1). The skill may be under-called for genuinely ambiguous tasks; raising catalog description quality is the fix, not lowering the bar |
| < 0.3 | clearly irrelevant | excluded |

Rationale for 0.7: TypeSafe's own rerank/duplicate examples threshold at 0.7.
False positives cost more than false negatives here (loading an irrelevant skill
pollutes context for every message; missing one is recoverable with a re-query at
a lower threshold). Sort desc; `--top n` truncates after sorting.

## Failure handling

| Condition | Behavior |
|---|---|
| `401 Unauthorized` | exit 2, stderr: check `TYPESAFE_API_KEY` |
| `422 Unprocessable Entity` | exit 2 with response body (indicates a bug in question construction) |
| `429 Too Many Requests` / `529 Overloaded` | retry with exponential backoff: 1s, 2s, 4s (+jitter), max 3 retries; honor `Retry-After` header when present; then exit 2 |
| Network error / timeout (30s per attempt) | treated like a retryable failure |
| Empty catalog | skip the API call entirely, return `{"matches":[]}` |
| Skill with empty description | exclude from the request; warn on stderr |

## Cost & latency budget

From TypeSafe's published examples: a 2-question request ≈ 360 in / 39 out tokens;
3 questions ≈ 535 in / 58 out. Extrapolated: **~120–180 input tokens per
cataloged skill**, so a 10-skill catalog ≈ 1.5–2k input tokens per query — well
under the per-message cost of the always-loaded skills it replaces. One request
per query; expect ~1–3s roundtrip.

## Calibration checklist (during build)

1. Craft 5–6 probe tasks (frontend, library docs, opencode config, UI database, none-of-the-above).
2. Run `skill-library query` against the real 4-skill catalog; verify intended skills ≥ 0.7 and noise < 0.3.
3. If borderline scores cluster 0.5–0.7: tighten `criteria` wording before touching the threshold.
4. Log `usage` behind a `--verbose` flag (stderr) for cost visibility during development.
