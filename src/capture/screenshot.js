// The automatic screenshot (spec §5.3): modern-screenshot's domToBlob, imported only when a
// screenshot is actually taken. Three things beyond the spec's literal call: the panel's own host
// element is filtered out (it is on the page by the time the panel asks for a capture, and a
// screenshot of the report form helps nobody), a capture over the hub's 5 MB cap is dropped here
// rather than rejected there, and — the part that took an audit to notice — `capture.blank`
// applies here too.
//
// It did not until now. `capture.screenshot` defaults to **true**, and this is the
// highest-fidelity copy of the page the library sends: a raster of every cost price, margin and
// customer record on screen. The recording blocked what the app named in `capture.blank` and the
// breadcrumb trail withheld it, while the picture beside them showed all of it. What the app asked
// not to send must not be legible in the picture either.
//
// How, and why this way. `filter` excludes a node *and its box*, so filtering a blanked element
// out reflows everything after it and the screenshot stops being a picture of what the reporter
// saw. `visibility: hidden` on the clone does not work either: modern-screenshot copies each
// node's computed style onto its clone as inline style, so every descendant carries an explicit
// `visibility: visible` that overrides the ancestor. What does work is keeping the element, with
// the box styles already copied onto it, and taking its content away: children, the attributes
// that paint (`value`, `src`, `alt`, …), and the class, which is what modern-screenshot's copied
// `::before`/`::after` rules attach to. The layout stays recognisable; nothing in the blanked
// region is readable.
import { blankSelector } from "../selectors.js";
import { warnOnce } from "../warn.js";

export const SCREENSHOT_MAX = 5 * 1024 * 1024;
export const HOST_ID = "fbh-host";

// Attributes that put content on screen without a child node to hold it. `style` is deliberately
// not here: it is what keeps the emptied element's box.
export const CONTENT_ATTRIBUTES = [
  "value",
  "src",
  "srcset",
  "srcdoc",
  "poster",
  "alt",
  "title",
  "placeholder",
  "label",
  "aria-label",
  "data",
  "href",
];

// Called on every cloned node, after its children have been cloned onto it. Returns whether this
// node was one the app asked to blank, which is what the tests assert on.
export function hideBlanked(cloned, selector) {
  if (!selector || !cloned || cloned.nodeType !== 1) return false;
  let match;
  try {
    match = typeof cloned.matches === "function" && cloned.matches(selector);
  } catch {
    return false;
  }
  if (!match) return false;
  try {
    while (cloned.firstChild) cloned.removeChild(cloned.firstChild);
    for (const name of CONTENT_ATTRIBUTES) cloned.removeAttribute(name);
    // The generated class modern-screenshot hangs a copied `::after { content: … }` rule on. A
    // dashboard that paints a price through `content: attr(data-cost)` would otherwise keep it.
    cloned.removeAttribute("class");
  } catch (err) {
    // A clone that will not be emptied must not take the whole capture down with it; the filter
    // below is the backstop only for the panel's own host, so say so and carry on.
    warnOnce("screenshot blanking", err);
  }
  return true;
}

// A password input renders as dots, so the picture never shows one — but the clone the picture is
// drawn from carries the live value, because modern-screenshot copies it onto the clone as a
// `value` attribute. Masking it costs the picture nothing (the same number of dots) and keeps "a
// password never leaves, under any settings" true of the intermediate as well as of the parts
// that are actually sent.
export function maskClonedPassword(cloned) {
  if (!cloned || cloned.nodeType !== 1 || cloned.tagName !== "INPUT") return false;
  try {
    if (String(cloned.getAttribute("type") || "").toLowerCase() !== "password") return false;
    const value = cloned.getAttribute("value");
    if (!value) return false;
    cloned.setAttribute("value", "*".repeat(value.length));
    return true;
  } catch {
    return false;
  }
}

export async function captureScreenshot({
  load = () => import("modern-screenshot"),
  target = document.body,
  hostId = HOST_ID,
  blank = [],
} = {}) {
  try {
    const doc = (target && target.ownerDocument) || globalThis.document;
    const selector = blankSelector(blank, doc);
    const { domToBlob } = await load();
    const blob = await domToBlob(target, {
      scale: 1,
      timeout: 5000,
      filter: (node) => !(node && node.nodeType === 1 && node.id === hostId),
      onCloneEachNode: (cloned) => {
        if (!hideBlanked(cloned, selector)) maskClonedPassword(cloned);
      },
    });
    if (!blob) return null;
    if (blob.size > SCREENSHOT_MAX) {
      warnOnce("screenshot", new Error(`the capture is ${blob.size} bytes, over the 5 MB cap`));
      return null;
    }
    return blob;
  } catch (err) {
    warnOnce("screenshot", err);
    return null;
  }
}
