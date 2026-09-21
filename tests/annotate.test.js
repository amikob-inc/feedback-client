/** @vitest-environment jsdom */
// jsdom has no real 2D canvas context, so every test here that needs to "draw" injects a fake
// canvas/context that records calls, the same way the brief's own reference tests do. That proves
// the module's own logic (coordinate math, pointer bookkeeping, undo/clear, what gets drawn in
// what order, every failure path never throwing) genuinely — it's real code under test, not a
// stub standing in for the assertion. It does NOT prove that a *real* browser's canvas behaves the
// way the fakes say it does (e.g. that toBlob truly rejects on a tainted canvas, or truly hangs a
// 20000×20000 allocation) — that half is left to the Playwright suite in Task 14, and is called
// out below wherever it applies.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_LOAD_TIMEOUT_MS,
  PEN_COLOR,
  createStrokes,
  drawStrokes,
  flattenAnnotation,
  loadImageBlob,
  openAnnotator,
  penWidth,
  pointFrom,
} from "../src/panel/annotate.js";
import { resetWarnings } from "../src/warn.js";

function fakeContext() {
  const calls = [];
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  return {
    calls,
    set lineWidth(value) {
      calls.push(["lineWidth", value]);
    },
    set strokeStyle(value) {
      calls.push(["strokeStyle", value]);
    },
    set lineCap(value) {
      calls.push(["lineCap", value]);
    },
    set lineJoin(value) {
      calls.push(["lineJoin", value]);
    },
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    stroke: record("stroke"),
    drawImage: record("drawImage"),
  };
}

function fakeCanvas(context = fakeContext()) {
  return {
    width: 0,
    height: 0,
    context,
    style: {},
    listeners: {},
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 300 }),
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    removeEventListener(type) {
      delete this.listeners[type];
    },
    toBlob: (cb) => cb(new Blob([new Uint8Array(7)], { type: "image/png" })),
  };
}

const png = () => new Blob([new Uint8Array(3)], { type: "image/png" });

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("createStrokes", () => {
  it("collects a stroke, turns a single tap into a dot and undoes one at a time", () => {
    const strokes = createStrokes();
    strokes.begin({ x: 1, y: 1 });
    strokes.extend({ x: 5, y: 5 });
    strokes.end();
    strokes.begin({ x: 9, y: 9 });
    strokes.end();
    expect(strokes.toArray()).toEqual([
      {
        color: PEN_COLOR,
        points: [
          { x: 1, y: 1 },
          { x: 5, y: 5 },
        ],
      },
      {
        color: PEN_COLOR,
        points: [
          { x: 9, y: 9 },
          { x: 9, y: 9 },
        ],
      },
    ]);
    strokes.undo();
    expect(strokes.length).toBe(1);
    strokes.clear();
    expect(strokes.length).toBe(0);
    expect(strokes.isDrawing()).toBe(false);
  });

  it("ignores movement before the pen went down", () => {
    const strokes = createStrokes();
    strokes.extend({ x: 1, y: 1 });
    expect(strokes.length).toBe(0);
  });

  // Undo with nothing to undo, clear with nothing to clear, and undo after clear: none of these
  // may throw, and none may resurrect anything.
  it("undo does nothing with nothing to undo, clear does nothing with nothing to clear, and undo after clear stays empty", () => {
    const strokes = createStrokes();
    expect(() => strokes.undo()).not.toThrow();
    expect(strokes.length).toBe(0);
    expect(() => strokes.clear()).not.toThrow();
    expect(strokes.length).toBe(0);

    strokes.begin({ x: 0, y: 0 });
    strokes.end();
    strokes.clear();
    expect(() => strokes.undo()).not.toThrow();
    expect(strokes.length).toBe(0);
  });

  // Clearing while a pointer is still down (a keyboard-driven Clear firing mid-drag) must stop
  // that stroke rather than leaving it live and orphaned.
  it("clearing mid-stroke stops that stroke: isDrawing drops to false and nothing more can be added to it", () => {
    const strokes = createStrokes();
    strokes.begin({ x: 1, y: 1 });
    strokes.clear();
    expect(strokes.isDrawing()).toBe(false);
    expect(strokes.length).toBe(0);
    strokes.extend({ x: 5, y: 5 });
    strokes.end();
    expect(strokes.length).toBe(0);
  });
});

