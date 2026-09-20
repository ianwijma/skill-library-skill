# 07 — Implementation Plan

## Repo layout

```
/
├── README.md                     index + quickstart (manual install steps)
├── docs/                         this doc set (01–07)
├── package.json                  (bun) scripts: build, test, typecheck
├── tsconfig.json
├── skills/
│   ├── skill-library/SKILL.md            gateway (verbatim from doc 05)
│   ├── skill-library-{query,list,get,    one skill per subcommand
│   │   add,update,remove}/SKILL.md
│   ├── skill-importer/SKILL.md           onboarding, journals every change
│   └── skill-importer-undo/SKILL.md      reverses an import run / cutover
├── src/
│   ├── index.ts                  arg parsing → command dispatch, global flags
│   ├── cmd/
│   │   ├── query.ts              index → questions → API → threshold/sort/top
│   │   ├── list.ts
│   │   ├── add.ts
│   │   ├── update.ts
│   │   ├── remove.ts
│   │   └── get.ts
│   └── lib/
│       ├── paths.ts              store dir resolution, path helpers
│       ├── store.ts              index load/save (atomic), record projection
│       ├── ids.ts                id generation + collision loop
│       ├── typesafe.ts           HTTP client, retry/backoff, question builder
│       └── cli.ts                arg parsing helpers, JSON output, exit codes
└── test/
    ├── store.test.ts
    ├── cli.test.ts
    └── query.test.ts
```

One runtime dependency: the official [`@typesafe-ai/sdk`](https://docs.typesafe.ai/sdk/javascript)
(D15) carries the System One call — retries, per-attempt timeout, and typed errors.
Arg parsing stays hand-rolled; no YAML/frontmatter parsing needed (D5). The SDK
is bundled into the compiled binary.

## Milestones

### M1 — Store core (no API)
- `paths`, `ids`, `store` (load/save/atomic write), `add/list/update/remove/get`
- Acceptance: full CRUD roundtrip on a temp store; atomicity under simulated
  crash (kill between write and rename); id stability across `update --name`

### M2 — Query
- `typesafe.ts` client + question builder; `query` command with
  threshold/sort/top; retry policy; empty-catalog and missing-key paths
- Acceptance: golden request bodies against a local mock `Bun.serve` endpoint;
  429/529 retry honored (Retry-After + backoff); threshold/top correctness

### M3 — Binary + install
- `bun build --compile` → `dist/skill-library`; README documents manual install
  (binary onto `PATH`, optional `sli` alias) and `npx skills add` for skill files
- Acceptance: `skill-library --version` works from a clean shell without bun on PATH
  (static binary)

### M4 — Wrapper skills
- Finalize both SKILL.md drafts (doc 05) as real files; install via the README
  steps or `npx skills add`
- Acceptance: after restart, both skills appear in session; `skill-library`
  description triggers on arbitrary tasks

### M5 — Tests + polish
- Unit: ids, atomic writes, projection, validation (name rules, missing files)
- Integration: CLI subprocess tests on temp stores (full CRUD, exit codes, JSON
  shapes); mock API for query
- Typecheck + `bun test` green; `--help` output finalized

### M6 — Real-world calibration (doc 04 checklist)
- Import the 4 existing skills (dry-run by hand), probe queries, tune
  criteria/wording — no threshold change unless calibration demands it

## Test plan

| Layer | Tool | Cases |
|---|---|---|
| Unit | `bun test` | id generation/collision; name validation; atomic rename semantics; record projection (`path` absolutized); partial update semantics |
| Store | `bun test` | add→list→get→update→remove roundtrip; remove returns content; orphan detection; corrupted index → exit 2 |
| Query | `bun test` + `Bun.serve` mock | request body snapshot (state/questions shape); answer mapping; threshold edge (0.699/0.7); `--top` truncation; tie-break ordering; empty store short-circuit |
| E2E manual | real API | 5–6 probe tasks vs real catalog (M6) |

## Edge-case checklist (implementation must handle)

- [ ] `add` with unreadable/missing `--path` → exit 1
- [ ] `add` duplicate name → stderr warning, proceeds with unique id
- [ ] `update` unknown id → exit 1; unknown id on remove/get → exit 1
- [ ] `update` with no flags → exit 1 (nothing to do)
- [ ] `query` with empty task text → exit 1
- [ ] `query` with `-` and empty stdin → exit 1
- [ ] Skill with empty description → excluded + stderr warning
- [ ] Empty store query → no API call, `{"matches":[]}`
- [ ] `TYPESAFE_API_KEY` unset → exit 2 + hint (only `query` requires it)
- [ ] `--return-content` on all read-type outputs (query/list/get) and after add/update/remove content changes
- [ ] Store dir missing → auto-create on write commands; read commands treat as empty catalog

## Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Jev scores unreliable for the catalog | wrong skills loaded / none loaded | calibration milestone M6; criteria wording; curated descriptions; threshold tunable |
| TypeSafe API outage | query fails | skill fallback contract (continue unblocked); retries |
| Multi-file skills silently broken after import | skill references dead paths | staging step in importer; documented limitation |
| index.json corruption | catalog unreadable | atomic writes; explicit exit-2 error; backup in runbook |
| Every-message query latency/cost | slower sessions | single parallel-questions request; ~1.5–2k tokens at catalog ~10; `--top`/`--threshold` tuning; revisit policy if it hurts |
| Name/description drift between index and file frontmatter | confusion | documented: index is authoritative (D5) |

## Future work (explicitly out of v1)

- `skill-library rebuild` (regenerate index from content files if metadata lost — needs
  metadata embedded in files, revisit with frontmatter rewriting)
- Borderline band output (`--borderline`) for 0.3–0.7 probabilities
- File locking if background automation ever writes concurrently
- Per-skill usage stats (which skills actually get loaded) to prune the catalog
- Store format v2 with bundled multi-file skills (zip/tar entries)
