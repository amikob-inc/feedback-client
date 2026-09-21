// `capture.blank` is the app's list of CSS selectors for what must never be captured — the CAD
// dashboard points it at cost prices, margins and customer records. Two places consume it: the
// recorder's `blockSelector` and the breadcrumb describers. Both hand it to a selector engine,
// and both hand it over as **one comma-joined string**, which is what makes a typo dangerous
// rather than merely useless: `".price,div:has-bad((("` does not fail on the bad half, it fails
// as a whole, and rrweb's `_isBlockedElement` wraps `element.matches(blockSelector)` in a
// try/catch that swallows the SyntaxError and answers "no, not blocked"
// (record.js:790-808). One stray character in one dashboard's configuration therefore turned
// blocking off for every element on the page, for the whole recording, with no warning from
// rrweb and none of our own.
//
// So the list is checked selector by selector against the real engine before it is passed
// anywhere: the ones that parse are kept and keep working, the ones that do not are dropped and
// named in one warning. A privacy control that fails open must at least fail loudly.
import { noticeOnce } from "./warn.js";

// `doc.querySelector` is the cheapest way to ask the engine whether a selector parses, and this
// runs once per selector at mount rather than once per element.
export function usableSelectors(blank, doc) {
  const ok = [];
  const bad = [];
  const engine = doc && typeof doc.querySelector === "function" ? doc : null;
  for (const one of blank || []) {
    if (typeof one !== "string" || !one.trim()) continue;
    // No document at all: nothing to validate against, and no recorder or describer to protect
    // either, since both of them need a page. Keeping the list is what a caller with no DOM
    // (a unit test, a server-side import) expects; a browser never takes this branch.
    if (!engine) {
      ok.push(one);
      continue;
    }
    try {
      engine.querySelector(one);
      ok.push(one);
    } catch {
      bad.push(one);
    }
  }
  return { ok, bad };
}

// The joined string the two consumers pass on, with one warning naming whatever was dropped.
// Both consumers call this with the same list and the same label, so the app is told once rather
// than once per consumer (warnOnce is per label, for the life of the page).
export function blankSelector(blank, doc) {
  const { ok, bad } = usableSelectors(blank, doc);
  if (bad.length) {
    noticeOnce(
      "capture.blank",
      `${bad.length} selector${bad.length === 1 ? "" : "s"} the browser cannot parse, ignored: ${bad
        .map((one) => JSON.stringify(one))
        .join(", ")} — the other ${ok.length} still apply`,
    );
  }
  return ok.join(",");
}
