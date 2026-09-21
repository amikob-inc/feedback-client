// The bundle (spec §5.3): the report JSON plus the attachments, as one multipart body with the
// part names the hub reads (amikob-inc/feedback-hub's service/src/intake.ts, read before writing
// this file — it is the authority on part names, caps and error shapes, not the plan). Pure — no
// DOM, no network, everything passed in as arguments — so every cap and every drop is testable in
// plain Node. The caps are the hub's own `LIMITS`, copied field for field: anything this library
// lets through over them comes back as a 413 (or, for a wrongly-typed image, a 400) naming the
// part and failing the *whole* submission, so every cap here is checked before a part is built,
// never assumed.
import { byteLength } from "./bytes.js";
import { CLIENT_ID } from "./version.js";

export const CAPS = {
  report: 512 * 1024,
  screenshot: 5 * 1024 * 1024,
  dom: 3 * 1024 * 1024,
  replay: 8 * 1024 * 1024,
  image: 5 * 1024 * 1024,
  images: 6,
  total: 25 * 1024 * 1024,
  text: 5000,
  reply: 2000,
};

// Which arrays fitReport may shorten, least valuable first, and in what order (standing rule 2:
// "must drop the least valuable thing first, deterministically, and must never drop the
// reporter's own words"). `text`, `section`, `type`, `reporter` and the rest of the report's
// identity are never in this list and fitReport never touches them — only these four arrays are
// candidates.
//
// - `console` goes first: 200 lines is the noisiest and least curated of the four, a handful of
//   which usually matter.
// - `network` goes second: up to 50 failed/slow requests, already filtered down by the buffer
//   itself, so less to lose per entry than console but still less load-bearing than a reproduction
//   trail.
// - `breadcrumbs` goes third: a deliberately curated click/change/route trail, close to what
//   triage turns into repro steps, so it survives longer than the first two.
// - `errors` goes last, as a last resort rather than a sanctuary: a handful of stack traces are
//   normally the cheapest and most useful bytes in the report, so they outlast everything else —
//   but standing rule 4 ("a cap is enforced, not assumed") wins over that if the report still
//   will not fit without them, because a report that cannot fit under its own 512 KB cap is
//   rejected whole at the hub's front door (413), losing the reporter's words along with
//   everything else. Losing 20 old stack traces here is better than losing the report there.
const TRIM_ORDER = ["console", "network", "breadcrumbs", "errors"];

// Builds the §5.3 report JSON from what the panel collected. Every field keeps whatever the
// caller passed — this module does not re-derive or re-collect anything from the page (privacy
// carries through: it must not reintroduce what the buffers or the DOM snapshot already stripped,
// and the only way to be sure of that is to never touch the DOM at all). `reporter.id` and the
// e-mail are only ever echoed for display: the hub's own intake.ts discards both and trusts only
// the verified token (`sanitizeReporter` there keeps just `name` and `role`).
export function buildReport({
  app,
  env = "",
  version = "",
  section = "",
  type = "",
  text = "",
  reporter = null,
  page = {},
  browser = {},
  at = new Date().toISOString(),
  capture = {},
  breadcrumbs = [],
  console: consoleEntries = [],
  errors = [],
  network = [],
} = {}) {
  const cap = capture || {};
  return {
    client: CLIENT_ID,
    app,
    env,
    version,
    section,
    type,
    text,
    reporter,
    page,
    browser,
    at,
    capture: {
      replay: !!cap.replay,
      screenshot: !!cap.screenshot,
      maskAllInputs: !!cap.maskAllInputs,
    },
    breadcrumbs,
    console: consoleEntries,
    errors,
    network,
  };
}

// Shrinks a report to fit under `max` bytes on the wire (`byteLength`, never `.length` — standing
// rule 1: the spec's budgets are wire budgets, and a report in Japanese or any other non-Latin
// script must not silently be two or three times its stated budget just because JS string length
// counts UTF-16 code units instead of bytes).
//
// Drops the single oldest entry from the first non-empty array in TRIM_ORDER, one at a time,
// re-measuring after every drop, so it never discards more than the cap actually needs — a report
// that is one entry over budget loses exactly one entry, not a fixed chunk of ten. `trimmed` is
// the total number of entries removed, across all four arrays, so the panel can say "left out N
// older log lines" without caring which array they came from.
export function fitReport(report, max = CAPS.report) {
  const out = { ...report };
  for (const key of TRIM_ORDER) out[key] = (report[key] || []).slice();
  let trimmed = 0;
  while (byteLength(JSON.stringify(out)) > max) {
    const from = TRIM_ORDER.find((key) => out[key].length > 0);
    if (!from) break; // nothing left to drop; text and the rest of the identity are never touched
    out[from] = out[from].slice(1);
    trimmed += 1;
  }
  return { report: out, trimmed };
}

// The hub only ever stores an image part as `images/N.jpg` or `images/N.png`, decided from the
// content type it re-derives itself (`image.type === "image/jpeg"`), never from a client-supplied
// name — so this only has to be consistent with that one bit, 1-indexed to match the hub's names.
export function imageName(blob, index) {
  return blob.type === "image/jpeg" ? `${index + 1}.jpg` : `${index + 1}.png`;
}

// The "what will be sent" line the panel shows before submit (spec §5.4), so leaving the
// recording out is an informed choice rather than a surprise. Names only what is actually
// present; the console and network log are always named last because they are always sent when
// capture is on (there is no separate opt-out for them the way there is for the recording).
export function describeAttachments({
  screenshot = null,
  dom = null,
  replay = null,
  images = [],
} = {}) {
  const parts = [];
  if (screenshot) parts.push("a screenshot of this page");
  if (dom) parts.push("a copy of the page");
  if (replay) parts.push("a recording of the last minute or two");
  if (images.length === 1) parts.push("1 image you added");
  else if (images.length > 1) parts.push(`${images.length} images you added`);
  parts.push("the console and network log");
  return `What will be sent: ${parts.join(", ")}.`;
}

