// What the automatic screenshot captures: the viewport, not the page (v0.2.0). Loaded with the
// screenshot module, on demand, never on page load.
//
// Why. modern-screenshot clones every element under the target and, for each one, reads its
// computed style, diffs it against a default over some six hundred properties and writes the
// difference onto the clone as inline style — then again for `::before` and `::after` — all in
// one task that never yields, then serialises the clone into an SVG and rasterises it. On a
// dashboard page with a few hundred cards that is a multi-second freeze the moment the panel
// opens (measured on cad-dashboard's Rings view: 17 s of clone and 7 s of raster for 60 cards on
// a slow machine, growing with the page), and a picture the library then throws away because the
// SVG did not decode inside its five-second wait. The reporter saw one screen; that is what the
// report needs.
//
// Two levers, together a 13× shorter stall in that measurement, and a cost that no longer grows
// with the page:
//
//   1. `filter`: an element entirely outside the viewport keeps its box — the clone copies its
//      computed width and height in pixels, so the layout around it does not move — but loses
//      its subtree, and the walk never enters it. The SVG is the viewport's size and shifted by
//      the scroll, so the picture is the screen as it was.
//   2. `includeStyleProperties`: only the properties that shape and paint a box are compared and
//      copied, not all six hundred.
//
// A scrolled container inside the page (a modal's body, a table) is a static clone that starts at
// its top; its offset is written onto the original as a data attribute for the length of the
// capture and applied to the clone's children as a transform (applyScrollOffset), so what was
// scrolled into view is what the picture shows there too.
//
// Known limits, accepted for a bug report's picture: an absolutely positioned element more than
// one level below an off-screen box is not reached (its ancestor's subtree is not walked), and a
// property outside the list below is not copied.

export const HOST_ID = "fbh-host";
export const SCROLL_ATTRIBUTE = "data-fbh-scroll";

// The properties that decide where a box is, how big it is and what it paints. Shorthands are
// left out on purpose: the computed style holds longhands, and a shorthand read back from it is
// often empty.
export const SCREENSHOT_STYLE_PROPERTIES = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "float",
  "clear",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "aspect-ratio",
  "box-sizing",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "border-collapse",
  "border-spacing",
  "table-layout",
  "outline-width",
  "outline-style",
  "outline-color",
  "outline-offset",
  "box-shadow",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "background-repeat",
  "background-clip",
  "background-origin",
  "-webkit-background-clip",
  "-webkit-text-fill-color",
  "color",
  "opacity",
  "visibility",
  "overflow-x",
  "overflow-y",
  "clip-path",
  "filter",
  "backdrop-filter",
  "mix-blend-mode",
  "transform",
  "transform-origin",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "font-feature-settings",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-indent",
  "text-transform",
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-color",
  "text-shadow",
  "text-overflow",
  "white-space",
  "word-break",
  "overflow-wrap",
  "hyphens",
  "direction",
  "unicode-bidi",
  "writing-mode",
  "vertical-align",
  "-webkit-line-clamp",
  "-webkit-box-orient",
  "list-style-type",
  "list-style-position",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "justify-content",
  "justify-items",
  "justify-self",
  "align-items",
  "align-content",
  "align-self",
  "order",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "grid-template-rows",
  "grid-template-areas",
  "grid-auto-flow",
  "grid-auto-columns",
  "grid-auto-rows",
  "grid-column-start",
  "grid-column-end",
  "grid-row-start",
  "grid-row-end",
  "column-count",
  "object-fit",
  "object-position",
  "image-rendering",
  "appearance",
  "cursor",
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "paint-order",
  "dominant-baseline",
  "text-anchor",
  "vector-effect",
];

function defaultRect(node) {
  return typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
}

// Whether the element has a box at all: `display: none` and `display: contents` have none. A
// rendered box of zero size (a container of floats, an empty inline) still has one.
function defaultRendered(node) {
  return typeof node.getClientRects === "function" ? node.getClientRects().length > 0 : false;
}

const px = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

