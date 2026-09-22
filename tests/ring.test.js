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
  it("leaves an ASCII string exactly at the byte limit alone", () =>
    expect(cut("abc", 3)).toBe("abc"));
  it("cuts pure ASCII over the byte limit", () => expect(cut("abcdef", 3)).toBe("abc"));
  it("tolerates a non-string", () => expect(cut(undefined, 3)).toBe(""));
  it("tolerates an empty string", () => expect(cut("", 10)).toBe(""));

  it("cuts by UTF-8 bytes, not UTF-16 length, for CJK text", () => {
    // "中" is one UTF-16 code unit but 3 UTF-8 bytes; ten of them are 30 bytes.
    const text = "中".repeat(10);
    const result = cut(text, 7);
    // floor(7 / 3) = 2 whole characters fit; a third would be 9 bytes, over budget.
    expect(result).toBe("中中");
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(7);
  });

  it("never splits a surrogate pair even when the byte budget falls mid-pair", () => {
    // 😀 (U+1F600) is a surrogate pair (2 UTF-16 units) and 4 UTF-8 bytes.
    const text = "😀".repeat(3);
    const result = cut(text, 5);
    // One emoji (4 bytes) fits; a second would be 8 bytes, over budget — the cut must land
    // before the second emoji starts, never mid-surrogate-pair.
    expect(result).toBe("😀");
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(5);
    // A lone (unpaired) surrogate makes encodeURIComponent throw a URIError; a complete pair,
    // like a whole emoji, does not. This is a general check that the result is well-formed
    // UTF-16, not just a check against this one example.
    expect(() => encodeURIComponent(result)).not.toThrow();
  });

  it("keeps whole emoji up to the byte budget, dropping the one that would overflow it", () => {
    const text = "😀".repeat(3);
    const result = cut(text, 9);
    expect(result).toBe("😀😀");
    expect(new TextEncoder().encode(result).length).toBe(8);
  });
});
