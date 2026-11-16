---
name: create-skills
description: The guide for writing agent skills (SKILL.md files). Read it before creating, writing, editing or fixing any skill. Covers drafting, testing and publishing to the user's skill library so every agent on every machine gets it. Use whenever the user asks for a new skill, wants agents taught a convention, workflow or checklist as a skill, wants something from this session turned into a reusable skill, wants an existing skill improved, updated or fixed, or says a skill is not picked up or triggers for the wrong tasks.
---

# Create Skills

A skill is a folder with a `SKILL.md`: YAML frontmatter (`name`, `description`)
and Markdown instructions, plus optional `scripts/`, `references/` and `assets/`.
Agents don't see skills up front. They run `skill-library query "<task>"`, which
ranks every skill on its **description**, and read the `SKILL.md` paths it
prints. So a skill is only as good as its description is findable, and its body
is only worth what it adds beyond what the agent already knows.

Copy this checklist into your working notes and tick it off:

```
- [ ] 1. Check for an existing skill
- [ ] 2. Capture what the skill is for (examples, triggers, success)
- [ ] 3. Write 3+ test prompts and record a baseline without the skill
- [ ] 4. Draft the smallest skill that fixes the baseline
- [ ] 5. Validate the frontmatter and layout
- [ ] 6. Test triggering with skill-library query
- [ ] 7. Test behaviour on the prompts, fix, repeat
- [ ] 8. Publish
```

## 1. Check for an existing skill

```sh
skill-library list -g                      # what the library holds
skill-library query "<the task the skill is for>"
skill-library find <keywords>              # public skills on skills.sh
```

Improve a skill that already covers the job instead of adding a second one with
an overlapping description: two skills that match the same tasks split the
ranking. If a well-maintained public skill fits, offer to add it
(`skill-library add <owner/repo@skill>`) rather than writing a copy.

## 2. Capture what the skill is for

If this session already shows the workflow (the user says "turn this into a
skill"), take the steps, corrections and commands from it first. Then ask only
for what is missing, one or two questions at a time:

- Two or three concrete requests the skill should handle, in the user's words.
- What should *not* use it (neighbouring tasks it must stay out of).
- What a good result looks like, and the mistakes agents make without it.
- Commands, files, URLs or conventions that are specific to the user.

## 3. Test prompts and a baseline

Write at least three realistic prompts, the way the user would type them, with
paths and details. Run each one **without** the skill (a fresh subagent if you
can spawn one, otherwise reason through it honestly) and note what goes wrong:
wrong tool, missed step, wrong format, a convention ignored. That list is what
the skill has to fix. A skill written without a baseline usually explains things
the agent already does well.

## 4. Draft

Start from `skill-library init <name>` or write the folder by hand.

**Frontmatter** (agentskills.io spec):

- `name`: 1–64 characters, lowercase `a-z`, `0-9` and `-`, no leading,
  trailing or double hyphen, and the **same as the folder name**. Avoid vague
  names such as `helper` or `utils`.
- `description`: at most 1024 characters, no XML tags, third person. Say what
  the skill does and **when to use it**, using the words a task would contain:
  tools, file types, commands, error messages, the phrases the user says. Put
  the most distinctive terms first. Don't summarise the steps: an agent that
  reads a summary tends to follow it and skip the body.
- The frontmatter is YAML: a value containing `: ` or ` #`, or starting with a
  quote, `[`, `{`, `*`, `&`, `!`, `|`, `>`, `%` or `@`, must be quoted, or the
  skill fails to parse and silently drops out of every query.
- Optional: `license`, `compatibility` (only for real environment needs),
  `metadata` (string → string). `metadata.always: "true"` makes every query
  return the skill. Keep that for the rare skill that truly applies to every
  task.

**Body**:

- Assume a capable agent. Add what it lacks: the user's conventions, the
  non-obvious step, the pitfall, the exact command. Cut general advice.
- Lead with the workflow as numbered steps, each with a clear "done when".
- Match freedom to fragility: prose for judgment calls, an exact command or a
  script in `scripts/` for steps that must not vary. Say whether to *run* a
  script or *read* it. Scripts handle their own errors and don't assume
  packages are installed.
- Give one default way to do things, plus an escape hatch, not a menu.
- Use one term for each concept, and show a short example of the expected
  output when its format matters.
- Keep `SKILL.md` under about 500 lines. Move detail to `references/<topic>.md`
  and say when to read each file. Keep references one level deep, and give any
  over 100 lines a table of contents.
- Use relative paths with forward slashes. Leave out dates, versions and "new"
  features that will go stale (or keep them in an "Old patterns" section), and
  don't add a README or changelog inside the skill.
- Never put secrets, tokens or personal data in a skill: it syncs to every
  machine and may be shared.

## 5. Validate

Check `name` against the folder name and the rules above, check the description
length (`wc -c` on it), and make sure every file the body mentions exists. The
scratch-library `add` in step 6 also confirms that the frontmatter parses: a
skill that doesn't come back from `query` at all usually has broken YAML. If
`skills-ref` is installed, run `skills-ref validate <folder>`.

## 6. Test triggering

The description decides whether the skill is ever read. Try it in a scratch
library so nothing is published yet:

```sh
scratch="$(mktemp -d)"
skill-library --store "$scratch" add <folder> -g -y
skill-library --store "$scratch" query -a <your-agent-id> "<one of the test prompts>"
```

Every test prompt should return the skill, and two or three neighbouring tasks
from step 2 should not. When one misses, put the words that prompt uses into the
description. When an unrelated task matches, make the description more specific.
Then run the same prompts against the real library (`skill-library query …`
without `--store`) to see how the skill ranks next to the user's other skills.

## 7. Test behaviour

Run the test prompts again with the skill: a fresh subagent told to read the
`SKILL.md` first, or yourself, following only what the file says. Compare with
the baseline. Each failure points to something missing, unclear or buried. Fix
the skill, not the prompt, and repeat until the prompts pass. Then show the user
the result and ask what's off.

## 8. Publish

Ask the user before publishing: shared skills reach all of their machines and
agents.

- **Sync is set up** (`skill-library sync status` shows a repository):
  `skill-library add <folder> -g --share -y` copies the skill into the sync
  repo's `skills/` and pushes it. From then on the repo is its source of truth:
  edit it at the `Clone:` path from `sync status`, under `skills/<name>/`, then
  run `skill-library sync`. When you are working inside the sync repo itself,
  edit `skills/<name>/` in place, commit, push and run `skill-library sync`.
- **No sync**: `skill-library add <folder> -g` adds it to this machine.
  Suggest `skill-library sync init <git-url>` so it reaches the user's other
  machines too.
- **Only for one project**: `skill-library add <folder> -p` pins it in the
  project's `skill-library.json`.

Then run `skill-library query` for one test prompt again to confirm that the
published copy is the one returned.

## Going further

For a heavier loop with eval files, graded runs with and without the skill, a
benchmark and description tuning against about 20 queries, the user can add
Anthropic's skill creator:

```sh
skill-library add anthropics/skills@skill-creator
```
