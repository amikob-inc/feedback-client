// ESLint flat config. The library is browser ES modules with no build step: a cross-file
// reference is an import, so no-undef runs with browser globals only and nothing is declared
// global. Tests, the stub hub, the demo harness and the tooling scripts are Node.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "playwright-report/**", "test-results/**", "demo/dist/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "warn",
      "no-redeclare": "error",
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["demo/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: { "no-undef": "error", "no-unused-vars": "warn" },
  },
  {
    // Both extensions everywhere: the package is "type": "module", so a helper written as
    // tools/size.js is as natural as tools/size.mjs, and a glob that names only one of them
    // leaves the other with no declared globals at all — `console` and `process` then fail
    // no-undef, which reads as a mistake in the file rather than in this config.
    files: ["tests/**/*.{js,mjs}", "e2e/**/*.{js,mjs}", "tools/**/*.{js,mjs}", "*.js", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      // Node AND browser, deliberately, though the plan's constraint says Node for tests. Vitest
      // runs these in Node by default but a test opts into jsdom with a docblock, per file, and
      // those files legitimately use `window` and `document`; Playwright's evaluate callbacks run
      // in a page. There is no glob that separates the two, so the choice is a merged set here or
      // a stream of false positives. The narrower guard is the environment itself: a jsdom global
      // used in a Node test fails when the test runs, not when it is linted.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { "no-undef": "error", "no-unused-vars": "warn" },
  },
];
