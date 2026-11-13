// ESLint flat config. The rule choices are explained in CONTRIBUTING.md ("Linting").
import "./scripts/eslint-typescript6.mjs";

import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "third_party/**", "skills/**"],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  stylistic.configs.customize({
    indent: 2,
    quotes: "double",
    semi: true,
    braceStyle: "1tbs",
    commaDangle: "always-multiline",
    arrowParens: true,
    quoteProps: "as-needed",
  }),

  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
      parserOptions: {
        projectService: {
          // Outside tsconfig.json's include; .mjs files are linted without type information (below).
          allowDefaultProject: ["vitest.config.ts", "vitest.e2e.config.ts"],
          defaultProject: "tsconfig.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // Correctness
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-unreachable-loop": "error",
      "array-callback-return": "error",
      "@typescript-eslint/no-shadow": "error",
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(fs|path|os|child_process|crypto|url|util|stream|events|http|https|net|module)(/.*)?$",
              message: "Import Node built-ins with the node: prefix.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true, boolean: true }, ignoreConditionalTests: true },
      ],

      // TypeScript
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/consistent-type-exports": ["error", { fixMixedExportsWithInlineTypeSpecifier: true }],
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      // Required by noUncheckedIndexedAccess for regex groups and known keys.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNullish: false },
      ],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      // Many async functions are async to satisfy an interface (agent adapters, prompt hooks).
      "@typescript-eslint/require-await": "off",
      // `.catch(() => {})` is the deliberate "ignore cleanup failures" idiom.
      "@typescript-eslint/no-empty-function": ["error", { allow: ["arrowFunctions"] }],
      "@typescript-eslint/prefer-regexp-exec": "off",
      "@typescript-eslint/no-dynamic-delete": "off",

      // Naming: no single-character identifiers (`_` marks an intentionally unused binding).
      "id-length": ["error", { min: 2, exceptions: ["_"], properties: "always" }],

      // Layout and spacing
      curly: ["error", "all"],
      // Backticks only for interpolation; build strings with templates, not `+`.
      "@stylistic/quotes": ["error", "double", { avoidEscape: true, allowTemplateLiterals: "never" }],
      "prefer-template": "error",
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: false }],
      "@stylistic/max-len": [
        "error",
        {
          code: 120,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreUrls: true,
          ignoreRegExpLiterals: true,
        },
      ],
      "@stylistic/newline-per-chained-call": ["error", { ignoreChainWithDepth: 3 }],
      // Operators lead continuation lines, but `=` stays at the end so the assignment reads first.
      "@stylistic/operator-linebreak": ["error", "before", { overrides: { "=": "after" } }],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
        { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
        { blankLine: "any", prev: ["const", "let", "var"], next: ["const", "let", "var"] },
        { blankLine: "always", prev: "*", next: ["if", "for", "while", "do", "switch", "try", "block-like"] },
        { blankLine: "always", prev: "block-like", next: "*" },
        { blankLine: "always", prev: "import", next: "*" },
        { blankLine: "any", prev: "import", next: "import" },
        { blankLine: "always", prev: "*", next: ["function", "class", "export"] },
        { blankLine: "any", prev: "export", next: "export" },
        { blankLine: "any", prev: "directive", next: "directive" },
      ],
    },
  },

  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },

  {
    files: ["**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
