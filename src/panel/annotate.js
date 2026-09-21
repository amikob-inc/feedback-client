// The red pen (spec §5.4, ported in spirit from the FWD dashboard's _fbAnnotate): draw on any
// attached image, undo, clear, and flatten at the image's own resolution so a mark the reporter
// drew lands on the same pixel the triage run looks at. The canvas on screen may be scaled down (a
// high-density display, a narrow panel); pointFrom always converts a client position back into
// image pixels via the canvas's own *displayed* CSS size, so strokes are resolution-independent —
// devicePixelRatio never appears in this file, deliberately, because getBoundingClientRect()
// already reports CSS pixels regardless of it, and multiplying by it again would double-count.
//
// This library may never break the host app (standing rule 4): every place a real canvas can
// legitimately fail — no 2D context, drawImage refusing a broken image, toBlob missing or
// returning null, a tainted canvas throwing synchronously, an image that never fires load *or*
// error — is caught here and turned into warnOnce() plus a graceful `null` / `{element: null}`,
// never an uncaught exception or a hung promise.
//
// jsdom has no real canvas, so tests/annotate.test.js stands a fake context/canvas in for "a
// browser that refuses" — see that file's own notes on what is and is not proven that way.
import { clear, el } from "./dom.js";
import { warnOnce } from "../warn.js";

export const PEN_COLOR = "#e5484d";

// jsdom's own behaviour, confirmed by hand while building this file: an <img> whose src is a
// blob: URL fires neither `load` nor `error` — it just hangs. A real browser could in principle do
// the same for a stalled decode. Either way, a promise this module hands the panel must always
// settle; the caller's UI depends on it (the "could not be opened" message can only show once the
// promise resolves).
export const IMAGE_LOAD_TIMEOUT_MS = 8000;

const WARN_LABEL = "annotator";

export function penWidth(imageWidth) {
  return Math.max(2, Math.round(imageWidth / 300));
}

export function createStrokes() {
  const strokes = [];
  let active = null;
  return {
    begin(point) {
      active = { color: PEN_COLOR, points: [point] };
      strokes.push(active);
    },
    extend(point) {
      if (active) active.points.push(point);
    },
    end() {
      // A tap with no movement is a dot: two identical points and a round cap draw a filled circle
      // instead of nothing at all.
      if (active && active.points.length === 1) active.points.push({ ...active.points[0] });
      active = null;
    },
    undo() {
      // Nothing to undo is a no-op, not an error — an empty array's pop() already is that.
      strokes.pop();
      active = null;
    },
    clear() {
      // Clearing mid-stroke (Clear activated while a pointer is still down, e.g. a stylus held
      // down and a keyboard-driven Clear at the same time) must also stop that stroke from
      // continuing to extend, not just empty the finished list.
      strokes.length = 0;
      active = null;
    },
    toArray() {
      return strokes.map((stroke) => ({ color: stroke.color, points: stroke.points.slice() }));
    },
    get length() {
      return strokes.length;
    },
    isDrawing() {
      return active !== null;
    },
  };
}

export function drawStrokes(ctx, strokes, width) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    ctx.strokeStyle = stroke.color;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
}

export function pointFrom(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  // rect is always in CSS pixels, independent of devicePixelRatio. canvas.width is the *backing*
  // resolution (set below to the image's own width/height, never the display size), so this ratio
  // is the only scale factor that belongs here, on any display density.
  const scaleX = rect.width ? canvas.width / rect.width : 1;
  const scaleY = rect.height ? canvas.height / rect.height : 1;
  return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
}

function hasSize(image) {
  return !!image && image.width > 0 && image.height > 0;
}

export function loadImageBlob(doc, blob, { timeoutMs = IMAGE_LOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const element = doc.createElement("img");
    let settled = false;
    const revoke = () => URL.revokeObjectURL(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      revoke();
      reject(new Error("the image took too long to load"));
    }, timeoutMs);
    element.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A decoded image with no pixels (a broken or empty source that still fires `load`) can't be
      // drawn on meaningfully, and on some engines drawImage/toBlob on a 0×0 canvas throws rather
      // than no-op — treated the same as any other unreadable image (rule 1: "an image of zero
      // size").
      if (!(element.naturalWidth > 0 && element.naturalHeight > 0)) {
        revoke();
        reject(new Error("the image has no size"));
        return;
      }
      resolve({ element, width: element.naturalWidth, height: element.naturalHeight, revoke });
    };
    element.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      revoke();
      reject(new Error("the image could not be read"));
    };
    element.src = url;
  });
}

