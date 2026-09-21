import { describe, expect, it, vi } from "vitest";
import { byteLength } from "../src/bytes.js";
import {
  CHECKOUT_MS,
  EDITABLE_SELECTOR,
  MASKABLE_INPUTS,
  META_EVENT,
  REPLAY_JSON_MAX,
  SAMPLING,
  SLIM_DOM,
  createSegments,
  idle,
  maskInputOptionsFor,
  rrwebOptions,
  scrubReplayEvent,
  serializeReplay,
  startReplay,
  stripQuery,
} from "../src/capture/replay.js";
import { resetWarnings } from "../src/warn.js";

describe("createSegments", () => {
  it("keeps the current segment and the previous one, and no more", () => {
    const segments = createSegments();
    segments.push({ n: 1 }, true);
    segments.push({ n: 2 }, false);
    segments.push({ n: 3 }, true); // checkout: 1,2 become the previous segment
    segments.push({ n: 4 }, false);
    segments.push({ n: 5 }, true); // checkout again: 1,2 are gone for good
    expect(segments.previous()).toEqual([{ n: 3 }, { n: 4 }]);
    expect(segments.current()).toEqual([{ n: 5 }]);
    expect(segments.events()).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
    expect(segments.count()).toBe(3);
  });

  it("ignores a checkout flag on the very first event", () => {
    const segments = createSegments();
    segments.push({ n: 1 }, true);
    expect(segments.previous()).toEqual([]);
    expect(segments.current()).toEqual([{ n: 1 }]);
  });

  it("dropPrevious empties only the previous segment", () => {
    const segments = createSegments();
    segments.push({ n: 1 }, true);
    segments.push({ n: 2 }, true); // 1 becomes previous
    segments.push({ n: 3 }, false); // 3 joins current
    segments.dropPrevious();
    expect(segments.previous()).toEqual([]);
    expect(segments.current()).toEqual([{ n: 2 }, { n: 3 }]);
    expect(segments.count()).toBe(2);
  });

  it("clear empties both segments", () => {
    const segments = createSegments();
    segments.push({ n: 1 }, true);
    segments.push({ n: 2 }, true);
    segments.push({ n: 3 }, false);
    segments.clear();
    expect(segments.previous()).toEqual([]);
    expect(segments.current()).toEqual([]);
    expect(segments.events()).toEqual([]);
    expect(segments.count()).toBe(0);
  });
});

