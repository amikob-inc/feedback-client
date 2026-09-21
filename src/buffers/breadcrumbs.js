// The breadcrumb buffer (spec §5.2): the last 100 things the reporter did — clicks, field
// changes, submits, route changes, tab visibility and going offline. This is the trail the triage
// run replays in prose before it looks at anything else, so a breadcrumb names the thing that was
// clicked rather than the pixel it was clicked at. Values are masked the same way the replay and
// the DOM snapshot mask them (spec §5.7); a route breadcrumb carries path and hash, never a query
// string.
import { Ring, cut } from "./ring.js";
import { warnOnce } from "../warn.js";

export const BREADCRUMBS_KEEP = 100;
export const CLICK_TEXT_MAX = 60;
export const VALUE_MAX = 40;
export const MASKED = "•••";
export const CLICK_TARGETS = "button, a, [role=button], [data-view]";
const DATA_ATTRIBUTES = 3;

export function describeClickTarget(el) {
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
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (text) out += ` '${cut(text, CLICK_TEXT_MAX)}'`;
  return out;
}

export function fieldLabel(el) {
  const labels = el.labels;
  if (labels && labels.length && labels[0].textContent) {
    const text = labels[0].textContent.replace(/\s+/g, " ").trim();
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
  return `${fieldLabel(el)} = ${fieldValue(el, opts)}`;
}

function closestTarget(node) {
  if (!node || typeof node.closest !== "function") return node;
  return node.closest(CLICK_TARGETS) || node;
}

export function installBreadcrumbBuffer({
  target = window,
  doc = target.document,
  now = () => new Date().toISOString(),
  maskAllInputs = false,
} = {}) {
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

  const path = () => `${target.location.pathname}${target.location.hash}`;
  const onClick = (e) => add("click", () => describeClickTarget(closestTarget(e.target)));
  const onChange = (e) => add("change", () => describeFieldChange(e.target, { maskAllInputs }));
  const onSubmit = (e) => add("submit", () => describeClickTarget(e.target));
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