function context2d(canvas) {
  try {
    return (canvas.getContext && canvas.getContext("2d")) || null;
  } catch (err) {
    warnOnce(WARN_LABEL, err);
    return null;
  }
}

function toPngBlob(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") {
      warnOnce(WARN_LABEL, new Error("canvas.toBlob is not available"));
      resolve(null);
      return;
    }
    try {
      canvas.toBlob((blob) => {
        if (!blob) warnOnce(WARN_LABEL, new Error("canvas.toBlob produced no blob"));
        resolve(blob || null);
      }, "image/png");
    } catch (err) {
      // A tainted canvas throws synchronously here rather than rejecting a promise.
      warnOnce(WARN_LABEL, err);
      resolve(null);
    }
  });
}

export async function flattenAnnotation({
  doc,
  image,
  strokes,
  makeCanvas = (d) => d.createElement("canvas"),
}) {
  if (!hasSize(image)) {
    warnOnce(WARN_LABEL, new Error("nothing to flatten: the image has no size"));
    return null;
  }
  const canvas = makeCanvas(doc);
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = context2d(canvas);
  if (!ctx) {
    warnOnce(WARN_LABEL, new Error("no 2D canvas context"));
    return null;
  }
  try {
    ctx.drawImage(image.element, 0, 0, image.width, image.height);
    drawStrokes(ctx, strokes, penWidth(image.width));
  } catch (err) {
    warnOnce(WARN_LABEL, err);
    return null;
  }
  return toPngBlob(canvas);
}

// Attaches `node` to `parent` only if it really is one — `makeCanvas` is an injectable seam and
// the fake canvas tests stand in with (jsdom has no working 2D context on a real <canvas> either,
// so every test already has to inject one) is a plain object, not a Node, and a real DOM's
// appendChild throws on that. A real `<canvas>` from `doc.createElement` always succeeds here;
// only a test double takes the empty branch, and the rest of the dialog is unaffected either way.
function appendIfNode(parent, node) {
  try {
    parent.appendChild(node);
  } catch {
    // Nothing to attach — see above.
  }
}

