# 09 — Syncing global skills with a git repo

Status: **implemented** (`src/core/sync.ts`, `src/cli/sync.ts`). This reopens D14 of
[08](08-vercel-parity-plan.md) ("`sync` is dropped"), but only for global skills.

## Idea

Your global skills live in one git repository on any host (GitHub, GitLab,
Bitbucket, Gitea, a self-hosted server). Every machine keeps a clone of it.
`skill-library sync` pulls, installs, updates and pushes. It also runs on its
own in the background, so after setup you never have to type it.

## Setup (once per machine)

`init` takes the full clone URL, HTTPS or SSH, so any host works:

```sh
skill-library sync init git@bitbucket.org:me/my-skills.git
skill-library sync init https://github.com/me/my-skills.git
skill-library sync init ssh://git@git.example.com:2222/me/my-skills.git
```

`init` does the following:

- Uses the URL exactly as given; there is no shorthand expansion.
- Clones the repo to `<library>/sync`. The library is
  `~/.local/share/skill-library` by default, or `$SKILL_LIBRARY_DIR`.
- Writes `<library>/sync.json` (`url`, `enabled`, and the ids the repo
  manages).
- Installs the repo's skills and places the gateway.
- If the repo is empty, first commits this machine's global git skills into it
  as manifest entries. Global skills from a local folder are listed, and you
  pick the ones to share (they are copied into `skills/`). The rest stay
  machine-only. Without a terminal none are shared, unless you pass
  `--share <names>` (`--share '*'` = all).
- Gives the repo a short `README.md` about Skill Library (template:
  [`assets/sync-readme.md`](../assets/sync-readme.md)) when it has no README.
  When it already has a Markdown README, `init` asks before adding the Skill
  Library section to it, or before refreshing that section if it is out of date.
  The section sits between `<!-- skill-library:start -->` and
  `<!-- skill-library:end -->`; the rest of the README is never touched.
  `--readme` says yes without asking, `--no-readme` says no. Without a terminal
  the README is left as it is. A non-Markdown README (`README.rst`, …) is always
  left alone. The README's link to Skill Library carries `utm_*` parameters
  naming the sync repo (`owner/repo`; no credentials, nothing for a local path).

If `sync` is already set up with the same URL, `init` says so and exits
successfully without changing anything. With a different URL it refuses and
points to `sync update`.

## Moving to another repository

```sh
skill-library sync update git@github.com:me/my-skills.git
```

`sync update` does the following:

- Commits local edits and pulls from the old repository, so nothing is left
  behind. If the old repository can't be reached (deleted, host gone), it says
  so and moves this machine's clone as it is.
- Points the clone at the new URL and pushes everything there: the full
  history, `skill-library.json` and `skills/`.
- Refuses a new repository that already holds unrelated history, and keeps the
  old URL. An empty repository or a copy or mirror of the old one works.
- Your own skills (`skills/` folders) get ids under the new repository. Their
  old records are dropped, so `list` shows each skill once.
- Writes the new URL to `sync.json` and runs a normal sync.

With the URL already in use, it says so and changes nothing. Sync must be
enabled. Run `sync update` with the same URL on each of your other machines.
Until you do, they keep syncing with the old repository.

## Three kinds of global skill

A skill is synced only when it has a source of truth it can be updated from.

| Kind | Example | Synced | Source of truth |
|---|---|---|---|
| **Remote** | `typesafe-ai` from `typesafe-ai/skills` | yes, as a manifest entry | its upstream git repo |
| **Own** | a skill you wrote | yes, as a folder under `skills/` | your sync repo |
| **Machine-only** | a skill you are trying out | no | a folder on this machine |

The CLI can't tell a skill you wrote from a copy of someone else's: both are a
folder with a `SKILL.md`. So a folder skill becomes **own** only when you say so:

- `add -g <folder>` asks "Share across your devices?" (default yes). `--share` /
  `--no-share` answer it up front. With `-y` or inside an agent, the answer is
  no unless `--share` is passed, so an agent never publishes a copy as yours.
- `skill-library sync share <name...>` shares a machine-only skill later.
- Once shared, the repo is its source of truth: the original folder is no
  longer read. The CLI prints where to edit it (`<library>/sync/skills/<name>`).
  Re-sharing the same folder (`add -g <folder> --share`) updates it.

Copies of other people's skills are better added from their git repo: they
then become remote skills and keep getting updates. You can also keep your own
skills in a separate git repo and add that like any remote; that suits a real
workflow (history, reviews per skill) better than editing in the sync repo.

### Same name, different source

- `add -g` of a skill whose name another global skill already uses offers to
  **replace** it, and says whether the files differ. `-y` replaces. The old
  skill is kept in the store, just not global (`list -g` shows it as not
  global). Replacing an own or remote skill removes it from the repo.
