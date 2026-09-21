import { describe, expect, it } from "vitest";
import { SEEN_CAP, attentionIds, markSeen, readSeen, seenKey, writeSeen } from "../src/seen.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
  };
}

const answered = (id, at) => ({ id, status: "answered", verdict: { receivedAt: at } });

describe("seenKey", () => {
  it("is per app and per reporter", () => {
    expect(seenKey("cad", "sub-1")).toBe("fbh.seen.cad.sub-1");
    expect(seenKey("cad", null)).toBe("fbh.seen.cad.anon");
  });
});

describe("readSeen and writeSeen", () => {
  it("round-trips and survives rubbish in storage", () => {
    const storage = fakeStorage({ "fbh.seen.cad.a": "not json" });
    expect(readSeen(storage, "fbh.seen.cad.a")).toEqual({});
    writeSeen(storage, "fbh.seen.cad.a", { one: "2026-09-21T10:00:00.000Z" });
    expect(readSeen(storage, "fbh.seen.cad.a")).toEqual({ one: "2026-09-21T10:00:00.000Z" });
  });

  it("does nothing at all without storage", () => {
    expect(readSeen(null, "k")).toEqual({});
    expect(() => writeSeen(null, "k", { a: "b" })).not.toThrow();
  });

  it("keeps at most 200 entries", () => {
    const storage = fakeStorage();
    const seen = {};
    for (let i = 0; i < SEEN_CAP + 10; i += 1) seen[`id${i}`] = "t";
    writeSeen(storage, "k", seen);
    expect(Object.keys(readSeen(storage, "k"))).toHaveLength(SEEN_CAP);
  });

  it("swallows a storage that refuses to write", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => writeSeen(storage, "k", { a: "b" })).not.toThrow();
  });
});

describe("attentionIds", () => {
  it("counts questions waiting and answers not yet seen", () => {
    const items = [
      { id: "q", status: "needs_reply", verdict: { receivedAt: "t1" } },
      answered("a", "t2"),
      answered("b", "t3"),
      { id: "f", status: "filed", verdict: { receivedAt: "t4" } },
    ];
    expect(attentionIds(items, { b: "t3" })).toEqual(["q", "a"]);
  });

  it("counts an answer again when the verdict is newer than what was seen", () => {
    expect(attentionIds([answered("a", "t9")], { a: "t2" })).toEqual(["a"]);
  });
});

describe("markSeen", () => {
  it("records each item's verdict time and reports whether anything changed", () => {
    const first = markSeen({}, [
      answered("a", "t1"),
      { id: "n", status: "triaging", verdict: null },
    ]);
    expect(first.changed).toBe(true);
    expect(first.seen).toEqual({ a: "t1" });
    const again = markSeen(first.seen, [answered("a", "t1")]);
    expect(again.changed).toBe(false);
  });
});
