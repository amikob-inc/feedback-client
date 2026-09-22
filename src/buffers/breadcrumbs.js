// The breadcrumb buffer (spec §5.2): the last 100 things the reporter did — clicks, field
// changes, submits, route changes, tab visibility and going offline. This is the trail the triage
// run replays in prose before it looks at anything else, so a breadcrumb names the thing that was
// clicked rather than the pixel it was clicked at. Values are masked the same way the replay
// masks them (spec §5.7); a route breadcrumb carries path and hash, never a query string.
//
// A describer is a reader of the page, not just of an event: `describeClickTarget` takes an
// element's id, data attributes, aria-label and text, and `fieldLabel` takes a field's label,
// aria-label, placeholder and name. All of that is page content, so `capture.blank` — the
// selectors an app points at its cost prices and customer records — has to apply here exactly as
// it applies to the recording. It did not, until the marker harness planted a marker in the text
// of a button inside a blanked region and watched it come out in the report's breadcrumb trail
// (tests/leak-matrix.test.js, channel/click-text).
//
// That fix only covered one direction. `capture.blank` is checked with `closest`, which walks
// **up** to the nearest blanked ancestor; `textContent` and `el.labels` read **down** and
// **across**. So a blanked price inside a clicked card, inside a submitted form, or in a
// `<label for=…>` pointing at a field outside the region came back out verbatim (audit finding
// F1; channel/click-text-nested, channel/submit-text, channel/change-label-outside). The rule
// this file now holds to is the class, not the three instances: **no describer reads text out
// of, or through, an element the app asked to blank, whichever direction it arrives from.**
import { Ring, cut } from "./ring.js";
import { blankSelector } from "../selectors.js";
import { routePath } from "../url.js";
import { warnOnce } from "../warn.js";

export const BREADCRUMBS_KEEP = 100;
export const CLICK_TEXT_MAX = 60;
export const VALUE_MAX = 40;
export const MASKED = "•••";
export const CLICK_TARGETS = "button, a, [role=button], [data-view]";
const DATA_ATTRIBUTES = 3;

const flatten = (text) =>
  String(text || "")
    .replace(/\s+/g, " ")
    .trim();

// `closest` reads **up**; `textContent` reads **down**. A describer that mixes the two publishes
// a blanked price the moment the thing that was clicked is the card the price sits in rather than
// the price itself — which is the shape a card-based dashboard has, and which the ancestor check
// alone never sees. So an element's text is assembled from its own text nodes and those of its
// unblanked descendants: a blanked subtree is skipped whole, exactly as the recorder skips it,
// and the trail keeps whatever the element said around it ("Open ring", not "Open ring GBP
// 1,240"). With no blank selector, or with nothing blanked inside, this is `textContent` to the
// character — which is what keeps the ordinary case unchanged.
export function visibleText(el, blankSelector = "") {
  if (!el) return "";
  if (!blankSelector || !containsBlanked(el, blankSelector)) return flatten(el.textContent);
  const parts = [];
  collectText(el, blankSelector, parts);
  return flatten(parts.join(" "));
}

function containsBlanked(el, selector) {
  try {
    return typeof el.querySelector === "function" && !!el.querySelector(selector);
  } catch {
    return false;
  }
}

function collectText(node, selector, parts) {
  for (const child of node.childNodes || []) {
    if (child.nodeType === 3) parts.push(child.nodeValue || "");
    else if (child.nodeType === 1 && !matchesBlank(child, selector)) {
      collectText(child, selector, parts);
    }
  }
}

function matchesBlank(el, selector) {
  try {
    return typeof el.matches === "function" && el.matches(selector);
  } catch {
    return false;
  }
}

