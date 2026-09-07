// eslint.config.js — backend (server/src, scripts/), Node CommonJS.
//
// TASK 1: same philosophy as the frontend config — LIGHT, correctness-only.
// no-floating-promises/no-misused-promises need real type info even here;
// tsconfig.eslint.json (allowJs: true, checkJs: false) lets the TypeScript
// program include these plain .js files purely so its checker can infer
// types for them — checkJs stays off so TS itself never emits JS-authoring
// diagnostics (that's not this task), only typescript-eslint's own rules
// consume the type info the program produces.

"use strict";

const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const nodePlugin = require("eslint-plugin-n");
const globals = require("globals");

module.exports = tseslint.config(
  {
    ignores: ["node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["*.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/**/*.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: globals.node,
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      n: nodePlugin,
    },
    rules: {
      // The bugs this session actually hit, live: an unawaited Mongoose
      // write/queue call whose rejection went nowhere (see this session's
      // own lazy-queue-getter fix and the ledger/fencing test fixes for
      // concrete examples of exactly this failure shape).
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-unused-vars": "off", // superseded by the TS-aware version above

      "no-var": "error",
      "prefer-const": "warn",
      eqeqeq: ["error", "smart"],
      "no-async-promise-executor": "error",
      // NOTE: "warn", not "error" — audited all 28 first-run hits by hand
      // (module-level `_cached*` token/tree-id memoization in
      // ebay.api.service.js/ebay.catalog.service.js, domain.service.js's
      // hostnameCache, req.*/refund.*/order.*/domain.*/record.* mutation in
      // auth.js/tenant.js/refund.service.js/stripe.payment.service.js/
      // inventory.service.js, the chunk/flush accumulator in
      // sync.service.js/refresh.service.js, process.exitCode in the
      // one-shot registerGoogleGcp.js script, and a test's own mock-spy
      // flag). Every one is either (a) a per-invocation-local object
      // (Express req, a fetched Mongoose doc, a function-local closure
      // var) with no actual concurrent access to race against, or (b) a
      // TTL memoization cache where a concurrent miss just means a
      // harmless duplicate re-fetch of equally-valid data, already
      // documented as an accepted trade-off (see domain.service.js's own
      // comment on hostnameCache). This codebase's real concurrency-
      // sensitive writes (stock, refunds, payments) already go through
      // DB-level atomic ops (findOneAndUpdate CAS/retry, optimistic
      // locking) specifically because in-memory state isn't trusted for
      // that — which is exactly why none of these 28 turned out to be
      // real. Kept at "warn" rather than off: a genuine module-level
      // shared-state race introduced later would still surface.
      "require-atomic-updates": "warn",
      "no-return-await": "off",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],

      // NOTE: no-redeclare's builtinGlobals check off — this codebase
      // routinely does `const crypto = require("node:crypto")` /
      // `const Location = require("../models/Location")` at module scope,
      // both of which happen to share a name with a Node/TS-lib global
      // (crypto is a real Node global since v19; "Location" only showed up
      // as a phantom conflict before "lib": ["ES2022"] was added to
      // tsconfig.eslint.json — TS defaults to including DOM lib types
      // otherwise). A local const shadowing a platform global by explicit,
      // intentional `require` is not the bug this rule exists to catch;
      // an actual duplicate declaration within the same scope still is,
      // and that stays caught.
      "no-redeclare": ["error", { builtinGlobals: false }],

      // eslint-plugin-n: Node-specific correctness (unresolved requires,
      // wrong-Node-version APIs, missing package.json deps) — not style.
      "n/no-missing-require": "error",
      "n/no-extraneous-require": "error",
      "n/no-unpublished-require": "off", // scripts/ and dev tooling routinely require devDependencies
      "n/no-process-exit": "off", // used deliberately in scripts/ and worker bootstraps
    },
  },
  {
    // Suite uses Node's built-in test runner (`node --test`), not Mocha —
    // `test`/`describe`/`it` etc. come from each file's own
    // `require("node:test")`, not ambient globals (no globals.mocha here:
    // mocha's `test` global would collide with, and false-flag, every
    // file's own `const test = require("node:test")`).
    files: ["**/*.test.js"],
    rules: {
      // NOTE: every hit here (150+/153 total floating-promises hits) is the
      // same non-bug shape: a top-level `test("...", async (t) => {...})`
      // (or `t.test(...)`) call whose returned Promise node:test itself
      // manages — not awaiting it is required, standard usage, not a
      // missed await. Verified by column: every hit lands at column 1 on a
      // bare top-level statement, none nested inside a function body where
      // a real missed-await would show up. Kept at "warn" rather than
      // "off" so a genuinely different floating promise inside a test
      // body would still surface.
      "@typescript-eslint/no-floating-promises": "warn",
      // Test fixtures intentionally construct throwaway mocks/promises that
      // don't always need every misuse-shape check the app code does.
      "@typescript-eslint/no-misused-promises": "warn",
    },
  },
);
