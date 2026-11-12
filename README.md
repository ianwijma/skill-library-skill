# <img src="assets/icon.svg" alt="Skill Library icon" width="32" height="32" align="absmiddle"> Skill Library (skill-library)

Skills on demand — not always loaded.

Agents load every installed skill's description into their context up front.
With a handful of skills that's fine. With hundreds, every conversation pays
for all of them, and the agent has to pick the right one from a long list.

Skill Library keeps your skills in a library instead, outside the agent. One
small gateway skill asks the library which skills the current task needs, and
the agent reads only those. Matching is done by [TypeSafe](https://docs.typesafe.ai)'s
Jev model, so the right skills come back even when the task doesn't name them.

Built for people and companies with a lot of skills:

- **Any number of skills, small context.** Only the skills a task needs are
  loaded.
- **Synced across your machines.** Keep your skills in a git repository and
  every machine picks up new and updated skills on its own.
- **Shared with your team.** A project's skills are pinned in
  `skill-library.json`; teammates run `skill-library install` and get the same
  versions.
- **Works with your agents.** Claude Code, Codex, OpenCode, Cursor, Gemini CLI
  and many more.

## Quick start

Requires [Node.js](https://nodejs.org) >= 22 and `git`. Get a TypeSafe API key
from the [TypeSafe console](https://console.typesafe.ai/keys), then:

```sh
export SKILL_LIBRARY_TYPESAFE_API_KEY='<your TypeSafe API key>'   # also add it to your shell profile
npx skill-library self setup
```

Restart your agent afterwards. Run `skill-library self setup` again any time to
update.

## Try it

Add three of Anthropic's skills to your global library: `pdf`, `xlsx` and
`frontend-design`.

```sh
skill-library add anthropics/skills -s pdf xlsx frontend-design
```

They go into the library (`~/.local/share/skill-library`), not into your
agents' skills folders, so they cost no context until a task needs them. Now ask
the library which skills a task needs, the same way your agent does:

```sh
skill-library query "pull the totals table out of invoice.pdf into a spreadsheet"
```

`pdf` and `xlsx` come back, each with the `SKILL.md` path the agent reads.
`frontend-design` doesn't: it has nothing to do with this task, so it stays out
of the agent's context. Ask for `"build a landing page for a coffee shop"` and
only `frontend-design` comes back. In your agent you don't run `query`
yourself: just ask for the task and the gateway skill runs it.

`query` sends the task text and the candidate skills' names and descriptions to
TypeSafe (`api.typesafe.ai`). Skill ids and paths never leave your machine. The
other commands need neither an API key nor network access (except to fetch
remote sources).

## Remove the examples

```sh
skill-library remove pdf xlsx frontend-design
```

This deletes them from the library. Your agents keep the gateway skill.

## Commands

| Command | What it does |
|---|---|
| `add <source>` | Add skills from GitHub (`owner/repo`, `owner/repo@skill`), a git URL or a local folder. Global by default; `-p` pins them in the project's `skill-library.json`. In a folder that has one, you're asked which you mean; scripts and agents pass `-p` or `-g`. `-a <agents>` records which agents a skill is for. |
| `list` / `ls` | List the project's skills (the whole library when there's no `skill-library.json`); `-g` for the whole library; `--json` for scripts. |
| `remove [skills]` | Delete from the library. `-p`: only drop the project's reference (the skill stays in the library). In a folder with a `skill-library.json` you're asked which you mean; scripts and agents pass `-p` or `-g`. |
| `find [query]` | Search [skills.sh](https://skills.sh). |
| `update` / `check` | Pull newer versions from each skill's source / report them. |
| `query "<task>"` | Find the skills for a task. Prints the `SKILL.md` paths to read. Built-in skills ship with skill-library and come back like any other; today that's `find-skills`, which searches skills.sh for new skills. They can't be removed or updated on their own. |
| `install` | Restore a project's skills from `skill-library.json`, at the pinned versions. |
| `self setup` | Install or update skill-library (`npm i -g`) and install the gateway skill into your agents, after checking the machine first. Re-run it any time. `-a <agents>` for only some agents. |
| `self update` | Update skill-library (`npm i -g`) and refresh the gateway skill in the agents that already have it. |
| `self doctor` | Check that everything skill-library needs is in place (installed and on `PATH`, newest release, gateway skill, API key, `git`). Changes nothing; exit 1 when something needs fixing. `--json` for scripts. |
| `use <source>@<skill>` | Print a prompt for one skill without adding it (`| claude`), or start an agent with `-a`. |
| `init [name]` | Create a new `SKILL.md`. `--always` makes every query return it, without scoring. |
| `sync init <git-url>` | Keep your global skills in a git repository (any host) and sync them across machines automatically. `sync update` / `sync disable` / `sync enable` / `sync status`. |

`skill-library --help` lists every command; `skill-library <command> --help` (or `skill-library help <command>`) shows that command's options. Details: [CLI spec](docs/02-cli-spec.md).

## Sync across machines

```sh
skill-library sync init git@github.com:me/my-skills.git
```

Run this once on each machine, with any git repository you can push to. From
then on, adding, removing or updating a global skill pushes the change,
and every machine pulls new and updated skills by itself, at most once an hour
when your agent queries the library. `skill-library sync status` shows the last
sync.

## Programmatic API

```ts
import { add, list, query } from "skill-library";

await add("anthropics/skills", { skills: ["frontend-design"], global: true });
const { matches } = await query("design a landing page", { agent: "claude-code" });
```

The API never prints, prompts, or touches agent folders.

## FAQ

### My agent doesn't use the library

Run `skill-library self doctor`, fix anything it reports, then restart the agent. Check that
`skill-library` is on the `PATH` of the environment that starts the agent.

### `skill-library: command not found`

Install it with `npx skill-library self setup` and make sure npm's global bin
directory is on the agent's `PATH`.

### `Missing SKILL_LIBRARY_TYPESAFE_API_KEY` or HTTP 401

`query` needs a valid TypeSafe key in the environment that starts the agent,
not only in your terminal. Create one in the [TypeSafe console](https://console.typesafe.ai/keys) and add the `export` to your shell profile.
`skill-library self doctor` tells you whether the key is set.

### Connection error or timeout

`query` couldn't reach `api.typesafe.ai`. Check network access, DNS, proxy
settings and your agent's sandbox restrictions.

### `N project skills are not installed`

The project's `skill-library.json` lists skills this machine doesn't have yet.
Run `skill-library install` in the project.

### Does it work offline?

Only `query` needs the network. Without it, `skill-library list` and
`skill-library list -g` show every skill and its path. The gateway skill
only knows `query`: when that fails, the agent tells you why and carries on
without skills.
