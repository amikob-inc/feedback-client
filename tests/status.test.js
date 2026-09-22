import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STATUSES,
  isRetryable,
  labelContext,
  needsReply,
  originalState,
  statusLabel,
  statusTone,
} from "../src/status.js";

const FIXTURE_URL = new URL("../fixtures/status-cases.json", import.meta.url);
const raw = readFileSync(FIXTURE_URL, "utf8");
const fixture = JSON.parse(raw);

describe("statusLabel", () => {
  // Hand-written from the spec's §4 table and the hub's statusLabel, not produced by any code
  // here: these strings are the contract with the hub, and the panel shows them unchanged.
  const cases = [
    ["triaging", {}, "Received, being looked at"],
    ["waiting", {}, "Received, waiting"],
    ["filed", { issue: 42 }, "Filed as #42"],
    ["filed", {}, "Filed"],
    ["in_progress", {}, "Fix in progress"],
    ["fixed", {}, "Fixed"],
    ["closed", {}, "Closed"],
    ["answered", {}, "Answered"],
    ["duplicate", { duplicateOf: 8 }, "Already tracked as #8"],
    ["duplicate", { duplicateOf: 8, originalState: "open" }, "Already tracked as #8 (open)"],
    ["duplicate", { duplicateOf: 8, originalState: "fixed" }, "Already tracked as #8 (fixed)"],
    ["duplicate", { duplicateOf: 8, originalState: "closed" }, "Already tracked as #8 (closed)"],
    ["needs_reply", {}, "Needs your reply"],
    ["not_filed", {}, "Not filed"],
    ["error", {}, "Could not triage"],
  ];

  for (const [status, ctx, expected] of cases) {
    it(`${status} ${JSON.stringify(ctx)} is "${expected}"`, () => {
      expect(statusLabel(status, ctx)).toBe(expected);
    });
  }

  it("has a label for every status it knows", () => {
    for (const status of STATUSES)
      expect(typeof statusLabel(status, { issue: 1, duplicateOf: 1 })).toBe("string");
  });

  it("says nothing it does not know", () => {
    expect(statusLabel("invented", {})).toBe("");
  });
});

describe("originalState", () => {
  it("maps the original issue's GitHub state the way the hub's listing does", () => {
    expect(originalState(null)).toBe(undefined);
    expect(originalState({ state: "open", stateReason: null })).toBe("open");
    expect(originalState({ state: "closed", stateReason: "completed" })).toBe("fixed");
    expect(originalState({ state: "closed", stateReason: "not_planned" })).toBe("closed");
  });
});

describe("the fixture shared with the hub", () => {
  it("has not drifted (the hub asserts the same digest)", () => {
    const canonical = JSON.stringify(JSON.parse(raw));
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(
      "9ff37288abe6669007d333429ea483a854bd843bdbd473b63254021db9baacab",
    );
  });

  it("covers every status the panel can show", () => {
    const covered = new Set(fixture.cases.map((one) => one.status));
    expect([...covered].sort()).toEqual([...STATUSES].sort());
  });

  it("produces each case's label from its verdict and the original issue", () => {
    for (const one of fixture.cases) {
      const ctx = labelContext({ verdict: one.input.verdict, original: one.input.original });
      expect(`${one.name}: ${statusLabel(one.status, ctx)}`).toBe(`${one.name}: ${one.label}`);
    }
  });

  it("gives every case a tone and the right affordances", () => {
    for (const one of fixture.cases) {
      expect(statusTone(one.status)).not.toBe("");
      expect(isRetryable(one.status)).toBe(one.status === "waiting" || one.status === "error");
      expect(needsReply(one.status)).toBe(one.status === "needs_reply");
    }
  });
});
