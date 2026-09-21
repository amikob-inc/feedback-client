import { describe, expect, it, vi } from "vitest";
import { noticeOnce, resetWarnings, warnOnce } from "../src/warn.js";

describe("warnOnce", () => {
  it("warns once per label, whatever happens after", () => {
    resetWarnings();
    const warn = vi.fn();
    warnOnce("console buffer", new Error("boom"), warn);
    warnOnce("console buffer", new Error("boom again"), warn);
    warnOnce("network buffer", new Error("other"), warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toBe("[feedback-client] console buffer disabled: boom");
    expect(warn.mock.calls[1][0]).toBe("[feedback-client] network buffer disabled: other");
  });

  it("describes a thrown non-Error too", () => {
    resetWarnings();
    const warn = vi.fn();
    warnOnce("replay", "no recorder", warn);
    expect(warn.mock.calls[0][0]).toBe("[feedback-client] replay disabled: no recorder");
  });

  it("shares its once-per-label budget with noticeOnce", () => {
    // Both spellings write about the same subsystem, so a notice must not be repeated as a
    // warning (or the other way round) just because it took the other door.
    resetWarnings();
    const warn = vi.fn();
    noticeOnce("capture.blank", "one selector ignored", warn);
    warnOnce("capture.blank", new Error("boom"), warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("[feedback-client] capture.blank: one selector ignored");
  });

  it("swallows a console that throws", () => {
    resetWarnings();
    expect(() =>
      warnOnce("x", new Error("e"), () => {
        throw new Error("no console here");
      }),
    ).not.toThrow();
  });
});
