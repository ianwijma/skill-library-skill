// typescript-eslint parses through the TypeScript compiler API, which TypeScript 7 (the
// native port this repository type-checks with) no longer ships. Inside the ESLint process
// only, resolve `typescript` to the TypeScript 6 API from @typescript/typescript6, so
// linting keeps working while `tsc` stays on TypeScript 7.
//
// Import this module from eslint.config.mjs before anything that loads typescript-eslint.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "typescript" || specifier.startsWith("typescript/")) {
      return nextResolve(`@typescript/typescript6${specifier.slice("typescript".length)}`, context);
    }

    return nextResolve(specifier, context);
  },
});
