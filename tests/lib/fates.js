// What each planted marker is supposed to do, and why.
//
// A harness that only asserts "nothing leaks" is switched off the first time something legitimately
// appears — a session replay exists to reproduce a page, so plenty of page content is published on
// purpose. So every position gets a fate instead, and the harness asserts both directions: a
// `withheld` position that appears is a leak, and a `published` position that does not appear means
// the capture (or the harness) has quietly stopped working. Both are failures.
//
// Three things decide a fate, in this order:
//
//  1. POLICY — what the library promises. Passwords never leave, whatever the settings. Anything
//     the app named in `capture.blank` never leaves. Field values do not leave under
//     `maskAllInputs`. The reporter's own words always leave.
//  2. MECHANISM — what the capture path structurally cannot see. rrweb never serialises a
//     `<template>`'s content fragment, for instance. These are not promises, they are facts about
//     the implementation, and each is written down with the reason it holds. If a future rrweb
//     starts serialising one of them, the position flips from absent to present and this harness
//     goes red — which is the point of recording them rather than ignoring them.
//  3. GAP — something that is published today, that someone might reasonably expect not to be,
//     and that this library has decided not to close. Each one is an entry here with a one-line
//     reason and a pointer to the report. A gap asserts `published`, so the harness stays green
//     while the gap is open and goes red the moment it closes (and someone then deletes the
//     entry) or a *new* one appears.
//
// What is NOT in this file: anything this library can close. That used to mean "anything an rrweb
// option reaches", which let three findings sit here as gaps although the emit callback could
// have closed all three — `scrubReplayEvent` post-processes every event rrweb hands over, and is
// as much a lever as an option is. The bar is now what the library can do, not what rrweb offers.
import { BLANK_SELECTOR } from "./markers.js";

// --------------------------------------------------------------------------------------------
// Mechanisms: things the capture path cannot see, each with the reason it cannot.

const MECHANISMS = [
  {
    id: "template-content",
    match: (p) => /\/template(-deep)?\//.test(p.id),
    why: "rrweb walks childNodes, and a <template>'s children live in its .content fragment, which is not among them",
  },
  {
    id: "closed-shadow-root",
    match: (p) => p.id.includes("/shadow-closed/"),
    why: "a closed shadow root is not reachable through element.shadowRoot, so rrweb never sees it",
  },
  {
    id: "script-text",
    match: (p) => p.id.startsWith("script-text/"),
    why: 'rrweb replaces every <script> text node with the literal "SCRIPT_PLACEHOLDER", and slimDOMOptions.script drops the element as well',
  },
  {
    id: "script-element",
    match: (p) => p.id.startsWith("attr/script-data/"),
    why: "slimDOMOptions.script drops <script> elements, attributes and all",
  },
  {
    id: "comment-dropped",
    match: (p) => p.id.startsWith("comment/"),
    why: "slimDOMOptions.comment drops comment nodes",
  },
  {
    id: "css-comment",
    match: (p) => p.id.startsWith("rawtext/style/"),
    why: "rrweb re-serialises a <style> from its CSSOM rules, which drops CSS comments",
  },
  {
    id: "value-sanitised",
    match: (p) => /^input\/(color|range)\//.test(p.id),
    why: "the browser replaces an invalid value for these types with a normalised one, so the raw attribute never reaches the recorder",
  },
  {
    id: "head-meta-dropped",
    match: (p) => p.id.startsWith("attr/meta-csrf/"),
    why: "slimDOMOptions.headMetaVerification drops a <meta name=csrf-token> outright. A <meta> with no name rrweb recognises is not dropped, and is ordinary markup",
  },
  {
    id: "value-rejected",
    match: (p) => /^input\/(number|date|datetime-local|month|week|time)\/property\//.test(p.id),
    // Not a privacy property: it is why this position cannot hold a marker at all, and saying so
    // here is what stops it being mistaken for masking that works.
    why: "assigning a value that is not valid for these input types leaves the live value empty, so there is nothing in the DOM for the recorder to find",
  },
];

// --------------------------------------------------------------------------------------------
// Gaps: published today, should not be, and nothing we can do reaches it. Every entry is a
// finding in .superpowers/sdd/2026-09-21-mission-16-client-library/harness-fix-report.md.
//
// The three the first report listed here are gone. They were described as "cannot be closed by
// configuration", which was true and beside the point: no rrweb *option* reaches them, but this
// library post-processes rrweb's output in its own emit callback — that is what `scrubReplayEvent`
// is — and all three are closed there now (an <iframe srcdoc>, the class a blocked element keeps,
// and a field's raw `value=` when the live value is empty). Their positions assert `withheld` like
// any other, which is what a closed gap looks like here.

