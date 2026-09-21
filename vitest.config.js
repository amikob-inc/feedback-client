import { defineConfig } from "vitest/config";

// Node is the default environment on purpose: the buffers, the bundle builder, the status map,
// the transport and the annotator's geometry are pure and must stay testable without a DOM. The
// files that need one opt in with a `@vitest-environment jsdom` docblock of their own.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    restoreMocks: true,
  },
});
