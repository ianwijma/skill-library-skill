---
name: find-skills
description: Helps discover and add new agent skills from the open skills ecosystem (skills.sh) when the user asks "how do I do X", "find a skill for X", "is there a skill that can…", or wants to extend the agent's capabilities in a specialized domain that no installed skill covers.
---

# Find Skills

This built-in skill helps you discover skills from the open agent skills ecosystem
and add them to the user's skill library.

## When to use it

Use it when the user:

- asks "how do I do X" where X is a common task that likely has an existing skill
- says "find a skill for X" or "is there a skill for X"
- asks "can you do X" where X is a specialized capability
- wants to extend what the agent can do, or mentions a domain they wish they had
  help with (design, testing, deployment, …)

## How skills work here

Skills the user adds go into their skill library, not into the agent's context.
They are only loaded when `skill-library query` returns them for a task, so adding a
useful skill costs nothing until it is needed.

- `skill-library find <query> [--owner <owner>]` — search skills.sh by keyword
- `skill-library add <owner/repo@skill>` — add a skill to the library
- `skill-library list` / `skill-library list -g` — what is already in the library

Browse skills at https://skills.sh/

## Steps

### 1. Understand what they need

Identify the domain (React, testing, design, deployment, …), the specific task
(writing tests, reviewing PRs, …), and whether the task is common enough that a
skill likely exists. If the library already has a matching skill
(`skill-library list -g`), use that instead of searching.

### 2. Search

```sh
skill-library find <query>
```

Examples:

- "how do I make my React app faster?" → `skill-library find react performance`
- "can you help me with PR reviews?" → `skill-library find pr review`
- "I need to create a changelog" → `skill-library find changelog`

Each result prints as `<owner/repo>@<skill> <installs>` followed by a skills.sh link.

Search tips: use specific keywords ("react testing" beats "testing"), try
alternative terms ("deploy", "deployment", "ci-cd"), and narrow to a trusted
publisher with `--owner <owner>`.

### 3. Check quality before recommending

Do not recommend a skill on search results alone. Check:

1. **Install count** — prefer skills with 1K+ installs; be cautious under 100.
2. **Source reputation** — well-known publishers (for example `anthropics`,
   `vercel-labs`, `microsoft`) are more trustworthy than unknown authors.
3. **The repository** — open it; a repo with few stars or no recent activity
   deserves skepticism.

Skills are instructions the agent will follow, so treat an unknown one like any
other untrusted code.

### 4. Present the options

For each candidate give the name and what it does, the install count and source,
the command to add it, and its skills.sh link. For example:

```
I found a skill that might help: "frontend-design" from anthropics/skills
gives guidance for building distinctive, production-grade web UI (100K+ installs).

Add it to your skill library:
skill-library add anthropics/skills@frontend-design

Learn more: https://skills.sh/anthropics/skills/frontend-design
```

### 5. Add it when the user agrees

Only add a skill after the user says yes:

```sh
skill-library add <owner/repo@skill> -g -y
```

`-g` adds it to the global library (all projects); use `-p` instead to pin it in
the project's `skill-library.json`. `-y` skips prompts. Then run
`skill-library query` again for the current task and read the skill it returns.

## Common categories

| Category        | Example queries                          |
| --------------- | ---------------------------------------- |
| Web development | react, nextjs, typescript, css, tailwind |
| Testing         | testing, jest, playwright, e2e           |
| DevOps          | deploy, docker, kubernetes, ci-cd        |
| Documentation   | docs, readme, changelog, api-docs        |
| Code quality    | review, lint, refactor, best-practices   |
| Design          | ui, ux, design-system, accessibility     |
| Productivity    | workflow, automation, git                |

## When nothing is found

Say that no existing skill was found, offer to help with the task directly, and,
if it is something the user does often, suggest writing their own skill:

```sh
skill-library init my-skill
skill-library add ./my-skill
```