describe("penWidth", () => {
  it("scales with the image and never goes under two pixels", () => {
    expect(penWidth(300)).toBe(2);
    expect(penWidth(1800)).toBe(6);
  });

  it("never goes below 2px even for a zero or tiny image width", () => {
    expect(penWidth(0)).toBe(2);
    expect(penWidth(1)).toBe(2);
  });
});

describe("drawStrokes", () => {
  it("draws every stroke in the pen's colour", () => {
    const context = fakeContext();
    drawStrokes(
      context,
      [
        {
          color: PEN_COLOR,
          points: [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
          ],
        },
      ],
      4,
    );
    expect(context.calls).toEqual([
      ["lineCap", "round"],
      ["lineJoin", "round"],
      ["lineWidth", 4],
      ["strokeStyle", PEN_COLOR],
      ["beginPath"],
      ["moveTo", 1, 2],
      ["lineTo", 3, 4],
      ["stroke"],
    ]);
  });

  it("skips a stroke with no points instead of crashing on an empty moveTo", () => {
    const context = fakeContext();
    expect(() => drawStrokes(context, [{ color: PEN_COLOR, points: [] }], 4)).not.toThrow();
    expect(context.calls.some(([name]) => name === "moveTo")).toBe(false);
    expect(context.calls.some(([name]) => name === "beginPath")).toBe(false);
  });
});

describe("pointFrom", () => {
  it("turns a client position into image pixels", () => {
    const canvas = fakeCanvas();
    canvas.width = 800;
    canvas.height = 600;
    expect(pointFrom({ clientX: 210, clientY: 170 }, canvas)).toEqual({ x: 400, y: 300 });
  });

  // Every point on the canvas is flattened at the image's own resolution, not the screen's.
  // getBoundingClientRect() already reports CSS pixels regardless of devicePixelRatio, so the
  // mapping must come out identical whether the display is 1x or 3x — reading
  // window.devicePixelRatio in pointFrom at all would double the scale on a dense display.
  it("gives the same image-pixel result at any devicePixelRatio, for a canvas displayed smaller than the image", () => {
    const canvas = fakeCanvas();
    canvas.width = 1200; // the image's own, full resolution
    canvas.height = 900;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 225 }); // shown at 1/4
    const original = window.devicePixelRatio;
    try {
      window.devicePixelRatio = 1;
      const atDpr1 = pointFrom({ clientX: 150, clientY: 112.5 }, canvas);
      window.devicePixelRatio = 3;
      const atDpr3 = pointFrom({ clientX: 150, clientY: 112.5 }, canvas);
      expect(atDpr1).toEqual({ x: 600, y: 450 });
      expect(atDpr3).toEqual(atDpr1);
    } finally {
      window.devicePixelRatio = original;
    }
  });

  it("falls back to a 1:1 scale for a zero-sized rect instead of dividing by zero into NaN", () => {
    const canvas = fakeCanvas();
    canvas.width = 800;
    canvas.height = 600;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
    expect(pointFrom({ clientX: 5, clientY: 7 }, canvas)).toEqual({ x: 5, y: 7 });
  });
});

