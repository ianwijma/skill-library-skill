# AGENTS.md

This repository is a [Skill Library](https://github.com/ianwijma/skill-library-skill)
sync repo. It holds its owner's agent skills, and every machine that runs
`skill-library sync` gets them. Agents load them on demand through
`skill-library query`. Work here is usually **creating or improving skills**.

## Layout

```
README.md            # what this repo is (from skill-library)
AGENTS.md            # this file
skill-library.json   # skills from other git repos (pinned); written by skill-library
skills/
  <name>/SKILL.md    # the owner's own skills: one folder per skill
```

- Don't edit `skill-library.json` by hand. Use `skill-library add -g <source>`
  and `skill-library remove -g <name>`, which keep its pins and hashes right.
- Each folder under `skills/` is one skill. Its folder name and its `name` must
  match, and every machine gets every file in it.

## Creating or changing a skill

Before you write or edit a skill, run:

```sh
skill-library query -a <your-agent-id> "create or improve an agent skill"
```

Then read the `create-skills` `SKILL.md` it prints and follow it. It covers
checking for an existing skill, test prompts and a baseline, drafting,
validating, testing that `skill-library query` finds the skill, and publishing.

The rules every skill here must follow:

- `name`: lowercase `a-z`, `0-9` and `-`, 1–64 characters, no leading,
  trailing or double hyphen, and equal to the folder name.
- `description`: at most 1024 characters, third person. It says what the skill
  does and when to use it, in the words a task would contain. Query ranks skills
  on this text alone, so give it the most care. Don't summarise the steps in it.
- The frontmatter is YAML: quote a value that contains `: ` or ` #`, or a skill
  silently drops out of every query.
- The body adds only what an agent doesn't already know: the owner's
  conventions, exact commands, pitfalls. Keep it under about 500 lines, and put
  detail in `references/` (one level deep) and deterministic steps in
  `scripts/`.
- No secrets, tokens or personal data. Everything here syncs to every machine.
- Improve an existing skill rather than adding one that overlaps it. Overlapping
  descriptions compete in the ranking.

## Testing before it syncs

Commits here reach every machine on their next sync, so test the skill in a
scratch library first:

```sh
scratch="$(mktemp -d)"
skill-library --store "$scratch" add ./skills/<name> -g -y
skill-library --store "$scratch" query -a <your-agent-id> "<a realistic task>"
```

The skill should come back for the tasks it is for and stay out of neighbouring
ones.

## Publishing

- **This is the sync clone** (the `Clone:` path in `skill-library sync status`):
  run `skill-library sync`. It commits your edits, pulls, pushes and installs
  them on this machine.
- **This is a separate checkout**: commit, push, then run `skill-library sync`
  to install the change here now. Other machines pick it up on their own.

Use one commit per skill, with messages such as `feat(<name>): …` or
`fix(<name>): …`. Ask the owner before pushing a new skill or a large rewrite.