// The one gap the first report kept — a field's typed value in the automatic screenshot — closed
// on 2026-09-22 (plan Q3.1): under maskAllInputs the picture masks at least what the recording
// masks. Three things worth knowing that are not positions:
//   - A <select>: the picture masks the chosen option's text (what it paints); the recording
//     keeps the option list as page content and masks only the select's value, so the choice can
//     be read from the replay (rrweb's design; the full catalogue's select positions declare it
//     published). The screenshot run's select position therefore says `parts: ["screenshot"]`.
//   - A <canvas>: the recording leaves it out (recordCanvas is off); the picture copies its
//     pixels, so text an app draws on a canvas is in the picture under any setting.
//   - document.designMode = "on" makes a whole document editable with no attribute to select on;
//     neither the picture nor the recording masks it.
const GAPS = [];

// --------------------------------------------------------------------------------------------

const VALUE_KINDS = new Set(["input-value", "editable-text"]);

export function expectedFate(position, settings) {
  // `blank` only protects anything if the app actually named the selector. With an empty list
  // the sensitive zones are ordinary page content and are expected to behave like it — which is
  // the difference between a harness that tests the library and one that tests its own wrapper.
  const blanking = (settings.blank || []).includes(BLANK_SELECTOR);
  const zone =
    !blanking && (position.zone === "sensitive" || position.zone === "blanked")
      ? "ordinary"
      : position.zone;
  const here = { ...position, zone };

  if (zone === "reporter") {
    return fate("published", "the reporter's own words and choices");
  }
  if (zone === "channel") return channelFate(position, settings, blanking);

  // Everything below is page content, and only two parts carry any: the recording and the
  // automatic screenshot. With both off, nothing from the page can reach the bundle at all.
  if (!settings.replay && !settings.screenshot) {
    return fate("withheld", "no recording and no screenshot: no part carries the page");
  }
  // A gap is a statement about what the code really does, so it beats the policy rules below —
  // except for a password, which no gap may ever be allowed to excuse.
  if (position.kind !== "password") {
    for (const gap of GAPS) {
      if (gap.match(here)) {
        return { expect: "published", why: gap.why, gap: gap.id, mechanism: null };
      }
    }
  }
  for (const mechanism of MECHANISMS) {
    if (mechanism.match(here)) {
      return { expect: "withheld", why: mechanism.why, mechanism: mechanism.id, gap: null };
    }
  }
  if (position.kind === "password") {
    return fate("withheld", "a password never leaves, under any settings");
  }
  if (position.kind === "always-masked") {
    return fate("withheld", "a hidden field and a file path never leave, under any settings");
  }
  // A query string is a token risk wherever it is written down, not only in the page's own
  // address. The library strips it from `pageContext`, from the Meta event, from every network
  // entry and from the route breadcrumb, all for one stated reason — cad-dashboard's router puts
  // a magic-link token in one — and an anchor pointing back at that URL carries the same token.
  // The first report classified this position as ordinary markup and published it, which
  // contradicted the four strips beside it; the strips were right (audit finding F7).
  if (position.id.startsWith("attr/href-query/")) {
    return fate("withheld", "a query string can carry a token, however the page writes it down");
  }
  // A whole document in one attribute, and the third review round in which it has escaped. rrweb
  // has no option for it; scrubReplayEvent deletes the attribute, in every zone (audit finding
  // F9/G1). That is all this position can see: jsdom never renders a srcdoc frame, so the marker
  // exists only in the attribute here. In a real browser the frame *is* rendered and its visible
  // text is recorded through rrweb's child-document path like any other on-screen content, with
  // the same masking and blanking inside it — the browser run (e2e/panel.spec.js) shows both
  // halves: the rendered text present, the attribute-only part absent.
  if (position.id.startsWith("attr/srcdoc/")) {
    return fate(
      "withheld",
      "an <iframe srcdoc> attribute is a whole document, never on screen as such; the attribute is scrubbed (what the frame renders is recorded like any visible text, which jsdom cannot show)",
    );
  }
  if (zone === "sensitive" || zone === "blanked") {
    return fate("withheld", "the app named this element in capture.blank");
  }
  if (VALUE_KINDS.has(position.kind)) {
    return settings.maskAllInputs
      ? fate("withheld", "a field value under maskAllInputs")
      : fate("published", "a field value with maskAllInputs off");
  }
  return fate("published", "ordinary page content: reproducing it is what a session replay is for");
}

function fate(expect, why) {
  return { expect, why, gap: null, mechanism: null };
}

