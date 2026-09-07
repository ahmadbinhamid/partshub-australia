// eslint.config.js — frontend (src/), React + TypeScript.
//
// TASK 1: this repo had no linter at all before this. Deliberately LIGHT —
// correctness rules that would have caught a real bug, not style/formatting
// (no rules about quotes, semicolons, import order, etc. — there is no
// Prettier here either, and this isn't the place to start one).
//
// react-hooks/recommended-latest + no-floating-promises/no-misused-promises
// are the two rules doing the real work: an unawaited async call (a missed
// `await` on a Mongoose write, an unhandled promise rejection from a
// fire-and-forget queue call) is exactly the class of bug this session's
// own work has been full of finding live. no-floating-promises needs real
// type information to know an expression IS a Promise — this project
// already has real TS types (strict: true), so it's cheap to turn on here.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "build/**", "server/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs["recommended-latest"],
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.browser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The bugs this session actually hit: a queue/DB call fired without
      // await, its rejection going nowhere.
      //
      // NOTE: no-floating-promises is "warn", not "error", after auditing
      // all 90 hits from the first real run — 84 of them are
      // `queryClient.invalidateQueries(...)` (or a thin wrapper like
      // `invalidate()`/`refetch()`) inside a mutation's onSuccess, an
      // idiomatic React Query pattern used throughout this codebase, not a
      // bug: the query cache refetching is fire-and-forget by design there.
      // Flipping all 84 call sites to `void invalidateQueries(...)` would be
      // exactly the unreviewable mass-autofix diff this task says not to
      // produce, for a rule that isn't finding new bugs at those sites. Kept
      // at "warn" so it still surfaces in `npm run lint` for new code. The
      // one genuine hit (an unhandled `.then()` with no `.catch()`) was
      // fixed directly — see ListingsPage.tsx.
      "@typescript-eslint/no-floating-promises": "warn",
      // NOTE: checksVoidReturn.attributes disabled — react-hook-form's
      // `<form onSubmit={handleSubmit(onSubmit)}>` passes an async handler
      // where a void-returning JSX attribute is expected; that's the
      // library's own documented pattern (24 of 31 first-run hits), not a
      // bug. The rule stays armed for its other misuse shapes (e.g. a
      // Promise passed where a plain callback/conditional is expected).
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],

      // TS's own noUnusedLocals/noUnusedParameters are OFF in tsconfig.json
      // (deliberately, per that file) — this is the actual unused-vars
      // check for this codebase. `_`-prefixed args/vars are the existing
      // convention for "intentionally unused" (see any catch block that
      // only needs to know an error happened).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-unused-vars": "off", // superseded by the TS-aware version above

      // Real bug shapes, not style — every one of these has caused a
      // production incident in a codebase like this one somewhere.
      "no-var": "error",
      "prefer-const": "warn",
      eqeqeq: ["error", "smart"],
      "no-async-promise-executor": "error",
      "no-return-await": "off", // superseded by @typescript-eslint's version
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/no-explicit-any": "off", // not a correctness rule — this is an incremental-adoption codebase

      // NOTE: allowEmptyCatch — the 2 first-run hits are both in
      // ThemeToggle.tsx, wrapping localStorage.getItem/setItem (which can
      // throw in private-browsing / storage-disabled contexts) with real
      // fallback behaviour already present around them (falls through to
      // matchMedia; still calls applyTheme regardless) — deliberate
      // "best-effort persistence, ignore this one expected failure" code,
      // not an accidentally-swallowed error. Left un-narrowed (not scoped
      // to just those two files) since "silently ignore a storage/DOM API
      // exception" is a legitimate pattern anywhere in this codebase, not
      // specific to theme code.
      "no-empty": ["error", { allowEmptyCatch: true }],

      // react-hooks/recommended-latest already brings rules-of-hooks
      // (error) and exhaustive-deps (warn) — a real, live-bug-shaped
      // category (a stale closure reading old props/state) — left at its
      // own defaults rather than overridden here.
    },
  },
  {
    // Vite/Tailwind/PostCSS config files — Node, not browser, and not part
    // of the app bundle.
    files: ["*.config.{js,ts}"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
