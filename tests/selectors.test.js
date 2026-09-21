/** @vitest-environment jsdom */
// The `capture.blank` selector list, checked against a real selector engine (jsdom's) rather than
// a stub: the whole point of the check is that the engine, not us, decides what parses.
import { describe, expect, it, vi } from "vitest";
import { blankSelector, usableSelectors } from "../src/selectors.js";
import { resetWarnings } from "../src/warn.js";

describe("usableSelectors", () => {
  it("keeps what the engine can parse and names what it cannot", () => {
    const { ok, bad } = usableSelectors([".a", "div:has-bad(((", "#b", "!!!"], document);
    expect(ok).toEqual([".a", "#b"]);
    expect(bad).toEqual(["div:has-bad(((", "!!!"]);
  });

  it("skips blanks and non-strings without calling them unusable", () => {
    const { ok, bad } = usableSelectors([".a", "", "   ", null, 7, undefined], document);
    expect(ok).toEqual([".a"]);
    expect(bad).toEqual([]);
  });

  it("keeps the list when there is no document to ask", () => {
    expect(usableSelectors([".a", "div:has-bad((("], null).ok).toEqual([".a", "div:has-bad((("]);
  });
});

describe("blankSelector", () => {
  it("drops one typo and keeps every other selector working", () => {
    expect(blankSelector([".sku-price", "div:has-bad(((", ".email"], document)).toBe(
      ".sku-price,.email",
    );
  });

  it("warns once, naming the selectors it dropped", () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    blankSelector([".sku-price", "div:has-bad((("], document);
    blankSelector([".sku-price", "div:has-bad((("], document);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0];
    expect(line).toContain("capture.blank");
    expect(line).toContain("div:has-bad(((");
    expect(line).toContain("the other 1 still apply");
  });

  it("says nothing when every selector parses", () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(blankSelector([".a", "#b"], document)).toBe(".a,#b");
    expect(warn).not.toHaveBeenCalled();
  });

  it("is empty for an empty or missing list", () => {
    expect(blankSelector([], document)).toBe("");
    expect(blankSelector(undefined, document)).toBe("");
  });
});
