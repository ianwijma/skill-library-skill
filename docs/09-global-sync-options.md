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
- If the repo is empty, first commits this machine's global skills into it.
  Git skills become manifest entries. Folder skills are copied into
  `skills/`.

If `sync` is already set up with the same URL, `init` says so and exits
successfully without changing anything. With a different URL it refuses and
names the files to delete to start over.

## The repo

```
my-skills/
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
| `add -g` (local folder) | Copies the folder into `skills/`. The skill then lives in the repo under its repo id. |
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
because sync only drops skills that came from the repo. To share one, run
`add -g` again after enabling.

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
