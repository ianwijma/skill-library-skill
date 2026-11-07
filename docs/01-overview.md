# 01 — Overview

## Problem

Every skill in an agent's skills folder (`~/.claude/skills/`, `~/.agents/skills/`, …)
is injected into the model's context on **every** invocation, regardless of
relevance. Each new skill raises the per-message token floor permanently.

## Goal

A skill library: skills live in a managed store **outside** the agents' skills
folders. A single small gateway skill teaches the agent to ask the library —
whenever a skill might help — which skills matter for the current task, and to
read only those. Matching is semantic, powered by TypeSafe's Jev model (typed
probabilities, not generated text).

The CLI follows the [vercel-labs/skills](https://github.com/vercel-labs/skills)
command contract (`add`, `list`, `remove`, `update`, `check`, `install`, `find`,
`init`, `use`), so people who know `npx skills` know `skill-library`. The
difference: added skills go into the library, never into agent folders. `query`
is the add-on that makes the library usable.

## Architecture

```
                        ┌────────────────────────────┐
 user message ────────▶ │ skill-library gateway      │  (the only file in agent folders)
                        │ "query when a skill might  │
                        │  help"                     │
                        └─────────────┬──────────────┘
                                      │ skill-library query -a <agent> "<task>"
                                      ▼
                        ┌────────────────────────────┐
                        │ skill-library CLI          │
                        │  - project + global skills │
                        │  - 1 × POST /v1/systemone  │────▶ api.typesafe.ai (jev-latest)
                        │  - threshold + sort        │     1 noul question per skill
                        └─────────────┬──────────────┘
                                      │ "Read these skill files…" + └ <path> lines
                                      ▼
                        ┌────────────────────────────┐
                        │ agent reads the SKILL.md   │  ~/.local/share/skill-library/skills/<slug>/<version>/SKILL.md
                        └────────────────────────────┘
```

## Components

| Component | Responsibility |
|---|---|
| `skill-library` CLI | vercel-compatible commands over the library + `query` (Jev scoring). Places the gateway during `add`. |
| Gateway skill (`skills/skill-library/SKILL.md`) | The query workflow and offline fallback. Embedded in the CLI and written to each installed agent's global skills folder by `add`. |
| Library (store) | `~/.local/share/skill-library/`: `index.json` + one folder per skill with one immutable sub-folder per version. See [03](03-data-store.md). |
| `skill-library.json` | Per project, committed. References skills by id with a pinned version and content hash, so the project works on another machine (`skill-library install`). |
| Programmatic API | `import { add, query, … } from "skill-library"` — the same operations without printing or prompts. |

## Key decisions

| # | Decision |
|---|---|
| D1 | Skills never go into agent folders; only the gateway does, and only `add` writes it. |
| D2 | One global store; project skills are stored there with `global: false` and referenced from the project's `skill-library.json`. Folders inside the project are read in place. |
| D3 | Skill ids come from the source: `repo://<host>/<repo>/<skill>`, `local://<path>`, `home://<path>`, `path://<abs>`. Same id = same skill. |
| D4 | Versioned store: projects pin a version (commit + content hash); global scope uses `current`. `install` verifies the hash and refuses tampered content. |
| D5 | `-a/--agent` on `add` records which agents a skill is for; `query -a` filters on it. Jev scoring is unchanged and knows nothing about agents. |
| D6 | One Noul question per skill, one API call, opaque question keys; threshold 0.7. |
| D7 | Single bundled Node.js file; no runtime dependencies besides Node.js and `git` (for remote sources). |
| D8 | No telemetry, no security audit calls. |

The full design and its review history: [08 — vercel parity plan](08-vercel-parity-plan.md).
