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

// A <template>'s children are never part of the normal tree: `.content` holds them in a detached
// DocumentFragment that querySelectorAll on the template (or any ancestor of it) does not descend
// into — but cloneNode(true)/.outerHTML copy that fragment in full, so anything the sanitising
// passes below (stampValues, script removal, blankElements) reach only via querySelectorAll would
// otherwise pass through untouched. `templateRoots` returns every scope that needs its own
// querySelectorAll call to be seen at all: the given root, plus every <template>'s `.content`
// found anywhere under it, applied recursively so a template nested inside another template's
// content is found too (the array grows while the loop walks it, so a newly appended content
// fragment is itself scanned for further nested templates on a later iteration).
function templateRoots(root) {
  const roots = [root];
  for (let i = 0; i < roots.length; i += 1) {
    const scope = roots[i];
    if (!scope.querySelectorAll) continue;
    for (const template of scope.querySelectorAll("template")) roots.push(template.content);
  }
  return roots;
}

function fieldsIn(roots) {
  const fields = [];
  for (const root of roots) fields.push(...root.querySelectorAll(FIELDS));
  return fields;
}

// contenteditable is an enumerated attribute: absent means "not this element" (it may still
// inherit editability from an ancestor, which is that ancestor's own contenteditable element and
// gets masked there), "false" opts out, and "", "true" and "plaintext-only" all mean editable.
function isEditableHost(el) {
  if (!el.hasAttribute("contenteditable")) return false;
  const value = el.getAttribute("contenteditable").trim().toLowerCase();
  return value === "" || value === "true" || value === "plaintext-only";
}

export function stampValues(live, clone, { maskAllInputs = false } = {}) {
  const liveRoots = templateRoots(live);
  const cloneRoots = templateRoots(clone);
  const liveFields = fieldsIn(liveRoots);
  const cloneFields = fieldsIn(cloneRoots);
  // Both root lists walk the same light-DOM shape the clone was made from (cloneNode(true)
  // preserves template nesting exactly), so they line up index for index — including skipping
  // shadow-root and <iframe> content identically, since neither call pierces either boundary.
  // Only the shorter length is trusted, in case the two ever disagree.
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
        // Which options a colleague ticked is exactly what maskAllInputs promises to withhold, so
        // under it the checked state is never carried over — not even the live "false" value.
        if (!maskAllInputs && from.checked) to.setAttribute("checked", "");
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

  // contenteditable holds what was typed as real child nodes, not a hidden `.value` property, so
  // cloneNode already carries it — the only work left is to clear it in the clone when
  // maskAllInputs asks for every field to be withheld. Scanned across the same template-aware
  // roots as everything else, so a contenteditable authored inside a <template> is covered too.
  if (maskAllInputs) {
    for (const root of cloneRoots) {
      for (const el of root.querySelectorAll("[contenteditable]")) {
        if (isEditableHost(el)) el.textContent = "";
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
  const tag = el.tagName && el.tagName.toLowerCase();
  if (tag === "input") {
    el.setAttribute("value", "");
    el.removeAttribute("checked");
  } else if (tag === "template" && el.content) {
    // `.textContent = ""` above only touches a <template>'s (always empty) light-DOM children;
    // its actual content lives in the detached `.content` fragment, which a selector matching the
    // <template> element directly — as opposed to matching an ancestor of one, already covered by
    // the ancestor's own textContent wipe removing the template node whole — would otherwise miss.
    while (el.content.firstChild) el.content.removeChild(el.content.firstChild);
  }
  el.setAttribute(BLANKED_ATTR, "");
}

export function blankElements(clone, selectors) {
  // Scanned across the template-aware roots too: a `blank` selector can match something authored
  // inside a <template>'s content just as easily as something in the normal tree, and that
  // content is invisible to a plain clone.querySelectorAll call.
  const roots = templateRoots(clone);
  for (const selector of selectors) {
    for (const root of roots) {
      let matches;
      try {
        matches = root.querySelectorAll(selector);
      } catch {
        break; // an invalid selector fails the same way on every root; stop trying this one
      }
      for (const el of matches) blankOne(el);
    }
  }
}

export function snapshotDom(doc, { maskAllInputs = false, blank = [] } = {}) {
  try {
    const root = doc.documentElement;
    const clone = root.cloneNode(true);
    stampValues(root, clone, { maskAllInputs });
    // Removed across the template-aware roots too, for the same reason as blankElements above: a
    // <script> planted inside a <template> is serialized by .outerHTML but is invisible to
    // clone.querySelectorAll("script") on its own.
    for (const scriptRoot of templateRoots(clone)) {
      for (const script of scriptRoot.querySelectorAll("script")) script.remove();
    }
    blankElements(clone, blank);
    return `<!doctype html>\n${clone.outerHTML}`;
  } catch (err) {
    warnOnce("dom snapshot", err);
    return undefined;
  }
}
