# 01 — Overview

## Problem

Today every skill in `~/.opencode/skills/` and `~/.agents/skills/` is injected into
the model's context on **every** invocation, regardless of relevance. Five skills
are currently registered (4 user skills + 1 built-in), and each addition raises the
per-message token floor permanently.

## Goal

A skill library: skills live in a managed store **outside** opencode's auto-scan
paths. A single tiny always-loaded skill teaches the LLM to ask the library which
skills matter for the current task, and read only those. Matching is semantic,
powered by TypeSafe's Jev model (typed probabilities, not generated text).

## Architecture

```
                        ┌────────────────────────────┐
 user message ────────▶ │ skill-library skill        │  (always loaded, ~1 KB)
                        │ "query before every msg"   │
                        └─────────────┬──────────────┘
                                      │ sli query "<task text>"
                                      ▼
                        ┌────────────────────────────┐
                        │ sli (compiled binary)      │
                        │  - read index.json         │
                        │  - 1 × POST /v1/systemone  │────▶ api.typesafe.ai (jev-latest)
                        │  - threshold + sort        │     1 noul question per skill
                        └─────────────┬──────────────┘
                                      │ {"matches":[{id,name,description,path,probability}]}
                                      ▼
                        ┌────────────────────────────┐
                        │ LLM Reads matched files    │  ~/.local/share/skill-library/skills/<id>.md
                        └────────────────────────────┘
```

Management flow (LLM- or user-driven, and the importer skill):

```
 source skill dirs ──▶ sli add/update ──▶ managed store (verbatim file copy + index)
                        sli list/get      ◀─ diff source for rerunnable imports
                        sli remove
```

## Components

| Component | Responsibility |
|---|---|
| `sli` binary | Store CRUD + Jev scoring. No import logic, no skill installation logic. |
| `skill-library` skill | Always-on workflow: query → read matches → work. Plus CRUD reference and fallback behavior. |
| `skill-importer` skill | Rerunnable onboarding: discover → diff → import → curate descriptions → (optional, confirmed) cleanup of auto-load dirs. |
| `install.sh` | Build, install binary + alias, copy the two skill files. Plain bash — the app itself has no install command. |
| Managed store | `~/.local/share/skill-library/`: `index.json` + `skills/<id>.md` files. |

## Decision log

| # | Decision | Rationale |
|---|---|---|
| D1 | Compiled standalone binary (`bun build --compile`) | No runtime deps; stable absolute path the skill can reference |
| D2 | Binary named `sli`, alias `skill-library` | Short name typed by the LLM hundreds of times |
| D3 | Query on **every user message** | User decision; avoids stale-skill bugs at the cost of a small per-message latency/tokens |
| D4 | Import = LLM composing primitives (`list` + `add`/`update`) | Keeps the app minimal; diffing is trivial for the LLM; flow is rerunnable by nature |
| D5 | Record model keyed by generated `id`; name/description are explicit `add` args | IDs stay stable across renames; no frontmatter parsing needed in the app |
| D6 | Skills stored as verbatim file copies (`<id>.md`) | Store is self-contained; survives deletion of originals during cutover |
| D7 | One Noul question per skill, single API call | Multiple skills can apply; questions evaluate in parallel; scales with catalog size |
| D8 | Threshold default 0.7 | Matches TypeSafe docs' calibration examples; tunable via flag |
| D9 | `install-skill` subcommand dropped | install.sh handles installation; app stays a pure library |
| D10 | `remove` returns full record incl. content | Deleted skill recoverable from the transcript |
| D11 | `--return-content` flag on read-type commands | Lets the LLM trade one roundtrip for larger output when convenient |
| D12 | Build now, migrate later | Old skills keep auto-loading until cutover is explicitly run (see doc 06) |
| D13 | Permanent `skill-importer` skill | Onboarding is recurring (new skills appear over time); user preference |

## Non-goals (v1)

- No skill versioning/history, no multi-file asset management (documented limitation, see docs 05/06)
- No daemon/server; every command is a short-lived process
- No editing skill content through the CLI (content changes via `update --path` re-import)
- No automatic scheduling of imports; the importer skill runs when invoked

## Success criteria

1. A fresh session loads only `skill-library` (+ `skill-importer`) instead of all skills.
2. For a representative task, `sli query` returns the right skill(s) with probability ≥ 0.7 and no false positives above threshold.
3. Query roundtrip adds < ~2s and < ~2k input tokens at catalog size ~10.
4. Importer rerun after adding a new skill file picks up exactly the new/changed skills.
5. Cutover (originals removed from auto-load dirs) loses nothing: all 4 existing skills importable and retrievable from the store.
