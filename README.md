<p align="center"><img src="assets/icon.svg" alt="Skill Library icon" width="96" height="96"></p>

# Skill Library (skill-library)

Skills on demand — not always loaded.

One small gateway skill checks what a task needs. The `skill-library` CLI
scores your library with [TypeSafe](https://docs.typesafe.ai)'s Jev model, and
the agent reads only the skills that matter. Everything else stays out of the
context window.

The CLI speaks the [vercel-labs/skills](https://github.com/vercel-labs/skills)
command contract — `add`, `list`, `remove`, `update`, `check`, `install`, `find`,
`init`, `use` — with one difference: skills you add go into the library, never
into your agents' skills folders.

## Quick start

Requires [Node.js](https://nodejs.org) >= 22 and `git` (for remote sources).

```sh
npm i -g skill-library            # or run it with npx skill-library …
skill-library add vercel-labs/agent-skills -g
```

`add` stores the skills in the library (`~/.local/share/skill-library`) and
places the gateway skill in every installed agent's global skills folder
(Claude Code, Codex, OpenCode, Cursor, …). Restart your agent so it loads the
gateway.

Then set your TypeSafe key in the environment that launches your agent:

```sh
export SKILL_LIBRARY_TYPESAFE_API_KEY='<your TypeSafe API key>'
skill-library query -a claude-code "fix a failing next.js build"
```

`query` sends the task text and the candidate skills' names and descriptions to
TypeSafe (`api.typesafe.ai`). Skill ids and paths never leave your machine. The
other commands need neither an API key nor network access (except to fetch
remote sources).

## Commands

| Command | What it does |
|---|---|
| `add <source>` | Add skills from GitHub (`owner/repo`, `owner/repo@skill`), a git URL or a local folder. Project scope by default; `-g` for the whole library. `-a <agents>` records which agents a skill is for. |
| `list` / `ls` | List the project's skills; `-g` for the whole library; `--json` for scripts. |
| `remove [skills]` | In a project: drop the reference (the skill stays in the library). `-g`: delete it. |
| `update` / `check` | Pull newer versions from each skill's source / report them. |
| `install` | Restore a project's skills from `skill-library.json`, at the pinned versions. |
| `find [query]` | Search [skills.sh](https://skills.sh). |
| `init [name]` | Create a new `SKILL.md`. |
| `use <source>@<skill>` | Print a prompt for one skill without adding it (`| claude`), or start an agent with `-a`. |
| `query "<task>"` | Find the skills for a task. Prints the `SKILL.md` paths to read. |
| `sync init <git-url>` | Keep your global skills in a git repository (any host) and sync them across machines automatically. `sync disable` / `sync enable` / `sync status`. |

`skill-library --help` lists every flag. Details: [CLI spec](docs/02-cli-spec.md).

## Projects

Run `skill-library add <source>` inside a repository and the skill is recorded in
`skill-library.json` at the project root — commit it. Each entry pins the exact
commit and a content hash, so a teammate (or your other machine) runs
`skill-library install` and gets the same skills; tampered content is refused.

Folders inside the repository (`skill-library add ./skills/foo`) are read in
place. Inside the project, `query` sees the project's skills plus your global
library; when both have a skill with the same name, the project's wins.

## Syncing global skills across machines

```sh
skill-library sync init git@bitbucket.org:me/my-skills.git   # once per machine, any git URL
```

The repository holds a `skill-library.json` (skills from other repos, pinned)
and a `skills/` folder (your own skills). Every machine keeps a clone. From then
on `add -g`, `remove -g` and `update -g` commit and push, and `query` starts a
background sync at most once an hour (`SKILL_LIBRARY_SYNC_TTL`, in seconds), so
new skills and newer versions show up everywhere on their own.

`skill-library sync disable` stops all pulling and pushing while you test;
`skill-library sync enable` turns it back on. Details: [09 — global sync](docs/09-global-sync-options.md).

## Agents

`-a/--agent` takes vercel's agent ids (`claude-code`, `codex`, `opencode`,
`cursor`, `gemini-cli`, …). A skill added with `-a codex` is only returned to
`query -a codex`. Skills without `-a` are for every agent. Each agent passes its
own id; an unknown id prints the valid list.

## Programmatic API

```ts
import { add, list, query } from "skill-library";

await add("vercel-labs/agent-skills", { skills: ["frontend-design"], global: true });
const { matches } = await query("design a landing page", { agent: "claude-code" });
```

The API never prints, prompts, or touches agent folders.

## Troubleshooting query failures

| Diagnostic | What to check |
|---|---|
| Command not found | `npm i -g skill-library`, and make sure npm's bin directory is on the agent's `PATH` |
| Missing `SKILL_LIBRARY_TYPESAFE_API_KEY` / HTTP 401 | Set a valid key in the environment that launches the agent |
| Connection error / timeout | Network access, DNS, proxy settings, and sandbox restrictions |
| `N project skills are not installed` | Run `skill-library install` in the project |
| Store error | Follow the reported store diagnostic; this is independent of TypeSafe |

If online scoring is unavailable, `skill-library list --json` and
`skill-library list -g --json` show the skills and their paths without network access.

## Docs

| Doc | Contents |
|---|---|
| [01 — overview](docs/01-overview.md) | Problem, architecture, key decisions |
| [02 — CLI spec](docs/02-cli-spec.md) | Commands, flags, JSON, exit codes |
| [03 — data store](docs/03-data-store.md) | Store layout, ids, versions, `skill-library.json` |
| [04 — query](docs/04-typesafe-query.md) | Jev integration, candidates, thresholds |
| [08 — vercel parity plan](docs/08-vercel-parity-plan.md) | The design behind this version |
| [09 — global sync](docs/09-global-sync-options.md) | Sync global skills through a git repo |

## Development

Working on the repository needs Node.js >= 22.18: `npm start` runs the TypeScript
source directly, and vitest needs 22.12+. The published package itself runs on any
Node.js 22 or newer; CI tests it on 22.0.0 and the latest 24 and 26.

```sh
npm install
npm test            # vitest (builds the bundle first)
npm run typecheck   # tsc --noEmit
npm run build       # dist/skill-library (CLI), dist/index.js + dist/api.d.ts (API)
```

## License

MIT. Parts of the agent table, agent detection, skill discovery, source parsing
and CLI text are adapted from [vercel-labs/skills](https://github.com/vercel-labs/skills)
(MIT); see `ThirdPartyNotices.txt` in the package.
