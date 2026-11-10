# Contributing

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

Design notes and specs are in [docs/](docs/).

## Pull requests

Open pull requests against `develop`. CI runs the tests, the typecheck and the
build on every pull request.

## Releasing

See [RELEASE_GUIDE.md](RELEASE_GUIDE.md).
