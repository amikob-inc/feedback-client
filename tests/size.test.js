import { describe, expect, it } from "vitest";
import { BUDGET, CEILING, LAZY_DEPENDENCIES, PANEL_DIR, measure } from "../tools/size.mjs";

// The budget is a promise to the two dashboards: what they download on every page load for this
// library, gzipped. It is kept by loading the panel on demand — the panel is about half the
// library and only needed once somebody opens it — so the number that matters is the page-load
// set alone (see tools/size.mjs), and the two assertions are the budget itself and the ratchet
// under it that stops the gap closing unnoticed.
describe("the size budget", () => {
  it("keeps the page-load cost under the budget, and under the ceiling", async () => {
    const { raw, gzipped } = await measure();
    expect(raw).toBeGreaterThan(0);
    expect(
      gzipped,
      `the page load is ${gzipped} bytes gzipped against a ${BUDGET}-byte budget`,
    ).toBeLessThanOrEqual(BUDGET);
    expect(
      gzipped,
      `the page load is ${gzipped} bytes gzipped, over the ${CEILING}-byte ceiling: lower it ` +
        `only when the real number drops, raise it only knowingly`,
    ).toBeLessThanOrEqual(CEILING);
    expect(CEILING).toBeLessThanOrEqual(BUDGET);
  }, 30_000);

  it("leaves the two lazy dependencies out of the bundle, and keeps them lazy", async () => {
    const { imports } = await measure();
    // Read out of the built output, not out of the source: these are the imports the page-load
    // set still has to make at run time, and the kind is how it makes them. A dependency that had
    // been bundled in would not be in this list; one that had become a static `import` would be
    // here with a different kind, and a dashboard would pay for it on every page load.
    const external = Object.fromEntries(imports.map((one) => [one.path, one.kind]));
    for (const name of LAZY_DEPENDENCIES) {
      expect(external[name], `${name} is not a run-time import of the bundle`).toBe(
        "dynamic-import",
      );
    }
  }, 30_000);

  it("keeps the panel off the page load: a chunk of its own, reached only by import()", async () => {
    const { imports, pageLoadInputs, chunks } = await measure();
    // One static import of anything under src/panel/ from the capture half would pull the whole
    // panel back onto every page load, and the budget test above might still pass for a while.
    const leaked = pageLoadInputs.filter((one) => one.includes(PANEL_DIR));
    expect(leaked, "panel files bundled into the page load").toEqual([]);
    const panelChunks = chunks.filter(
      (one) => !one.onPageLoad && one.inputs.some((file) => file.includes(PANEL_DIR)),
    );
    expect(panelChunks).toHaveLength(1);
    expect(imports.map((one) => one.kind)).toContain("dynamic-import");
    expect(imports.some((one) => one.path === panelChunks[0].file)).toBe(true);
  }, 30_000);
});