// Assembles the multipart body `POST /v1/reports` expects (intake.ts's `form.get("report")`,
// `"screenshot"`, `"dom"`, `"replay"`, and repeated `"image"` — field names checked against that
// file, not guessed from the spec prose). Every part is checked against its own cap before it
// goes in; nothing over cap is ever attached in the hope the hub is lenient (standing rule 4).
//
// Order of what gives way when the *bundle* (not any one part) is still over `caps.total`, again
// least valuable first: the recording first (it is also the single biggest possible part, so it
// is usually both the cheapest and the most effective thing to drop), then the page copy, then
// the automatic screenshot, and only then the images the reporter deliberately chose to attach —
// those are evidence the reporter picked out on purpose and so are the last thing to go.
//
// What the attachments compete for is `caps.total` minus the report's own *actual* size, not the
// whole of its cap: reserving all of `caps.report` up front was tried first and wastes most of it
// on a real report, which is usually a few hundred bytes to a few KB — attachments would be cut
// on a report that had plenty of room to spare, sometimes long before the total cap was anywhere
// close to reached. The report is measured with `replay`/`screenshot` already forced to `false` —
// the longer of the two spellings — before any attachment is dropped for size, so whichever way
// those two booleans really land once the attachment trimming below is done, the real report can
// only be the same size or smaller than what was budgeted for it here. That is what keeps
// `size <= caps.total` an actual guarantee rather than an approximation with a few bytes of slop.
export function buildBundle(
  { report, screenshot = null, dom = null, replay = null, images = [] },
  caps = CAPS,
) {
  const dropped = [];

  let keptImages = images.slice(0, caps.images);
  const extra = images.length - keptImages.length;
  if (extra > 0) dropped.push(`${extra} extra image${extra === 1 ? "" : "s"}`);

  // intake.ts rejects the *whole* request with a 400 if any image part is not image/png or
  // image/jpeg — unlike an over-cap part, this is not something dropping just that image at
  // submit time can be inferred from the plan's snippet, only from reading the hub's own check.
  keptImages = keptImages.filter((blob) => {
    if (blob.type === "image/png" || blob.type === "image/jpeg") return true;
    dropped.push("an image (not png or jpeg)");
    return false;
  });

  keptImages = keptImages.filter((blob) => {
    if (blob.size <= caps.image) return true;
    dropped.push("an image (over its own limit)");
    return false;
  });

  let keptScreenshot = screenshot;
  if (keptScreenshot && keptScreenshot.size > caps.screenshot) {
    dropped.push("the screenshot (over its own limit)");
    keptScreenshot = null;
  }
  let keptDom = dom;
  if (keptDom && keptDom.size > caps.dom) {
    dropped.push("the page copy (over its own limit)");
    keptDom = null;
  }
  let keptReplay = replay;
  if (keptReplay && keptReplay.size > caps.replay) {
    dropped.push("the recording (over its own limit)");
    keptReplay = null;
  }

  const { report: budgetedReport, trimmed } = fitReport(
    { ...report, capture: { ...report.capture, replay: false, screenshot: false } },
    caps.report,
  );
  const budget = caps.total - byteLength(JSON.stringify(budgetedReport));
  const attachmentSize = () =>
    (keptScreenshot ? keptScreenshot.size : 0) +
    (keptDom ? keptDom.size : 0) +
    (keptReplay ? keptReplay.size : 0) +
    keptImages.reduce((sum, blob) => sum + blob.size, 0);

  if (attachmentSize() > budget && keptReplay) {
    keptReplay = null;
    dropped.push("the recording (the bundle was too big)");
  }
  if (attachmentSize() > budget && keptDom) {
    keptDom = null;
    dropped.push("the page copy (the bundle was too big)");
  }
  if (attachmentSize() > budget && keptScreenshot) {
    keptScreenshot = null;
    dropped.push("the screenshot (the bundle was too big)");
  }
  while (attachmentSize() > budget && keptImages.length) {
    keptImages.pop();
    dropped.push("an image (the bundle was too big)");
  }

  // capture.replay/screenshot are stamped with what actually made it into the bundle, not what
  // the panel originally asked to capture, so the hub (and anyone reading the stored report
  // later) sees the truth: a recording that was dropped here for size is indistinguishable to
  // them from one that was never taken, and the JSON should say so. Reusing budgetedReport's
  // already-trimmed arrays (rather than fitting `report` again from scratch) is what makes the
  // guarantee above hold: the only thing changing now is `false` becoming `true` for whichever of
  // the two flags actually survived, which can only make the JSON the same size or shorter.
  const fitted = {
    ...budgetedReport,
    capture: { ...budgetedReport.capture, replay: !!keptReplay, screenshot: !!keptScreenshot },
  };
  const json = JSON.stringify(fitted);

  const form = new FormData();
  form.append("report", new Blob([json], { type: "application/json" }), "report.json");
  if (keptScreenshot) form.append("screenshot", keptScreenshot, "screenshot.png");
  if (keptDom) form.append("dom", keptDom, "dom.html.gz");
  if (keptReplay) form.append("replay", keptReplay, "replay.json.gz");
  keptImages.forEach((blob, index) => form.append("image", blob, imageName(blob, index)));

  return { form, dropped, trimmed, size: attachmentSize() + byteLength(json), report: fitted };
}