export function describeClickTarget(el, { blankSelector = "" } = {}) {
  if (!el || !el.tagName) return "";
  let out = el.tagName.toLowerCase();
  if (el.id) out += `#${el.id}`;
  const data = [];
  for (const attr of el.attributes || []) {
    if (data.length >= DATA_ATTRIBUTES) break;
    if (attr.name.startsWith("data-")) data.push(`[${attr.name}="${attr.value}"]`);
  }
  out += data.join("");
  const aria = typeof el.getAttribute === "function" ? el.getAttribute("aria-label") : null;
  if (aria) out += ` aria-label="${aria}"`;
  const text = visibleText(el, blankSelector);
  if (text) out += ` '${cut(text, CLICK_TEXT_MAX)}'`;
  return out;
}

export function fieldLabel(el, { blankSelector = "" } = {}) {
  const labels = el.labels;
  // `el.labels` resolves a `<label for=…>` anywhere in the document, so a field in ordinary page
  // content can be labelled from inside a blanked region. The label is a page element like any
  // other and goes through the same two checks the click target gets — is it blanked, and does it
  // contain anything blanked — before a character of it is read.
  if (labels && labels.length && !isBlankedElement(labels[0], blankSelector)) {
    const text = visibleText(labels[0], blankSelector);
    if (text) return text;
  }
  const aria = typeof el.getAttribute === "function" ? el.getAttribute("aria-label") : null;
  if (aria) return aria;
  const placeholder = typeof el.getAttribute === "function" ? el.getAttribute("placeholder") : null;
  if (placeholder) return placeholder;
  if (el.name) return el.name;
  return el.tagName.toLowerCase();
}

// fieldValue is judged on its ugly inputs, not its tidy ones (task standing rules): a checkbox
// has no "value" worth recording (handled below by state instead), a file input's `.value` is
// never safe to record even though the browser already fakes it into something that looks
// harmless, and a `<select multiple>`'s `.value` is only its *first* selected option — silently
// dropping the rest would misdescribe the field rather than just under-describe it.
export function fieldValue(el, { maskAllInputs = false } = {}) {
  const type = String(el.type || "text").toLowerCase();
  if (type === "checkbox" || type === "radio") return el.checked ? "checked" : "unchecked";
  if (type === "file") {
    // A file input's `.value` is a fixed fake path ("C:\fakepath\...") the browser substitutes
    // specifically so script can't read the real one back — but the fake path still names the
    // file, which is exactly what "never record a file's path" (spec §5.2) rules out. `.files` is
    // the FileList; report only how many were chosen, never a name or a path.
    if (maskAllInputs) return MASKED;
    const count = el.files ? el.files.length : 0;
    return count === 1 ? "1 file" : `${count} files`;
  }
  if (type === "password" || maskAllInputs) return MASKED;
  if (type === "select-multiple") {
    const values = (el.selectedOptions ? Array.from(el.selectedOptions) : []).map((opt) =>
      opt.value !== "" ? opt.value : opt.text,
    );
    return `'${cut(values.join(", "), VALUE_MAX)}'`;
  }
  return `'${cut(el.value === undefined || el.value === null ? "" : String(el.value), VALUE_MAX)}'`;
}

export function describeFieldChange(el, opts) {
  if (!el || !el.tagName) return "";
  return `${fieldLabel(el, opts)} = ${fieldValue(el, opts)}`;
}

function closestTarget(node) {
  if (!node || typeof node.closest !== "function") return node;
  return node.closest(CLICK_TARGETS) || node;
}

// What a blanked element gets described as: enough to read the trail ("they clicked a button,
// then changed a field"), nothing of what the element said. The tag name is markup, not data.
export function hiddenTarget(el) {
  return el && el.tagName ? `${el.tagName.toLowerCase()} (hidden)` : "(hidden)";
}

// `closest` walks up from the element itself, so this covers both the blanked element and
// everything inside it — the same reach `blockSelector` has in the recording.
export function isBlankedElement(el, selector) {
  if (!selector || !el || typeof el.closest !== "function") return false;
  try {
    return !!el.closest(selector);
  } catch {
    return false;
  }
}