// The buffers are not page serialisation, so they get their own small table. `blankDependent`
// entries are the ones `capture.blank` decides: the describers read an element's text, labels and
// data attributes straight off the page, so with the selectors given they must withhold, and with
// no selectors given the same text is ordinary page content and travels like it.
const CHANNEL_FATES = {
  "click-text": ["the text of a clicked element", { blankDependent: true }],
  "click-aria": ["the aria-label of a clicked element", { blankDependent: true }],
  "click-data": ["a data-* attribute of a clicked element", { blankDependent: true }],
  "click-id": ["the id of a clicked element", { blankDependent: true }],
  "change-label": ["the label of a changed field", { blankDependent: true }],
  "change-placeholder": ["the placeholder of a changed field", { blankDependent: true }],
  "change-aria": ["the aria-label of a changed field", { blankDependent: true }],
  "change-name": ["the name of a changed field", { blankDependent: true }],
  "change-file-label": ["the label of a changed file field", { blankDependent: true }],
  "click-text-nested": [
    "the text of a blanked element inside the clicked one",
    { blankDependent: true },
  ],
  "submit-text": [
    "the text of a blanked element inside a submitted form",
    { blankDependent: true },
  ],
  "submit-blanked": [
    "the text of a submitted form inside a blanked region",
    { blankDependent: true },
  ],
  "change-label-outside": [
    "the <label for=…> of a changed field, when the label is blanked and the field is not",
    { blankDependent: true },
  ],
  "change-password": [
    "a password value, in every buffer, under every setting",
    { expect: "withheld" },
  ],
  "change-value": ["a field value in a breadcrumb follows maskAllInputs", { maskDependent: true }],
  // Published, and written down rather than left implicit. An uncaught error's message and stack
  // are the most useful bytes in a report, and an error message routinely interpolates the value
  // that caused it ("cannot price ring SKU-1201 at 1240.00"), so an app whose errors carry record
  // data is publishing it here. There is no switch: `capture.console` and `capture.network` can be
  // turned off, the error buffer cannot. That is the decision, and this is where it is recorded
  // (audit finding F5).
  "error-message": ["an uncaught error's message: what the report is for", { expect: "published" }],
  "error-stack": ["an uncaught error's stack frames", { expect: "published" }],
  "console-arg": [
    "what the app itself logged: the console buffer's whole purpose",
    { expect: "published" },
  ],
  "network-path": [
    "origin and path of a failed request, kept on purpose (spec 5.7)",
    { expect: "published" },
  ],
  "network-query": [
    "a query string can carry a token, and scrubUrl drops it",
    { expect: "withheld" },
  ],
  "route-hash": ["the hash is part of the route a dashboard navigates by", { expect: "published" }],
  "route-hash-params": [
    "a fragment carrying parameters is where supabase-js's implicit flow lands a session (#access_token=…), and the route breadcrumb drops it whole",
    { expect: "withheld" },
  ],
  "route-query": [
    "a route breadcrumb carries path and hash, never a query string",
    { expect: "withheld" },
  ],
  "location-query": [
    "pageContext drops the query deliberately (a magic-link token lives there), and in the combinations whose recorder starts on a query URL the Meta event must not put it back",
    { expect: "withheld" },
  ],
  "location-hash-params": [
    "pageContext drops a fragment that carries parameters (a session lives there on a recovery landing page), and in the combinations whose recorder starts on that page the Meta event must not put it back",
    { expect: "withheld" },
  ],
  "document-title": ["the page title names the view being reported on", { expect: "published" }],
  "image-bytes": ["an image the reporter attached on purpose", { expect: "published" }],
  "screenshot-bytes": ["the screenshot of the page being reported on", { expect: "published" }],
};

function channelFate(position, settings, blanking) {
  const entry = CHANNEL_FATES[position.channel];
  if (!entry) throw new Error(`no fate declared for channel "${position.channel}"`);
  const [why, rule] = entry;
  if (rule.blankDependent) {
    return blanking
      ? fate("withheld", `${why} inside a blanked region`)
      : fate("published", `${why}, with no blank selectors given`);
  }
  if (rule.maskDependent) {
    return settings.maskAllInputs ? fate("withheld", why) : fate("published", why);
  }
  // A buffer an app switched off cannot carry anything (spec 5.5).
  if (position.channel === "console-arg" && settings.console === false) {
    return fate("withheld", "the console buffer is switched off");
  }
  if (position.channel === "network-path" && settings.network === false) {
    return fate("withheld", "the network buffer is switched off");
  }
  return fate(rule.expect, why);
}

export function listGaps() {
  return GAPS.map((gap) => ({ id: gap.id, why: gap.why }));
}
