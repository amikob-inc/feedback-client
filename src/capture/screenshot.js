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
import { EDITABLE_SELECTOR } from "./replay.js";

// The picture's own list, and a deny-list where the recording's is an allow-list: rrweb keys
// masking on an input's `type`, so the recording names the kinds it masks (MASKABLE_INPUTS) and
// an unrecognised type — a typo, a framework's own, one newer than the list — slips through.
// A browser renders every unrecognised type as a text input and paints its value, so here the
// question is the other way round: which kinds carry no typed value at all. These six; every
// other kind is masked, `hidden` and `file` included (never painted, but the clone the picture is
// drawn from should not carry them either, the argument maskClonedPassword makes for passwords).
const NEVER_MASKED = new Set(["checkbox", "radio", "submit", "button", "reset", "image"]);
const stars = (text) => "*".repeat(String(text).length);

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

// Under `maskAllInputs` the picture masks at least what the recording masks — every typed value,
// a textarea's text, a select's options, editable text (EDITABLE_SELECTOR is the recording's own
// selector) — so a report cannot show in its picture what it withholds in its recording. For a
// select the picture is stricter: the recording keeps the option list as page content and masks
// only the select's value, while the picture paints the chosen option's text and masks it. Owner's decision, 2026-09-22 (plan Q3.1): the screenshot used to
// be the one part that showed typed values whatever the setting. Each value is replaced by the
// same number of asterisks, so the field keeps its width and the layout stays recognisable.
// modern-screenshot copies a field's live value onto the clone as a `value` attribute; a
// textarea paints its text content and a select its options' text, so those are masked as well.
export function maskClonedValue(cloned, maskAllInputs) {
  if (!maskAllInputs || !cloned || cloned.nodeType !== 1) return false;
  try {
    const tag = cloned.tagName;
    if (tag === "INPUT") {
      const type = String(cloned.getAttribute("type") || "text").toLowerCase();
      const value = cloned.getAttribute("value");
      if (NEVER_MASKED.has(type) || !value) return false;
      cloned.setAttribute("value", stars(value));
      return true;
    }
    if (tag === "TEXTAREA") {
      const value = cloned.getAttribute("value");
      if (value) cloned.setAttribute("value", stars(value));
      const text = cloned.textContent;
      if (text) cloned.textContent = stars(text);
      return !!(value || text);
    }
    if (tag === "SELECT") {
      let masked = false;
      const value = cloned.getAttribute("value");
      if (value) {
        cloned.setAttribute("value", stars(value));
        masked = true;
      }
      // The chosen option's text is what the picture paints; its `value` is not painted but is in
      // the clone the picture is drawn from, and there is no reason to keep it.
      for (const option of cloned.querySelectorAll("option")) {
        if (option.textContent) {
          option.textContent = stars(option.textContent);
          masked = true;
        }
        const optionValue = option.getAttribute("value");
        if (optionValue) option.setAttribute("value", stars(optionValue));
      }
      return masked;
    }
    if (typeof cloned.matches === "function" && cloned.matches(EDITABLE_SELECTOR)) {
      return maskTextNodes(cloned);
    }
  } catch {
    return false;
  }
  return false;
}

function maskTextNodes(root) {
  let masked = false;
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.nodeValue && child.nodeValue.trim()) {
          child.nodeValue = stars(child.nodeValue);
          masked = true;
        }
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(root);
  return masked;
}

export async function captureScreenshot({
  load = () => import("modern-screenshot"),
  target = document.body,
  hostId = HOST_ID,
  blank = [],
  maskAllInputs = false,
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
        if (hideBlanked(cloned, selector)) return;
        if (!maskClonedPassword(cloned)) maskClonedValue(cloned, maskAllInputs);
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
