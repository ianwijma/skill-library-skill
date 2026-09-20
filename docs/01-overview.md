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
                                      │ skill-library query "<task text>"
                                      ▼
                        ┌────────────────────────────┐
                        │ skill-library (binary)     │
                        │  - read index.json         │
                        │  - 1 × POST /v1/systemone  │────▶ api.typesafe.ai (jev-latest)
                        │  - threshold + sort        │     1 noul question per skill
                        └─────────────┬──────────────┘
                                      │ {"matches":[{id,name,description,path,dir,probability}]}
                                      ▼
                        ┌────────────────────────────┐
                        │ LLM Reads matched files    │  ~/.local/share/skill-library/skills/<id>/SKILL.md
                        └────────────────────────────┘
```

Management flow (LLM- or user-driven, and the importer skill):

```
 source skill dirs ──▶ skill-library add/update ──▶ managed store (verbatim dir copy + index)
                         skill-library list/get      ◀─ diff source for rerunnable imports
                         skill-library remove
```

## Components

| Component | Responsibility |
|---|---|
| `skill-library` binary | Store CRUD + Jev scoring. No import logic, no skill installation logic. |
| `skill-library` skills | Always-on gateway (query workflow) + one skill per subcommand (query/list/get/add/update/remove), per D14. No import logic, no skill installation logic. |
| `skill-importer` skill | Rerunnable onboarding: discover → diff → journal → import → curate descriptions → (optional, confirmed) cleanup of auto-load dirs. |
| `skill-importer-undo` skill | Reverses an import run or the cutover from its journal: removes added skills, restores prior name/description/content. |
| `install.sh` | Removed. Installation is manual (README) or via `npx skills add ianwijma/skill-library-skill` for the skill files; the binary is built with `bun run build` and copied onto `PATH` by hand. |
| Managed store | `~/.local/share/skill-library/`: `index.json` + one verbatim directory per skill (`skills/<id>/` with `SKILL.md` plus any sibling assets). |

## Decision log

| # | Decision | Rationale |
|---|---|---|
| D1 | Compiled standalone binary (`bun build --compile`) | No runtime deps; stable absolute path the skill can reference |
| D2 | Binary named `skill-library`, alias `sli` | Typed by the LLM hundreds of times; the verbose name is unambiguous and self-documenting |
| D3 | Query on **every user message** | User decision; avoids stale-skill bugs at the cost of a small per-message latency/tokens |
| D4 | Import = LLM composing primitives (`list` + `add`/`update`) | Keeps the app minimal; diffing is trivial for the LLM; flow is rerunnable by nature |
| D5 | Record model keyed by generated `id`; name/description are explicit `add` args | IDs stay stable across renames; no frontmatter parsing needed in the app |
| D6 | Skills stored as verbatim directory copies (`skills/<id>/`) | Multi-file skills (scripts, data) keep working — relative references resolve inside the store; survives deletion of originals during cutover |
| D7 | One Noul question per skill, single API call | Multiple skills can apply; questions evaluate in parallel; scales with catalog size |
| D8 | Threshold default 0.7 | Matches TypeSafe docs' calibration examples; tunable via flag |
| D9 | `install-skill` subcommand dropped | installation is manual (README) or via `npx skills add` for skill files; app stays a pure library |
| D10 | `remove` returns full record incl. content | Deleted skill recoverable from the transcript |
| D11 | `--return-content` flag on read-type commands | Lets the LLM trade one roundtrip for larger output when convenient |
| D12 | Build now, migrate later | Old skills keep auto-loading until cutover is explicitly run (see doc 06) |
| D13 | Permanent `skill-importer` skill | Onboarding is recurring (new skills appear over time); user preference |
| D14 | One skill per subcommand (7 + importer) | Gateway stays lean for the per-message loop; every library capability gets a focused, triggerable description |
| D15 | Official `@typesafe-ai/sdk` for the System One call | Retries, timeouts, and typed errors battle-tested upstream; hand-rolled HTTP client dropped |
| D16 | Imports write an undo journal (`<store>/imports/<run>/`) | Prior name/description/content captured before mutation; `skill-importer-undo` replays it in reverse |

## Non-goals (v1)

- No skill versioning/history
- No daemon/server; every command is a short-lived process
- No editing skill content through the CLI (content changes via `update --path` re-import)
- No automatic scheduling of imports; the importer skill runs when invoked

## Success criteria

1. A fresh session loads only the `skill-library` skills (gateway + per-command) and `skill-importer` instead of all skills.
2. For a representative task, `skill-library query` returns the right skill(s) with probability ≥ 0.7 and no false positives above threshold.
3. Query roundtrip adds < ~2s and < ~2k input tokens at catalog size ~10.
4. Importer rerun after adding a new skill file picks up exactly the new/changed skills.
5. Cutover (originals removed from auto-load dirs) loses nothing: all 4 existing skills importable and retrievable from the store.