describe("loadImageBlob", () => {
  // A fake `doc` (not the real document) whose createElement hands back a plain object the test
  // drives directly — this is what lets the zero-size and timeout paths be proven without jsdom's
  // own image loading, which (confirmed by hand: neither `load` nor `error` ever fires for a
  // blob: URL in this environment) can't exercise them at all.
  // `element` is a getter, deliberately: `doc.createElement("img")` only runs *inside*
  // loadImageBlob, so a plain destructure taken before calling it would freeze on `null` forever.
  // Reading `helper.element` after the call gets the live value instead.
  function fakeImgDoc() {
    let created = null;
    return {
      doc: {
        createElement: () => {
          created = { naturalWidth: 0, naturalHeight: 0 };
          return created;
        },
      },
      get element() {
        return created;
      },
    };
  }

  it("resolves with the decoded size and a working revoke()", async () => {
    const helper = fakeImgDoc();
    const promise = loadImageBlob(helper.doc, png());
    helper.element.naturalWidth = 640;
    helper.element.naturalHeight = 480;
    helper.element.onload();
    const image = await promise;
    expect(image.element).toBe(helper.element);
    expect(image.width).toBe(640);
    expect(image.height).toBe(480);
    expect(() => image.revoke()).not.toThrow();
  });

  it("rejects an image that loads with no pixels, instead of handing back a canvas nothing can be drawn on", async () => {
    const helper = fakeImgDoc();
    const promise = loadImageBlob(helper.doc, png());
    helper.element.naturalWidth = 0;
    helper.element.naturalHeight = 0;
    helper.element.onload();
    await expect(promise).rejects.toThrow();
  });

  it("rejects when the element fires error", async () => {
    const helper = fakeImgDoc();
    const promise = loadImageBlob(helper.doc, png());
    helper.element.onerror();
    await expect(promise).rejects.toThrow();
  });

  // The exact bug confirmed by hand while building this file: jsdom fires neither event for a
  // blob: URL, so without a timeout this promise would simply never settle.
  it("rejects instead of hanging forever when neither load nor error ever fires", async () => {
    vi.useFakeTimers();
    try {
      const helper = fakeImgDoc();
      const promise = loadImageBlob(helper.doc, png());
      const assertion = expect(promise).rejects.toThrow("too long");
      await vi.advanceTimersByTimeAsync(IMAGE_LOAD_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("flattenAnnotation", () => {
  it("draws the image first, then the strokes, at the image's own size", async () => {
    const context = fakeContext();
    const canvas = fakeCanvas(context);
    const image = { element: { tag: "img" }, width: 1200, height: 800 };
    const strokes = [
      {
        color: PEN_COLOR,
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    ];
    const blob = await flattenAnnotation({
      doc: document,
      image,
      strokes,
      makeCanvas: () => canvas,
    });
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(800);
    expect(context.calls[0]).toEqual(["drawImage", image.element, 0, 0, 1200, 800]);
    expect(context.calls.some(([name, value]) => name === "lineWidth" && value === 4)).toBe(true);
    expect(blob.type).toBe("image/png");
  });

  it("resolves null and warns once for an image with zero size, instead of building a canvas nothing can hold", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blob = await flattenAnnotation({
      doc: document,
      image: { element: {}, width: 0, height: 400 },
      strokes: [],
      makeCanvas: () => fakeCanvas(),
    });
    expect(blob).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("resolves null and warns once when there is no 2D context, instead of throwing on ctx.drawImage", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canvas = fakeCanvas();
    canvas.getContext = () => null;
    const blob = await flattenAnnotation({
      doc: document,
      image: { element: {}, width: 100, height: 100 },
      strokes: [],
      makeCanvas: () => canvas,
    });
    expect(blob).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("resolves null and warns once when drawImage itself throws (a broken image)", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = fakeContext();
    context.drawImage = () => {
      throw new Error("the source image is detached");
    };
    const blob = await flattenAnnotation({
      doc: document,
      image: { element: {}, width: 100, height: 100 },
      strokes: [],
      makeCanvas: () => fakeCanvas(context),
    });
    expect(blob).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("resolves null and warns once when toBlob doesn't exist", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canvas = fakeCanvas();
    delete canvas.toBlob;
    const blob = await flattenAnnotation({
      doc: document,
      image: { element: {}, width: 100, height: 100 },
      strokes: [],
      makeCanvas: () => canvas,
    });
    expect(blob).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // A tainted canvas's toBlob throws synchronously rather than rejecting.
  it("resolves null and warns once when toBlob itself throws synchronously (a tainted canvas)", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canvas = fakeCanvas();
    canvas.toBlob = () => {
      throw new Error("tainted canvas");
    };
    const blob = await flattenAnnotation({
      doc: document,
      image: { element: {}, width: 100, height: 100 },
      strokes: [],
      makeCanvas: () => canvas,
    });
    expect(blob).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("resolves null and warns once when toBlob calls back with null", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canvas = fakeCanvas();
    canvas.toBlob = (cb) => cb(null);
    const blob = await flattenAnnotation({
      doc: document,
      image: { element: {}, width: 100, height: 100 },
      strokes: [],
      makeCanvas: () => canvas,
    });
    expect(blob).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("openAnnotator", () => {
  async function open({ onSave = vi.fn(), image, canvas: givenCanvas } = {}) {
    const canvas = givenCanvas || fakeCanvas();
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const resolvedImage = image || {
      element: { tag: "img" },
      width: 800,
      height: 600,
      revoke: vi.fn(),
    };
    const annotator = await openAnnotator({
      doc: document,
      blob: png(),
      mount,
      onSave,
      loadImage: async () => resolvedImage,
      makeCanvas: () => canvas,
    });
    return { annotator, canvas, mount, onSave, image: resolvedImage };
  }

  it("shows the image on a canvas with Undo, Clear, Cancel and Save", async () => {
    const { mount, canvas } = await open();
    expect(mount.querySelector("[data-undo]")).not.toBe(null);
    expect(mount.querySelector("[data-clear]")).not.toBe(null);
    expect(mount.querySelector("[data-cancel]")).not.toBe(null);
    expect(mount.querySelector("[data-save]")).not.toBe(null);
    expect(canvas.width).toBe(800);
    expect(canvas.context.calls[0][0]).toBe("drawImage");
  });

  it("draws while the pointer is down and saves a flattened PNG", async () => {
    const { annotator, canvas, mount, onSave } = await open();
    canvas.listeners.pointerdown({ clientX: 10, clientY: 20, preventDefault() {} });
    document.dispatchEvent(
      Object.assign(new window.Event("pointermove"), { clientX: 210, clientY: 170 }),
    );
    document.dispatchEvent(new window.Event("pointerup"));
    mount.querySelector("[data-save]").click();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].type).toBe("image/png");
    annotator.close();
    expect(mount.querySelector(".fbh-annotator")).toBe(null);
  });

  it("undoes and clears without saving, and cancels without calling onSave", async () => {
    const { annotator, canvas, mount, onSave } = await open();
    canvas.listeners.pointerdown({ clientX: 10, clientY: 20, preventDefault() {} });
    document.dispatchEvent(new window.Event("pointerup"));
    mount.querySelector("[data-undo]").click();
    mount.querySelector("[data-clear]").click();
    mount.querySelector("[data-cancel]").click();
    expect(onSave).not.toHaveBeenCalled();
    expect(mount.querySelector(".fbh-annotator")).toBe(null);
    annotator.close();
  });

  // A stroke that starts outside the canvas never reaches this module at all, since the
  // pointerdown listener lives on the canvas element itself; nothing here needs to special-case
  // it. This locks in the opposite and more dangerous direction: a stroke that starts on the
  // canvas must keep extending however far the pointer strays off it and comes back, because the
  // move/up listeners are deliberately on `doc`, not the canvas.
  it("keeps extending a stroke through pointer positions outside the canvas, and back", async () => {
    const { canvas } = await open();
    canvas.listeners.pointerdown({ clientX: 10, clientY: 20, preventDefault() {} }); // -> (0, 0)
    document.dispatchEvent(
      Object.assign(new window.Event("pointermove"), { clientX: 5000, clientY: 5000 }),
    ); // far outside
    document.dispatchEvent(
      Object.assign(new window.Event("pointermove"), { clientX: 210, clientY: 170 }),
    ); // back inside -> (400, 300)
    document.dispatchEvent(new window.Event("pointerup"));
    const lineTos = canvas.context.calls
      .filter(([name]) => name === "lineTo")
      .map(([, x, y]) => `${x},${y}`);
    expect(lineTos).toContain("9980,9960");
    expect(lineTos).toContain("400,300");
  });

  // A second finger touching down mid-stroke must not hijack or interleave with the stroke
  // already in progress.
  it("ignores a second pointer that comes down while the first is still drawing", async () => {
    const { canvas } = await open();
    canvas.listeners.pointerdown({ clientX: 10, clientY: 20, pointerId: 1, preventDefault() {} });
    const callsAfterFirst = canvas.context.calls.length;
    canvas.listeners.pointerdown({ clientX: 60, clientY: 70, pointerId: 2, preventDefault() {} });
    expect(canvas.context.calls.length).toBe(callsAfterFirst); // the second pointerdown did nothing at all

    // Movement under the *second* pointer's id must not touch the stroke either…
    document.dispatchEvent(
      Object.assign(new window.Event("pointermove"), { clientX: 999, clientY: 999, pointerId: 2 }),
    );
    expect(
      canvas.context.calls.some(([, x, y]) => x === (999 - 10) * 2 && y === (999 - 20) * 2),
    ).toBe(false);

    // …but the original pointer keeps working normally.
    document.dispatchEvent(
      Object.assign(new window.Event("pointermove"), { clientX: 210, clientY: 170, pointerId: 1 }),
    );
    document.dispatchEvent(new window.Event("pointerup"));
    const lineTos = canvas.context.calls.filter(([name]) => name === "lineTo");
    expect(lineTos.some(([, x, y]) => x === 400 && y === 300)).toBe(true);
  });

  it("fails gracefully, without throwing, when the image cannot be loaded", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mount = document.createElement("div");
    const annotator = await openAnnotator({
      doc: document,
      blob: png(),
      mount,
      onSave: vi.fn(),
      loadImage: async () => {
        throw new Error("could not decode");
      },
      makeCanvas: () => fakeCanvas(),
    });
    expect(annotator.element).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => annotator.close()).not.toThrow();
  });

  // Guards a `loadImage` override that hands back a zero-size image anyway (loadImageBlob's own
  // rejection is covered above).
  it("fails gracefully, without throwing, for an image with zero size", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const revoke = vi.fn();
    const mount = document.createElement("div");
    const annotator = await openAnnotator({
      doc: document,
      blob: png(),
      mount,
      onSave: vi.fn(),
      loadImage: async () => ({ element: {}, width: 0, height: 400, revoke }),
      makeCanvas: () => fakeCanvas(),
    });
    expect(annotator.element).toBe(null);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("fails gracefully, without throwing, when the canvas has no 2D context", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const revoke = vi.fn();
    const canvas = fakeCanvas();
    canvas.getContext = () => null;
    const mount = document.createElement("div");
    const annotator = await openAnnotator({
      doc: document,
      blob: png(),
      mount,
      onSave: vi.fn(),
      loadImage: async () => ({ element: {}, width: 800, height: 600, revoke }),
      makeCanvas: () => canvas,
    });
    expect(annotator.element).toBe(null);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Never silently discard the reporter's marks: a save that can't produce a blob (an enormous
  // image, a tainted canvas, an unsupported encode — all of which collapse to the same "no blob"
  // outcome by the time openAnnotator sees them) must say so and leave the drawing in place, not
  // close as if it worked.
  it("keeps the dialog open and says so when the drawing can't be saved, instead of discarding it silently", async () => {
    const canvas = fakeCanvas();
    canvas.toBlob = (cb) => cb(null);
    const { mount, onSave } = await open({ canvas });
    canvas.listeners.pointerdown({ clientX: 10, clientY: 20, preventDefault() {} });
    document.dispatchEvent(new window.Event("pointerup"));
    mount.querySelector("[data-save]").click();
    await vi.waitFor(() => expect(mount.textContent).toContain("could not be saved"));
    expect(onSave).not.toHaveBeenCalled();
    expect(mount.querySelector(".fbh-annotator")).not.toBe(null);
  });

  it("closes without saving when Escape is pressed, so a keyboard-only reporter can back out", async () => {
    const { mount, onSave } = await open();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(mount.querySelector(".fbh-annotator")).toBe(null);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("moves keyboard focus into the dialog when it opens", async () => {
    const { mount } = await open();
    expect(document.activeElement).toBe(mount.querySelector(".fbh-annotator"));
  });

  it("sets touch-action: none on the canvas so a touch drag draws instead of scrolling the page", async () => {
    const { canvas } = await open();
    expect(canvas.style.touchAction).toBe("none");
  });
});
