# 03 — Data store

## Layout

```
~/.local/share/skill-library/          # or $SKILL_LIBRARY_DIR / --store
  index.json
  index.lock                           # only while writing
  skills/
    react-best-practices-3f9c1a2e/     # <safe-slug(name)>-<first 8 hex of sha256(id)>
      3f2a9c1d07e4/                    # git version: first 12 hex of the commit
      8e01b7a4c2f9/
    my-notes-a1b2c3d4/
      h-5d41402abc4b/                  # local version: "h-" + first 12 hex of the content hash
```

A version folder is written once and never modified, except by
`install --force` repairing a folder whose content no longer matches its hash.
Old versions are kept (the store can't know which projects pin them);
`remove -g` deletes a skill with all its versions.

## Ids

| Source | Id |
|---|---|
| GitHub (any transport) | `repo://github.com/<owner>/<repo>/<skill-name>` (lower-cased) |
| Other git host | `repo://<host>/<repo-path>/<skill-name>` |
| Folder inside the project (project scope only) | `local://<path-from-project-root>` |
| Folder under `$HOME` | `home://<path-from-home>` |
| Anything else | `path://<absolute-path>` |

For folder sources the id is the discovered skill folder, not the path given to
`add`. Two folders in one source declaring the same name are refused.

## `index.json`

```jsonc
{
  "version": 1,
  "skills": [{
    "id": "repo://github.com/vercel-labs/agent-skills/react-best-practices",
    "source": { "type": "git", "url": "https://github.com/vercel-labs/agent-skills.git",
                "ref": null, "path": "skills/react-best-practices" },  // global follow target
    "dir": "skills/react-best-practices-3f9c1a2e",
    "versions": {
      "3f2a9c1d07e4": { "commit": "3f2a…", "tree": "9b1c…", "hash": "sha256-…",
                        "name": "react-best-practices", "description": "…", "addedAt": "…" }
    },
    "current": "3f2a9c1d07e4",
    "global": true,
    "agents": "all",
    "addedAt": "…", "updatedAt": "…"
  }]
}
```

Name and description are per version, so a project pinned to an old version is
scored on that version's description. `agents` here is global usage only.

## `skill-library.json` (project, committed)

```jsonc
{
  "version": 1,
  "skills": {
    "repo://github.com/vercel-labs/agent-skills/react-best-practices": {
      "source": "https://github.com/vercel-labs/agent-skills.git",
      "ref": null, "path": "skills/react-best-practices",
      "commit": "3f2a…", "hash": "sha256-…", "agents": ["claude-code"]
    },
    "local://skills/foo": { "agents": "all" },
    "home://my-skills/bar": { "source": "~/my-skills/bar", "hash": "sha256-…", "agents": "all" }
  }
}
```

Keys sorted, 2-space JSON, trailing newline. `local://` entries are read in
place from the checkout.

## Content hash

Walk the skill folder (skip `.git`, `node_modules`, `__pycache__`, `.DS_Store`;
regular files only); relative POSIX paths, UTF-8, sorted by byte value; per file
feed `uint64-BE(len(path)) ‖ path ‖ uint64-BE(len(content)) ‖ content` into one
SHA-256; written as `sha256-<hex>`. Git commands run with `core.autocrlf=false`.

## Writes

Network work (clone, discovery, hashing) happens before the lock. Then
`index.lock` is taken with `O_EXCL` (holds `pid@host`; a dead local holder is
reclaimed, a foreign one is reported with exit 2), `index.json` is re-read, the
staged folder is renamed into place, and `index.json` / `skill-library.json` are
written to a temp file and renamed.