export function installBreadcrumbBuffer({
  target = window,
  doc = target.document,
  now = () => new Date().toISOString(),
  maskAllInputs = false,
  blank = [],
} = {}) {
  // Unusable entries dropped rather than the whole list, and named once: the same check the
  // recorder's blockSelector now gets (src/selectors.js).
  const selector = blankSelector(blank, doc);
  const isBlanked = (el) => isBlankedElement(el, selector);
  const ring = new Ring(BREADCRUMBS_KEEP);
  // Every breadcrumb, whatever kind, is recorded through this one function, and everything that
  // can fail — reading `now()`, describing the target/field/route, pushing onto the ring — is
  // inside its try. That is what lets every listener below stay a one-line call into `add`
  // without its own guard, and it is what makes the history patch below safe (see the comment
  // there): `add` itself can never throw back out to a caller.
  const add = (kind, describe) => {
    try {
      ring.push({ t: now(), kind, target: describe() });
    } catch (err) {
      warnOnce("breadcrumb buffer", err);
    }
  };

  const path = () => routePath(target.location);
  const describe = (el, full) => (isBlanked(el) ? hiddenTarget(el) : full(el));
  // Both checks, in both directions, for all three describers: `describe` refuses an element at
  // or inside a blanked one, and `blankSelector` goes on to the describer so it also refuses to
  // read down into one.
  const onClick = (e) =>
    add("click", () =>
      describe(closestTarget(e.target), (el) =>
        describeClickTarget(el, { blankSelector: selector }),
      ),
    );
  const onChange = (e) =>
    add("change", () =>
      describe(e.target, (el) =>
        describeFieldChange(el, { maskAllInputs, blankSelector: selector }),
      ),
    );
  const onSubmit = (e) =>
    add("submit", () =>
      describe(e.target, (el) => describeClickTarget(el, { blankSelector: selector })),
    );
  const onRoute = () => add("route", path);
  const onVisibility = () => add("visibility", () => doc.visibilityState);
  const onOnline = () => add("connection", () => "online");
  const onOffline = () => add("connection", () => "offline");

  doc.addEventListener("click", onClick, true);
  doc.addEventListener("change", onChange, true);
  doc.addEventListener("submit", onSubmit, true);
  doc.addEventListener("visibilitychange", onVisibility);
  target.addEventListener("hashchange", onRoute);
  target.addEventListener("popstate", onRoute);
  target.addEventListener("online", onOnline);
  target.addEventListener("offline", onOffline);

  // pushState/replaceState fire no event of their own, so patching them is the only way to see a
  // route change they cause — same situation as fetch/XHR in the network buffer. The original is
  // always called first, so the host's navigation always happens whatever `add` does afterwards;
  // and `add` itself cannot throw (see above), so this never turns a working pushState call into
  // one that throws back at the caller.
  const history = target.history;
  const originalPush = history && history.pushState;
  const originalReplace = history && history.replaceState;
  let patchedPush;
  let patchedReplace;
  if (originalPush) {
    patchedPush = function patchedPushState(...args) {
      const result = originalPush.apply(this, args);
      onRoute();
      return result;
    };
    history.pushState = patchedPush;
  }
  if (originalReplace) {
    patchedReplace = function patchedReplaceState(...args) {
      const result = originalReplace.apply(this, args);
      onRoute();
      return result;
    };
    history.replaceState = patchedReplace;
  }

  return {
    entries: () => ring.toArray(),
    uninstall() {
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("change", onChange, true);
      doc.removeEventListener("submit", onSubmit, true);
      doc.removeEventListener("visibilitychange", onVisibility);
      target.removeEventListener("hashchange", onRoute);
      target.removeEventListener("popstate", onRoute);
      target.removeEventListener("online", onOnline);
      target.removeEventListener("offline", onOffline);
      // Restore only the functions this instance still owns. If the app (or another library)
      // patched history again after this buffer installed, that patch is not ours to discard —
      // the same rule the console and network buffers' uninstall follow.
      if (originalPush && history.pushState === patchedPush) history.pushState = originalPush;
      if (originalReplace && history.replaceState === patchedReplace) {
        history.replaceState = originalReplace;
      }
    },
  };
}
