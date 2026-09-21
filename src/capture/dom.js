// The DOM snapshot (spec §5.3): a clone of the live document with what the user typed stamped
// into attributes — `cloneNode` copies the markup, not the values, so a form in the snapshot
// would otherwise look empty. Passwords are always blanked, every field is blanked under
// maskAllInputs, `<script>` elements are dropped (the snapshot is opened as a file, never run)
// and the app's `blank` selectors are emptied (spec §5.7).
//
// The live page is never modified: only the detached clone is ever written to, and the clone is
// never attached to any document, so an `<iframe>`'s `src` is never (re)loaded by cloning it.
// Neither `cloneNode` nor `.outerHTML` ever reaches into an `<iframe>`'s content document (same-
// or cross-origin) or into a shadow root's content — both are simply absent from the clone, which
// is what "never reach into either" comes down to in practice: nothing here ever touches
// `contentDocument`/`contentWindow` or a shadow root at all.
//
// snapshotDom must never throw into a host app that is still running on the live page it just
// cloned: any failure — a hostile cloneNode, a detached documentElement, anything else this file
// didn't anticipate — is caught, warned once, and answered with undefined instead of an
// exception.
import { warnOnce } from "../warn.js";

export const BLANKED_ATTR = "data-fbh-blanked";
const FIELDS = "input, textarea, select";

export function stampValues(live, clone, { maskAllInputs = false } = {}) {
  const liveFields = live.querySelectorAll(FIELDS);
  const cloneFields = clone.querySelectorAll(FIELDS);
  // Both calls walk the same light-DOM shape the clone was made from, so they line up index for
  // index — including skipping shadow-root and <iframe> content identically, since neither call
  // pierces either boundary. Only the shorter length is trusted, in case the two ever disagree.
  const count = Math.min(liveFields.length, cloneFields.length);
  for (let i = 0; i < count; i += 1) {
    const from = liveFields[i];
    const to = cloneFields[i];
    const tag = from.tagName.toLowerCase();
    if (tag === "input") {
      // `.type` is a spec-reflected IDL attribute: it tracks the content attribute whether that
      // attribute was set in markup or the property was assigned by script after the element
      // already existed, and it normalizes an unrecognized value to "text" instead of echoing
      // back an arbitrary string. Reading it here (not getAttribute) is what keeps a password
      // whose type is flipped by script after render correctly masked.
      const type = String(from.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (from.checked) to.setAttribute("checked", "");
        else to.removeAttribute("checked");
        continue;
      }
      const masked = type === "password" || maskAllInputs;
      to.setAttribute("value", masked ? "" : String(from.value ?? ""));
    } else if (tag === "textarea") {
      to.textContent = maskAllInputs ? "" : String(from.value ?? "");
    } else {
      const options = to.querySelectorAll("option");
      for (let j = 0; j < options.length; j += 1) {
        if (!maskAllInputs && j === from.selectedIndex) options[j].setAttribute("selected", "");
        else options[j].removeAttribute("selected");
      }
    }
  }
}

// `blank` selectors (spec §5.7) must hide a value completely, not just its rendered text. A
// selector that matches an *ancestor* of a sensitive field is already covered by clearing
// textContent — for a normal element that replaces every child, the sensitive field included, so
// its attributes leave with it. A selector that matches an `<input>` directly is not covered by
// that: `<input>` is a void element (it can carry no children in HTML, so clearing its
// textContent is a no-op) and the value the user typed lives in the `value` attribute
// `stampValues` just stamped in, plus `checked` for a box or radio. Both are cleared explicitly
// so a `blank` selector aimed straight at a field can't leave its value sitting in an attribute
// while the element looks empty.
function blankOne(el) {
  el.textContent = "";
  if (el.tagName && el.tagName.toLowerCase() === "input") {
    el.setAttribute("value", "");
    el.removeAttribute("checked");
  }
  el.setAttribute(BLANKED_ATTR, "");
}

export function blankElements(clone, selectors) {
  for (const selector of selectors) {
    let matches;
    try {
      matches = clone.querySelectorAll(selector);
    } catch {
      continue; // a selector the app got wrong must not cost the whole snapshot
    }
    for (const el of matches) blankOne(el);
  }
}

export function snapshotDom(doc, { maskAllInputs = false, blank = [] } = {}) {
  try {
    const root = doc.documentElement;
    const clone = root.cloneNode(true);
    stampValues(root, clone, { maskAllInputs });
    for (const script of clone.querySelectorAll("script")) script.remove();
    blankElements(clone, blank);
    return `<!doctype html>\n${clone.outerHTML}`;
  } catch (err) {
    warnOnce("dom snapshot", err);
    return undefined;
  }
}
