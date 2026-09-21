import { describe, expect, it } from "vitest";
import { Ring, cut } from "../src/buffers/ring.js";

describe("Ring", () => {
  it("keeps the newest N and drops the oldest", () => {
    const ring = new Ring(3);
    for (const n of [1, 2, 3, 4, 5]) ring.push(n);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.length).toBe(3);
  });

  it("returns a copy, so a caller cannot mutate the buffer", () => {
    const ring = new Ring(2);
    ring.push("a");
    const copy = ring.toArray();
    copy.push("b");
    expect(ring.toArray()).toEqual(["a"]);
  });

  it("clears", () => {
    const ring = new Ring(2);
    ring.push("a");
    ring.clear();
    expect(ring.toArray()).toEqual([]);
  });
});

describe("cut", () => {
  it("leaves a short string alone", () => expect(cut("abc", 5)).toBe("abc"));
  it("cuts at the limit", () => expect(cut("abcdef", 3)).toBe("abc"));
  it("tolerates a non-string", () => expect(cut(undefined, 3)).toBe(""));
});
