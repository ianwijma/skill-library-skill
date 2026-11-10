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

Requires [Node.js](https://nodejs.org) >= 22 and `git`. Get a TypeSafe API key
from [TypeSafe](https://docs.typesafe.ai), then:

```sh
npm i -g skill-library
export SKILL_LIBRARY_TYPESAFE_API_KEY='<your TypeSafe API key>'   # also add it to your shell profile
skill-library connect
```

`connect` installs the gateway skill into every agent on your machine (Claude
Code, Codex, OpenCode, Cursor, …), so they know to query the library. Restart
your agent so it loads it.

## Try it

Add two skills to your global library: Anthropic's `pdf` and `xlsx` skills.

```sh
skill-library add anthropics/skills -s pdf xlsx -g
```

They go into the library (`~/.local/share/skill-library`), not into your
agents' skills folders, so they cost no context until a task needs them. Now ask
the library which skills a task needs, the same way your agent does:

```sh
skill-library query "pull the totals table out of invoice.pdf into a spreadsheet"
```

Both skills come back, each with the `SKILL.md` path the agent reads. A task
that needs neither, such as `"rename a variable in utils.ts"`, gets
`No matching skills`. In your agent you don't run `query` yourself: just ask for
the task and the gateway skill runs it.

`query` sends the task text and the candidate skills' names and descriptions to
TypeSafe (`api.typesafe.ai`). Skill ids and paths never leave your machine. The
other commands need neither an API key nor network access (except to fetch
remote sources).

## Remove the examples

```sh
skill-library remove pdf xlsx -g
```

`-g` deletes them from the library. Your agents keep the gateway skill.

## Commands

| Command | What it does |
|---|---|
| `connect` | Install the gateway skill into your agents, so they query the library. `-a <agents>` for only some agents. `add` also does this after adding skills. |
| `add <source>` | Add skills from GitHub (`owner/repo`, `owner/repo@skill`), a git URL or a local folder. Project scope by default; `-g` for the whole library. `-a <agents>` records which agents a skill is for. |
| `list` / `ls` | List the project's skills; `-g` for the whole library; `--json` for scripts. |
| `remove [skills]` | In a project: drop the reference (the skill stays in the library). `-g`: delete it. |
| `update` / `check` | Pull newer versions from each skill's source / report them. |
| `install` | Restore a project's skills from `skill-library.json`, at the pinned versions. |
| `find [query]` | Search [skills.sh](https://skills.sh). |
| `init [name]` | Create a new `SKILL.md`. `--always` makes every query return it (see below). |
| `use <source>@<skill>` | Print a prompt for one skill without adding it (`| claude`), or start an agent with `-a`. |
| `query "<task>"` | Find the skills for a task. Prints the `SKILL.md` paths to read. |
| `sync init <git-url>` | Keep your global skills in a git repository (any host) and sync them across machines automatically. `sync update` / `sync disable` / `sync enable` / `sync status`. |

`skill-library --help` lists every flag. Details: [CLI spec](docs/02-cli-spec.md).

## Projects

Run `skill-library add <source>` inside a repository and the skill is recorded in
`skill-library.json` at the project root — commit it. Each entry pins the exact
commit and a content hash, so a teammate (or your other machine) runs
`skill-library install` and gets the same skills; tampered content is refused.

Folders inside the repository (`skill-library add ./skills/foo`) are read in
place. Inside the project, `query` sees the project's skills plus your global
library; when both have a skill with the same name, the project's wins.

## Always-on skills

A skill whose frontmatter sets `metadata.always: true` is returned by every
`query`, without being scored. Use it for your own rules that apply to every
task, such as team conventions. `skill-library init <name> --always` writes the
flag for you:

```yaml
---
name: house-rules
description: Our team's conventions
metadata:
  always: true
---
```

Always-on skills come first in the results, are shown as `(always)` (probability
1 with `--json`) and don't count towards `--top`. Shadowing and `-a` still apply.
If every candidate is always-on, `query` makes no API call and needs no key.

## Syncing global skills across machines

```sh
skill-library sync init git@bitbucket.org:me/my-skills.git   # once per machine, any git URL
```

The repository holds a `skill-library.json` (skills from other repos, pinned)
and a `skills/` folder (your own skills). Every machine keeps a clone. From then
on `add -g`, `remove -g` and `update -g` commit and push, and `query` starts a
background sync at most once an hour (`SKILL_LIBRARY_SYNC_TTL`, in seconds), so
new skills and newer versions show up everywhere on their own.

A global skill added from a local folder stays on this machine unless you share
it: `add -g` asks (or pass `--share`), and `skill-library sync share <name>`
shares one later. Skills you copied from someone else's repo are better added
from that repo, so they keep getting updates.

`skill-library sync disable` stops all pulling and pushing while you test;
`skill-library sync enable` turns it back on. To move to another repository,
run `skill-library sync update <git-url>`. It pushes everything there and uses
that repository from then on. Details: [09 — global sync](docs/09-global-sync-options.md).

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
| [10 — releasing](docs/10-releasing.md) | One-time GitHub and npm setup for releases |

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

### Releasing

- **First time only:** set up npm and GitHub with
  [docs/10-releasing.md](docs/10-releasing.md).
- **Run a release:**
  - Open **Actions → Release → Run workflow**.
  - Leave the branch on `develop`.
  - Pick a **Version bump**. Each run bumps the current version in
    `package.json`; examples from `1.2.3`:
    - `patch`: `1.2.3` → `1.2.4`, for bug fixes.
    - `minor`: `1.2.3` → `1.3.0`, for new features that don't break anything.
    - `major`: `1.2.3` → `2.0.0`, for breaking changes.
    - `prepatch`: `1.2.3` → `1.2.4-rc.0`, the first release candidate of a patch.
    - `preminor`: `1.2.3` → `1.3.0-rc.0`, the first release candidate of a minor.
    - `premajor`: `1.2.3` → `2.0.0-rc.0`, the first release candidate of a major.
    - `prerelease`: `1.3.0-rc.0` → `1.3.0-rc.1`, the next release candidate.
  - For a `pre*` bump, set the **Prerelease identifier** (default `rc`; `beta`
    gives `1.3.0-beta.0`).
  - Release candidates, step by step:
    - Run `preminor` once to get `1.3.0-rc.0`.
    - Run `prerelease` for each next candidate: `1.3.0-rc.1`, `1.3.0-rc.2`, ...
    - Run `minor` to release it: `1.3.0-rc.2` → `1.3.0`.
    - Don't run `preminor` again on a candidate: that starts `1.4.0-rc.0`.
  - **Dry run** is ticked by default: it checks everything without pushing or
    publishing. Untick it to release for real.
  - Click **Run workflow**.
  - Wait for **Plan release** to finish, then open the run's summary. It shows:
    - What is published now: npm `latest` and `next`, the latest GitHub Release
      and git tag.
    - What this run will publish: the new version, tag and npm dist-tag.
    - Any blockers. With a blocker the run stops and nothing is published.
    - The changes since the last release and the files in the npm package.
  - If everything is correct, click **Review deployments**, tick `release` and
    **Approve and deploy**. To stop, click **Reject** instead.
  - Wait for the remaining jobs to go green.
  - Check the new version on [npm](https://www.npmjs.com/package/skill-library)
    and the new GitHub Release.
- **What the workflow does:**
  - Tests, typechecks and builds, and writes the release plan summary.
  - Stops on a blocker: the version or tag already exists, or a stable version
    isn't newer than npm `latest`.
  - Waits for your approval on the `release` environment.
  - Commits the new version to `develop` and pushes a `vX.Y.Z` tag. If `develop`
    moved since the plan, it stops instead.
  - Publishes that tag to npm with provenance. Prereleases go to the `next`
    dist-tag.
  - Creates a GitHub Release with generated notes.
- **If it fails:**
  - **Publish failed:** click **Re-run failed jobs**. It publishes the tag that
    was already pushed, without bumping again.
  - **"may not run releases":** only the repository owner can release, unless
    the `RELEASE_ACTORS` repository variable lists your GitHub login.

## License

MIT. Parts of the agent table, agent detection, skill discovery, source parsing
and CLI text are adapted from [vercel-labs/skills](https://github.com/vercel-labs/skills)
(MIT); see `ThirdPartyNotices.txt` in the package.
