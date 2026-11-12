# Contributing

## Development

Working on the repository needs Node.js >= 22.18: `npm start` runs the TypeScript
source directly, and vitest needs 22.12+. The published package itself runs on any
Node.js 22 or newer; CI tests it on 22.0.0 and the latest 24 and 26.

```sh
npm install
npm test            # vitest (builds the bundle first)
npm run test:e2e    # end-to-end suite (see below)
npm run typecheck   # tsc --noEmit
npm run build       # dist/skill-library (CLI), dist/index.js + dist/api.d.ts (API)
```

Design notes and specs are in [docs/](docs/).

### End-to-end tests

`npm run test:e2e` tests the product the way a user gets it: it builds the package,
packs it with `npm pack`, installs the tarball with `npm i -g` into a private
prefix, and runs that installed `skill-library` for every command, subcommand and
option (`test/e2e/*.e2e.ts`).

It always runs in a throwaway Docker container (`test/e2e/Dockerfile`, started by
`scripts/e2e.mjs`), so it never affects anything outside the tests. It needs
Docker; the suite refuses to start anywhere else.

- The container gets a copy of the source and nothing else: no home directory,
  agents, npm prefix, git config, SSH keys or tokens from your machine. It runs as
  a regular user, without a network (`--network none`).
- No real repository is ever written to. GitHub sources (`owner/repo`, GitHub URLs,
  `git@github.com:…`) are rewritten by git's `url.insteadOf` to local bare
  repositories, sync uses a local bare repository as its remote, and git can't push
  to any remote host.
- The TypeSafe API, skills.sh and the npm registry are small local servers
  (`test/e2e/fakes.ts`). `self setup` and `self update` run the real `npm`, which
  installs the packed tarball (and a repacked `99.0.0`) from the fake registry.
- Each test also gets its own sandboxed `HOME` inside the container.
- After each step, the validators in `test/e2e/validate.ts` check what the CLI left
  on disk: every version folder hashes to its recorded hash (the hash is
  re-implemented there from the spec), `skill-library.json` follows the format and
  matches the library, no lock or staging files remain, the gateway is the packaged
  one, and the sync clone matches its remote.

The suite tests behaviour, not a particular argument parser. Usage errors (a missing
value, an unknown command or option, a stray argument) are checked through
`test/e2e/contract.ts`: a non-zero exit and a message that names the option, never
the exact wording or output stream. `test/e2e/help.e2e.ts` describes the help we
want: `<command> --help` shows only that command's usage and options. Commands that
don't have their own help yet are marked `test.fails` there (an expected failure).
When one gets it, vitest reports the unexpected pass; move the command into
`HAS_OWN_HELP` then.

Arguments go to vitest (`npm run test:e2e -- sync` runs `sync.e2e.ts`).
`E2E_NODE_VERSION=24` picks the container's Node line (default 22). `E2E_LIVE=1`
gives the container a network for `test/e2e/live.e2e.ts`. It adds skills from
real GitHub and searches the real skills.sh. When `SKILL_LIBRARY_TYPESAFE_API_KEY`
is set, it also checks that the real TypeSafe API ranks the right skill first for a
few tasks. It only reads. CI runs it in the `e2e-live` job with the repository
secret `SKILL_LIBRARY_TYPESAFE_API_KEY`.

## Pull requests

Open pull requests against `develop`. CI runs the tests, the end-to-end
tests, the typecheck and the build on every pull request.

## Releasing

See [RELEASE_GUIDE.md](RELEASE_GUIDE.md).
