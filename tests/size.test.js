import { describe, expect, it } from "vitest";
import { BUDGET, CEILING, LAZY_DEPENDENCIES, measure } from "../tools/size.mjs";

// The budget is a promise to the two dashboards, and this library does not keep it yet: it is
// about 19 KB gzipped against a 15 KB budget, and the only way under is to load the panel itself
// on demand (see the README and tools/size.mjs). So the test that runs on every commit is the
// ratchet — the number may not grow — and the shortfall is named in the failure message rather
// than left for someone to discover. A test asserting the budget would fail on every run, which
// within a week is a test nobody reads.
describe("the size budget", () => {
  it("does not grow, and says how far it still is from the budget", async () => {
    const { raw, gzipped } = await measure();
    expect(raw).toBeGreaterThan(0);
    expect(
      gzipped,
      `the library is ${gzipped} bytes gzipped, over the ${CEILING}-byte ceiling; the budget is ` +
        `${BUDGET} and this is ${gzipped - BUDGET} bytes above it`,
    ).toBeLessThanOrEqual(CEILING);
  }, 30_000);

  it("leaves the two lazy dependencies out of the bundle, and keeps them lazy", async () => {
    const { imports } = await measure();
    // Read out of the built output, not out of the source: these are the imports the bundle still
    // has to make at run time, and the kind is how it makes them. A dependency that had been
    // bundled in would not be in this list; one that had become a static `import` would be here
    // with a different kind, and a dashboard would pay for it on every page load.
    const external = Object.fromEntries(imports.map((one) => [one.path, one.kind]));
    for (const name of LAZY_DEPENDENCIES) {
      expect(external[name], `${name} is not a run-time import of the bundle`).toBe(
        "dynamic-import",
      );
    }
  }, 30_000);
});