- `query` sends one skill per name to the model: remote beats own beats
  machine-only.
- When a sync (often a background one) brings in a skill whose name another
  global skill already uses, nothing is replaced: it is reported (`sync`
  output, and the next `query` tells the agent) so the user can pick.

## The repo

```
my-skills/
  README.md                  # what this repo is (added by `sync init`, see above)
  skill-library.json         # skills from other repos: source + ref + path + pinned commit + hash + agents
  skills/
    my-checklist/SKILL.md    # your own skills, stored in the repo itself
```

- **`skill-library.json`** uses the project manifest format. Only `repo://`
  entries are synced; other entries are ignored with a warning.
- **Folders under `skills/`** become global skills with a
  `repo://<host>/<repo>/<name>` id, at the clone's commit. They are for every
  agent.

## `skill-library sync`

1. Commit any edits made directly in the clone.
2. Pull. On divergence it rebases. If the rebase conflicts, the remote is
   taken and the local changes are reapplied on top:
   - `skill-library.json` is merged per skill id. When both sides changed the
     same skill, the remote wins.
   - Changed `skills/` folders are taken from the local side.
3. Make the store match the repo:
   - Install every manifest entry at its pinned commit and verify its hash.
   - Copy each `skills/` folder into the store.
   - Mark all of these global.
   - A skill the repo managed at the previous sync, but no longer contains,
     stops being global.
4. Update every manifest skill to the newest commit of its source, then write
   the new pins back into `skill-library.json`.
5. Commit and push. A rejected push pulls once and retries.

Steps 4 and 5 are why every machine ends up on the latest version: whichever
machine syncs first bumps the pins, and the others just pull them.

While sync is enabled, the regular commands write to the repo:

| Command | Effect on the repo |
|---|---|
| `add -g` (git source) | Adds a manifest entry. |
| `add -g` (local folder) | Only when shared: copies the folder into `skills/`, and the skill then lives in the repo under its repo id. Otherwise nothing (machine-only). |
| `sync share <name>` | Copies a machine-only skill into `skills/`. |
| `remove -g` | Deletes the entry, or the `skills/` folder for an own skill. |
| `update -g` | Writes the new pins. |

Each of these pulls first, then commits and pushes. A failed pull or push is
reported in one line, and the local commit is pushed on the next sync. Skills
the pull adds or drops (changes from other machines) are listed on stderr as
`+ name (from <url>)` and `- name (dropped by <url>)`.

## Disable and enable

Turn sync off while testing, so nothing gets pulled or pushed:

```sh
skill-library sync disable
skill-library sync enable
skill-library sync status    # repo URL, enabled/disabled, clone, last sync, unpushed commits, last error
```

The clone and the URL are kept, so `enable` doesn't need the URL again.

While sync is disabled:

- `query` doesn't start background syncs.
- `add -g`, `remove -g` and `update -g` change only the local library. They
  don't touch the repo.
- A manual `skill-library sync` refuses with: `sync is disabled — run
  skill-library sync enable`.

`enable` turns sync back on and runs one sync right away. Skills you added
while sync was disabled stay local: they aren't pushed and they aren't removed,
because sync only drops skills that came from the repo. To share a folder
skill, run `sync share <name>`; for a git skill, run `add -g` again.

## Automatic

`skill-library query` runs constantly, because the gateway calls it. If the last
sync attempt is older than `SKILL_LIBRARY_SYNC_TTL` seconds (default 3600),
`query` starts `skill-library sync --background` as a detached process. It
never waits for the sync and never fails because of it.

- Works on macOS, Linux and Windows, with no cron jobs or daemons.
- A background run that finds another sync running exits quietly.
- Results and errors go to `<library>/sync-status.json`, and
  `skill-library sync status` shows them. When the previous background sync
  failed, the next `query` that starts one prints one line on stderr.
- Nobody sees a background run's output, so its added, removed and updated
  skills are kept in `sync-status.json` (`unreported`). The next successful
  `query` prints them under `Sync changed your global skills — tell the user:`
  (`syncChanges` with `--json`) and clears them. The gateway tells the agent to
  pass this on to the user.

## Edge cases

- **Auth:** whatever already works with plain `git` for that URL on the
  machine: an SSH key, or HTTPS with a credential helper (for example Bitbucket
  app passwords, `gh auth setup-git`). `GITHUB_TOKEN` is only used for
  github.com.
- **No prompts:** git never prompts. Background runs also set
  `ssh -o BatchMode=yes`, so a sync fails instead of hanging.
- **Commit identity:** a machine without `user.name` / `user.email` commits as
  `skill-library <skill-library@localhost>`.
- **Secrets:** the TypeSafe key is never written to the repo.
- **API:** sync is CLI-only for now; it is not part of the programmatic API.