describe("serializeReplay", () => {
  it("is null when nothing was recorded", () => {
    expect(serializeReplay(createSegments())).toBe(null);
  });

  it("serializes both segments when they fit", () => {
    const segments = createSegments();
    segments.push({ n: 1 }, true);
    segments.push({ n: 2 }, true);
    const result = serializeReplay(segments);
    expect(JSON.parse(result.json)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(result.dropped).toBe(false);
    expect(result.tooBig).toBe(false);
  });

  it("drops the previous segment first when the JSON is over the cap", () => {
    const segments = createSegments();
    segments.push({ big: "a".repeat(200) }, true);
    segments.push({ small: "b" }, true);
    const result = serializeReplay(segments, { max: 120 });
    expect(JSON.parse(result.json)).toEqual([{ small: "b" }]);
    expect(result.dropped).toBe(true);
    expect(result.tooBig).toBe(false);
    expect(segments.previous()).toEqual([]);
  });

  it("gives up when even the current segment is over the cap", () => {
    const segments = createSegments();
    segments.push({ big: "a".repeat(200) }, true);
    const result = serializeReplay(segments, { max: 50 });
    expect(result).toEqual({ json: null, dropped: true, tooBig: true });
  });

  // Standing rule 5 asks for the boundary, not only past it: exactly at the cap must not drop
  // (the check is "> max", not ">="), proven here by measuring the real payload instead of
  // asserting against a hand-picked number that could quietly drift from the implementation.
  it("does not drop at the exact byte cap", () => {
    const segments = createSegments();
    segments.push({ type: 2, data: { source: 0 }, timestamp: 1000 }, true);
    segments.push({ type: 3, data: { source: 1, x: 12, y: 34 }, timestamp: 1050 }, true);
    const exact = byteLength(JSON.stringify(segments.events()));
    const result = serializeReplay(segments, { max: exact });
    expect(result.dropped).toBe(false);
    expect(result.tooBig).toBe(false);
    expect(byteLength(result.json)).toBe(exact);
  });

  // The spec's caps are wire (UTF-8 byte) budgets, and this codebase has already shipped one bug
  // (src/buffers/ring.js's original cut()) from measuring UTF-16 .length instead. Multi-byte
  // characters make the two diverge: 40 CJK characters are .length 40 but 120 UTF-8 bytes, so a
  // max between those two numbers only trips the cap under byte-accurate measurement. Confirmed
  // this fails if serializeReplay is mutated to compare json.length instead of byteLength(json).
  it("measures real UTF-8 bytes, not UTF-16 length, when deciding to drop", () => {
    const segments = createSegments();
    segments.push({ text: "漢".repeat(40) }, true); // 40 CJK chars: .length 40, ~123 UTF-8 bytes
    segments.push({ small: "b" }, true);
    const previousJson = JSON.stringify([{ text: "漢".repeat(40) }]);
    expect(previousJson.length).toBeLessThan(100);
    expect(byteLength(previousJson)).toBeGreaterThan(100);
    const result = serializeReplay(segments, { max: 100 });
    expect(JSON.parse(result.json)).toEqual([{ small: "b" }]);
    expect(result.dropped).toBe(true);
  });

  it("REPLAY_JSON_MAX is the spec's 8 MB", () => {
    expect(REPLAY_JSON_MAX).toBe(8388608);
  });
});

describe("rrwebOptions", () => {
  it("is the spec's recorder configuration", () => {
    const emit = () => {};
    expect(rrwebOptions({ maskAllInputs: false, blank: [] }, emit)).toEqual({
      emit,
      checkoutEveryNms: CHECKOUT_MS,
      maskAllInputs: false,
      maskInputOptions: { password: true, hidden: true, file: true },
      slimDOMOptions: { ...SLIM_DOM },
      sampling: { ...SAMPLING },
      recordCanvas: false,
    });
    expect(CHECKOUT_MS).toBe(60000);
    expect(SAMPLING).toEqual({ mousemove: 50, scroll: 150, input: "last" });
  });

  it("turns the app's blank list into one blockSelector", () => {
    const options = rrwebOptions(
      { maskAllInputs: true, blank: [".sku-price", ".email"] },
      () => {},
    );
    expect(options.blockSelector).toBe(".sku-price,.email");
  });

  it("omits blockSelector when blank is empty or absent", () => {
    expect(rrwebOptions({}, () => {})).not.toHaveProperty("blockSelector");
    expect(rrwebOptions(undefined, () => {})).not.toHaveProperty("blockSelector");
  });

  // rrweb's own `maskAllInputs: true` expands to a fixed list of input kinds *and discards any
  // maskInputOptions passed with it*, so the flag and a correction cannot be combined. The list
  // it expands to leaves out `hidden` and `file`. The marker harness caught both
  // (tests/leak-matrix.test.js): a hidden field's value and a file input's fake path — which
  // still names the file — reached the recording with maskAllInputs on.
  it("never passes rrweb's maskAllInputs flag, whatever the app asked for", () => {
    expect(rrwebOptions({ maskAllInputs: true }, () => {}).maskAllInputs).toBe(false);
    expect(rrwebOptions({ maskAllInputs: false }, () => {}).maskAllInputs).toBe(false);
  });

  it("always masks a password, a hidden field and a file path", () => {
    for (const maskAllInputs of [true, false]) {
      const options = rrwebOptions({ maskAllInputs }, () => {}).maskInputOptions;
      expect(options.password).toBe(true);
      expect(options.hidden).toBe(true);
      expect(options.file).toBe(true);
    }
  });

  it("names every other maskable kind only when the app asked for maskAllInputs", () => {
    expect(maskInputOptionsFor(false)).toEqual({ password: true, hidden: true, file: true });
    const all = maskInputOptionsFor(true);
    for (const kind of MASKABLE_INPUTS) expect(all[kind], kind).toBe(true);
    expect(Object.keys(all).sort()).toEqual(
      [...MASKABLE_INPUTS, "password", "hidden", "file"].sort(),
    );
    // A button's label is not a value anybody typed, and masking it would put asterisks on a
    // button in the replay.
    for (const label of ["submit", "button", "reset", "image"]) {
      expect(all[label], label).toBeUndefined();
    }
  });

  it("masks contenteditable text under maskAllInputs, and only then", () => {
    expect(rrwebOptions({ maskAllInputs: true }, () => {}).maskTextSelector).toBe(
      EDITABLE_SELECTOR,
    );
    expect(rrwebOptions({ maskAllInputs: false }, () => {})).not.toHaveProperty("maskTextSelector");
  });

  it("asks rrweb to leave out comments, scripts and the token-bearing head meta", () => {
    const slim = rrwebOptions({}, () => {}).slimDOMOptions;
    expect(slim.comment).toBe(true);
    expect(slim.script).toBe(true);
    expect(slim.headMetaVerification).toBe(true);
    expect(slim.headMetaHttpEquiv).toBe(true);
    // Kept: a dashboard retitles itself on every route change and the replay should follow.
    expect(slim.headTitleMutations).toBeUndefined();
  });
});

describe("stripQuery", () => {
  it("drops the query and keeps everything else", () => {
    expect(stripQuery("https://app.example/rings?token=abc")).toBe("https://app.example/rings");
    expect(stripQuery("https://app.example/rings?token=abc#batch-7")).toBe(
      "https://app.example/rings#batch-7",
    );
    expect(stripQuery("https://app.example/rings#batch-7")).toBe(
      "https://app.example/rings#batch-7",
    );
  });

  it("falls back to cutting by hand on a URL it cannot parse, and never throws", () => {
    expect(stripQuery("not a url?token=abc")).toBe("not a url");
    expect(stripQuery("not a url?token=abc#tail")).toBe("not a url#tail");
    expect(stripQuery(undefined)).toBe("");
    expect(stripQuery(null)).toBe("");
    expect(stripQuery(7)).toBe("");
  });
});

describe("scrubReplayEvent", () => {
  // mount.js's pageContext sends `pathname + hash` and never the query, because cad-dashboard's
  // router puts a magic-link token in one. rrweb's Meta event carries window.location.href whole,
  // which undoes that decision; the marker harness found it by planting a marker in the page's
  // own query string (channel/location-query).
  it("takes the query string out of a Meta event's href", () => {
    const event = {
      type: META_EVENT,
      data: { href: "https://app.example/rings?token=secret", width: 1280, height: 800 },
      timestamp: 1,
    };
    const out = scrubReplayEvent(event);
    expect(out.data.href).toBe("https://app.example/rings");
    expect(out.data.width).toBe(1280);
    expect(out.data.height).toBe(800);
    expect(out.timestamp).toBe(1);
    // The caller's event is not mutated: rrweb keeps its own references to what it emits.
    expect(event.data.href).toBe("https://app.example/rings?token=secret");
  });

  it("passes everything else through by identity", () => {
    const full = { type: 2, data: { node: {} } };
    expect(scrubReplayEvent(full)).toBe(full);
    const clean = { type: META_EVENT, data: { href: "https://app.example/rings" } };
    expect(scrubReplayEvent(clean)).toBe(clean);
    expect(scrubReplayEvent(undefined)).toBe(undefined);
    expect(scrubReplayEvent({ type: META_EVENT })).toEqual({ type: META_EVENT });
    expect(scrubReplayEvent({ type: META_EVENT, data: { href: 7 } }).data.href).toBe(7);
  });
});

describe("idle", () => {
  it("schedules through requestIdleCallback when it exists", () => {
    const ric = vi.fn();
    vi.stubGlobal("requestIdleCallback", ric);
    try {
      const fn = vi.fn();
      idle(fn);
      expect(ric).toHaveBeenCalledTimes(1);
      expect(ric.mock.calls[0][1]).toEqual({ timeout: 2000 });
      expect(fn).not.toHaveBeenCalled();
      ric.mock.calls[0][0]();
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to a 200ms timeout when requestIdleCallback does not exist", () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      idle(fn);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(199);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("startReplay", () => {
  it("loads the recorder on the scheduled callback and collects events", async () => {
    const stop = vi.fn();
    const load = vi.fn(async () => ({
      record(options) {
        options.emit({ type: 2 }, true);
        options.emit({ type: 3 }, false);
        return stop;
      },
    }));
    const schedule = (fn) => fn();
    const replay = startReplay({ maskAllInputs: false, blank: [] }, { load, schedule });
    expect(await replay.ready).toBe(true);
    expect(replay.segments.events()).toEqual([{ type: 2 }, { type: 3 }]);
    replay.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("scrubs every event on its way into the segments", async () => {
    const load = vi.fn(async () => ({
      record(options) {
        options.emit({ type: 4, data: { href: "https://app.example/rings?token=secret" } }, true);
        options.emit({ type: 3, data: { source: 2 } }, false);
        return () => {};
      },
    }));
    const replay = startReplay({}, { load, schedule: (fn) => fn() });
    expect(await replay.ready).toBe(true);
    expect(replay.segments.events()).toEqual([
      { type: 4, data: { href: "https://app.example/rings" } },
      { type: 3, data: { source: 2 } },
    ]);
  });

  it("does not start the recorder at all until the callback runs", async () => {
    const load = vi.fn(async () => ({ record: () => () => {} }));
    let run = null;
    const replay = startReplay({}, { load, schedule: (fn) => (run = fn) });
    expect(load).not.toHaveBeenCalled();
    await run();
    expect(await replay.ready).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("warns once and carries on when the recorder cannot be loaded", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const replay = startReplay(
      {},
      {
        load: async () => {
          throw new Error("chunk 404");
        },
        schedule: (fn) => fn(),
      },
    );
    expect(await replay.ready).toBe(false);
    expect(replay.segments.events()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => replay.stop()).not.toThrow();
  });

  // @rrweb/record@2.1.6's own record() swallows its internal errors: it wraps its whole body in
  // a try/catch that logs to console.warn and falls off the end (verified in
  // node_modules/.pnpm/rrweb@2.1.6/.../dist/rrweb.js:14176-14638), which is exactly why its type
  // signature is `listenerHandler | undefined` rather than always a handler. Left unguarded,
  // startReplay would resolve `ready` true and claim a recording that never started, with no
  // warning of our own. Confirmed this test fails (ready resolves true, warn is never called) if
  // the `typeof stopFn !== "function"` guard is removed from replay.js.
  it("treats a record() that returns no stop handle as a failure to start", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const replay = startReplay(
      {},
      { load: async () => ({ record: () => undefined }), schedule: (fn) => fn() },
    );
    expect(await replay.ready).toBe(false);
    expect(replay.segments.events()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => replay.stop()).not.toThrow();
  });

  it("never starts the recorder if stop() was called before the scheduled callback ran", async () => {
    const record = vi.fn(() => () => {});
    let run = null;
    const replay = startReplay(
      {},
      { load: async () => ({ record }), schedule: (fn) => (run = fn) },
    );
    replay.stop();
    await run();
    expect(await replay.ready).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it("stop() is safe to call twice", async () => {
    const stop = vi.fn();
    const replay = startReplay(
      {},
      { load: async () => ({ record: () => stop }), schedule: (fn) => fn() },
    );
    await replay.ready;
    replay.stop();
    replay.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
