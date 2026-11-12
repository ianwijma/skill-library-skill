# Contributing

## Development

Working on the repository needs Node.js >= 22.18: `npm start` runs the TypeScript
source directly, and vitest needs 22.12+. The published package itself runs on any
Node.js 22 or newer; CI tests it on 22.0.0 and the latest 24 and 26.

```sh
npm install
npm test            # vitest (builds the bundle first)
npm run test:e2e        # end-to-end suite, no network (see below)
npm run test:e2e:live   # live end-to-end suite: real GitHub, skills.sh, TypeSafe
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (npm run lint:fix applies the autofixes)
npm run build       # dist/skill-library (CLI), dist/index.js + dist/api.d.ts (API)
```

Design notes and specs are in [docs/](docs/).

### Linting

`npm run lint` runs ESLint ([eslint.config.mjs](eslint.config.mjs)) over the source,
tests, scripts and config files, with type information from `tsconfig.json`. It
uses typescript-eslint's `strictTypeChecked` and `stylisticTypeChecked` presets, the
`@stylistic` formatting rules, and some rules of our own:

- **No single-character names** (`id-length`, min 2). Write `index`, `entry`,
  `skill`, `left`/`right`, not `i`, `e`, `s`, `a`/`b`. `_` is allowed for a
  binding that is deliberately unused. Object keys count too.
- **Room around the code**:
  - `padding-line-between-statements` requires a blank line before every `return`,
    after a block of declarations, around `if`/`for`/`while`/`switch`/`try` and
    other blocks, after the imports, and between top-level functions and exports.
  - `curly: all` puts every `if`/`for` body in braces on its own line.
  - Statements go one per line, lines are at most 120 characters (long strings
    and template literals are exempt), and there is never more than one blank line
    in a row.
- **Correctness**: no floating or misused promises, `===` everywhere except
  `== null`, no shadowing, and no unused variables. Prefix a name with `_` to mark
  it as deliberately unused.

Some preset rules are turned off on purpose:
- `no-non-null-assertion`: `noUncheckedIndexedAccess` makes `!` the normal way
  to read regex groups and known keys.
- `require-await`: many functions are async to fit an interface.
- In `test/` only, the `no-unsafe-*` / `no-explicit-any` family, because tests
  `JSON.parse` CLI output freely.

Disable a rule only on the line that needs it, and always give the reason:
`// eslint-disable-next-line <rule> -- <reason>`.

typescript-eslint still needs the TypeScript 6 compiler API, which TypeScript 7
(our `tsc`) no longer ships. [scripts/eslint-typescript6.mjs](scripts/eslint-typescript6.mjs)
points `typescript` at `@typescript/typescript6`, only inside the ESLint process.
The `overrides` in `package.json` make npm accept TypeScript 7 for typescript-eslint's
`typescript` peer dependency, which still says `<6.1`.

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
want: `<command> --help` shows only that command's usage and options.

Arguments go to vitest (`npm run test:e2e -- sync` runs `sync.e2e.ts`).
`E2E_NODE_VERSION=24` picks the container's Node line (default 22).

#### Live suite

`npm run test:e2e:live` is a separate suite (`test/e2e/live.e2e.ts`) in its own
container, the only one with a network. It adds skills from real GitHub and
searches the real skills.sh. With `SKILL_LIBRARY_TYPESAFE_API_KEY` set, it also
checks that the real TypeSafe API returns the right skills (and never the unrelated
one) for the README's `pdf`, `xlsx` and `frontend-design` examples. Without the key
it warns and skips that test. It only reads; the key is the only credential passed
in. CI runs it in the `e2e-live` job with the repository secret
`SKILL_LIBRARY_TYPESAFE_API_KEY`. That job is `continue-on-error`: a failure is
reported but never blocks a merge.

## Pull requests

Open pull requests against `develop`. CI runs the lint, the tests, the
end-to-end tests, the typecheck and the build on every pull request.

## Releasing

See [RELEASE_GUIDE.md](RELEASE_GUIDE.md).