export async function openAnnotator({
  doc,
  blob,
  mount,
  onSave,
  onClose = () => {},
  loadImage = (d, b) => loadImageBlob(d, b),
  makeCanvas = (d) => d.createElement("canvas"),
}) {
  let image;
  try {
    image = await loadImage(doc, blob);
  } catch (err) {
    warnOnce(WARN_LABEL, err);
    return { element: null, close() {} };
  }
  if (!hasSize(image)) {
    // loadImageBlob already rejects a 0×0 image itself; this only guards a caller-supplied
    // `loadImage` override (tests, or a future alternate loader) that hands one back anyway.
    if (image.revoke) image.revoke();
    warnOnce(WARN_LABEL, new Error("nothing to draw on: the image has no size"));
    return { element: null, close() {} };
  }

  const canvas = makeCanvas(doc);
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.className = "fbh-annotator-canvas";
  // Without this, a touch drag on the canvas scrolls the page instead of drawing on most mobile
  // browsers; a mouse or pen is unaffected either way (rule 1: "a touch device with no mouse").
  if (canvas.style) canvas.style.touchAction = "none";
  const ctx = context2d(canvas);
  if (!ctx) {
    if (image.revoke) image.revoke();
    warnOnce(WARN_LABEL, new Error("no 2D canvas context"));
    return { element: null, close() {} };
  }

  const strokes = createStrokes();
  // The pointer id that owns the stroke in progress, or null when none does. A second pointer
  // going down mid-stroke (two fingers, a stylus while a finger is still on the glass) is ignored
  // rather than hijacking or interleaving with the first (rule 1: "two pointers at once").
  // event.pointerId is undefined for plain mouse events and for the synthetic events a test
  // dispatches, so undefined is always treated as "the" pointer rather than a stray second one.
  let activePointerId = null;

  function redraw() {
    try {
      ctx.drawImage(image.element, 0, 0, image.width, image.height);
      drawStrokes(ctx, strokes.toArray(), penWidth(image.width));
    } catch (err) {
      warnOnce(WARN_LABEL, err);
    }
  }

  function samePointer(event) {
    return (
      activePointerId === null ||
      event.pointerId === undefined ||
      event.pointerId === activePointerId
    );
  }

  function onDown(event) {
    if (strokes.isDrawing()) return; // a pointer is already down; a second one is ignored whole
    if (event.preventDefault) event.preventDefault();
    activePointerId = event.pointerId === undefined ? null : event.pointerId;
    strokes.begin(pointFrom(event, canvas));
    redraw();
  }
  function onMove(event) {
    if (!strokes.isDrawing() || !samePointer(event)) return;
    // Moving off the canvas and back is fine: these listeners are on `doc`, not the canvas, so a
    // stroke keeps extending by client position however far the pointer strays, same as any native
    // drawing app (rule 1: "a pointer that leaves the canvas mid-stroke and comes back"). The 2D
    // context clips drawing to the canvas's own bounds on its own; nothing here needs to.
    strokes.extend(pointFrom(event, canvas));
    redraw();
  }
  function onUp(event) {
    if (!strokes.isDrawing() || !samePointer(event)) return;
    strokes.end();
    activePointerId = null;
    redraw();
  }
  function onKeydown(event) {
    if (event.key === "Escape") close();
  }

  canvas.addEventListener("pointerdown", onDown);
  doc.addEventListener("pointermove", onMove);
  doc.addEventListener("pointerup", onUp);
  doc.addEventListener("keydown", onKeydown);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    canvas.removeEventListener("pointerdown", onDown);
    doc.removeEventListener("pointermove", onMove);
    doc.removeEventListener("pointerup", onUp);
    doc.removeEventListener("keydown", onKeydown);
    if (image.revoke) image.revoke();
    if (element.parentNode) element.parentNode.removeChild(element);
    onClose();
  }

  async function save() {
    const flattened = await flattenAnnotation({
      doc,
      image,
      strokes: strokes.toArray(),
      makeCanvas,
    });
    if (!flattened) {
      // Never silently discard a reporter's marks: an unrenderable canvas (an enormous image over
      // the browser's own limit, a tainted canvas, toBlob missing or refusing) stays open with an
      // announced reason instead of closing as if the save had worked.
      status.textContent = "That drawing could not be saved. You can try again or cancel.";
      return;
    }
    onSave(flattened);
    close();
  }

  const status = el(doc, "p", {
    class: "fbh-annotator-status",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  });

  const stage = el(doc, "div", { class: "fbh-annotator-stage" });
  appendIfNode(stage, canvas);
  // A screen reader gets this instead of trying to describe pixels; it also tells a keyboard-only
  // reporter, in so many words, what they can and cannot do here (rule 3): the marking itself needs
  // a pointer, everything else is an ordinary, labelled button.
  stage.appendChild(
    el(doc, "p", {
      class: "fbh-annotator-hint",
      text: "Draw with a mouse, pen or touch. Undo, Clear, Cancel and Save below work from the keyboard.",
    }),
  );

  const element = el(
    doc,
    "div",
    { class: "fbh-annotator", role: "dialog", "aria-label": "Draw on the image", tabindex: "-1" },
    [
      stage,
      el(doc, "div", { class: "fbh-annotator-actions" }, [
        el(doc, "button", {
          type: "button",
          class: "fbh-ghost",
          "data-undo": true,
          text: "Undo",
          onClick: () => {
            strokes.undo();
            redraw();
          },
        }),
        el(doc, "button", {
          type: "button",
          class: "fbh-ghost",
          "data-clear": true,
          text: "Clear",
          onClick: () => {
            strokes.clear();
            redraw();
          },
        }),
        el(doc, "button", {
          type: "button",
          class: "fbh-ghost",
          "data-cancel": true,
          text: "Cancel",
          onClick: close,
        }),
        el(doc, "button", {
          type: "button",
          class: "fbh-primary",
          "data-save": true,
          text: "Save",
          onClick: () => {
            save();
          },
        }),
      ]),
      status,
    ],
  );

  clear(mount);
  mount.appendChild(element);
  redraw();
  // Moves keyboard focus into the dialog it just opened, so a keyboard-only reporter isn't left
  // behind on whatever they activated to get here (rule 3) — the dialog itself is the sensible
  // landing spot since there is no single "first" control that reads better than the others.
  if (typeof element.focus === "function") element.focus();
  return { element, close };
}