// The options that make modern-screenshot capture the viewport of `target`'s window: the SVG's
// size, the shift that puts the screen's top edge at the top of the picture, the filter that
// keeps the walk on screen, and the property list. `rectOf` and `isRendered` are seams for
// tests, which have no layout.
//
// The shift is not the scroll offset. The clone does not lay out exactly like the page — the
// library rewrites some elements (an iframe becomes a block of its document's body, and so on),
// so a clone's content can be taller than the page's by the time the screen's region is reached,
// and a shift by the scroll offset then shows the wrong region. Instead every child of the target
// that is entirely off screen is dropped, not kept as a placeholder, so nothing above the screen
// is laid out at all; the first child in normal flow that is on screen becomes the anchor, sitting
// in the clone at the root's padding plus its own top margin, and the shift is what moves that
// edge to where the anchor was on screen. Whatever drift is left is inside the anchor itself.
//
// The root clone's height is released from the SVG's (`onCloneNode`): forced to the viewport's
// height, its background would cover only that much and the shifted region below it would paint
// on nothing.
export function viewportOptions(
  target,
  { hostId = HOST_ID, rectOf = defaultRect, isRendered = defaultRendered } = {},
) {
  const doc = (target && target.ownerDocument) || globalThis.document;
  const win = (doc && doc.defaultView) || globalThis.window;
  const width = win.innerWidth || 0;
  const height = win.innerHeight || 0;
  const scrollX = win.scrollX || 0;
  const rects = new WeakMap();
  const rect = (node) => {
    if (rects.has(node)) return rects.get(node);
    let r;
    try {
      r = rectOf(node);
    } catch {
      r = null;
    }
    rects.set(node, r);
    return r;
  };
  // An unknown rect (a node with no layout API) counts as on screen: the safe answer is to keep.
  const outside = (r) =>
    !!r && (r.bottom <= 0 || r.top >= height || r.right <= 0 || r.left >= width);
  const computed = (node) => {
    try {
      return win.getComputedStyle(node);
    } catch {
      return null;
    }
  };
  const rendered = (node) => {
    try {
      return isRendered(node);
    } catch {
      return true;
    }
  };
  // No box is either not rendered (`display: none`) or a `display: contents` wrapper whose
  // children paint on their own; only the second is worth walking into, and it has no box to
  // judge, so its children are judged on their own.
  const isContents = (node) => {
    const style = computed(node);
    return !!style && style.display === "contents";
  };
  const unrendered = (node) => !rendered(node) && !isContents(node);
  let layout = false;
  try {
    layout = !!target && isRendered(target);
  } catch {
    layout = false;
  }

  function filter(node) {
    if (!node || node.nodeType !== 1) return true;
    if (node.id === hostId) return false;
    if (!layout || node === target) return true;
    if (!rendered(node)) return isContents(node);
    const r = rect(node);
    if (!outside(r)) return true;
    // Off screen. Directly under the target it goes altogether (see above). Deeper, its box stays
    // when its parent is on screen, holding the layout in place; anything below is neither
    // cloned nor visited.
    const parent = node.parentElement;
    if (!parent || parent === target) return false;
    return !outside(rect(parent));
  }

  if (!layout) {
    return { width, height, filter, includeStyleProperties: SCREENSHOT_STYLE_PROPERTIES };
  }

  let shiftY = 0;
  const rootStyle = computed(target);
  const inset = rootStyle ? px(rootStyle.paddingTop) + px(rootStyle.borderTopWidth) : 0;
  for (const child of target.children || []) {
    if (child.id === hostId || unrendered(child)) continue;
    const r = rect(child);
    if (!r || outside(r)) continue;
    const style = computed(child);
    if (style && (style.position === "absolute" || style.position === "fixed")) continue;
    // Whole pixels: a computed margin in ems against a rounded rect leaves noise of a hundredth.
    shiftY = Math.round(r.top - inset - (style ? px(style.marginTop) : 0));
    break;
  }

  return {
    width,
    height,
    style: { transform: `translate(${-scrollX}px, ${shiftY}px)` },
    filter,
    includeStyleProperties: SCREENSHOT_STYLE_PROPERTIES,
    onCloneNode: (clone) => {
      if (clone && clone.style) clone.style.setProperty("height", "auto", "important");
    },
  };
}

// Writes every scrolled element's offset onto it for the length of the capture. Returns the
// function that takes the marks off again; the caller runs it in a `finally`.
export function markScrolled(target) {
  const marked = [];
  if (!target || typeof target.querySelectorAll !== "function") return () => {};
  const doc = target.ownerDocument || globalThis.document;
  const scroller = doc && doc.scrollingElement;
  try {
    for (const node of target.querySelectorAll("*")) {
      if (node === scroller) continue;
      const x = node.scrollLeft || 0;
      const y = node.scrollTop || 0;
      if (!x && !y) continue;
      node.setAttribute(SCROLL_ATTRIBUTE, `${x},${y}`);
      marked.push(node);
    }
  } catch {
    // A node that refuses the attribute is left unmarked; its clone starts at its top.
  }
  return () => {
    for (const node of marked) {
      try {
        node.removeAttribute(SCROLL_ATTRIBUTE);
      } catch {
        // Already gone, or read-only: nothing to take back.
      }
    }
  };
}

// On a cloned element that carries the mark: shift its children by the offset and drop the mark
// from the clone. Called from the capture's `onCloneEachNode`, after the children are cloned.
export function applyScrollOffset(cloned) {
  if (!cloned || cloned.nodeType !== 1 || typeof cloned.getAttribute !== "function") return false;
  const mark = cloned.getAttribute(SCROLL_ATTRIBUTE);
  if (!mark) return false;
  cloned.removeAttribute(SCROLL_ATTRIBUTE);
  const [x, y] = mark.split(",").map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const shift = `translate(${-x}px, ${-y}px)`;
  for (const child of cloned.children) {
    if (!child.style) continue;
    const own = child.style.transform;
    child.style.transform = own && own !== "none" ? `${shift} ${own}` : shift;
  }
  return true;
}
