// ESLint flat config. The library is browser ES modules with no build step: a cross-file
// reference is an import, so no-undef runs with browser globals only and nothing is declared
// global. Tests, the stub hub, the demo harness and the tooling scripts are Node.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "playwright-report/**", "test-results/**"] },
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
    files: ["tests/**/*.js", "tests/**/*.mjs", "e2e/**/*.js", "tools/**/*.mjs", "*.js", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { "no-undef": "error", "no-unused-vars": "warn" },
  },
];
