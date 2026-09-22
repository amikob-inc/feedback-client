// A stand-in for feedback-hub, for the demo page and the browser test. It answers the four client
// routes with the shapes the hub's own routes answer, canned: every status in the shared fixture is
// in the listing, so the panel's rendering of all of them is exercised in a real browser.
//
// It also serves the repository's files, so the demo page has a real origin — and it is reached on
// 127.0.0.1 while the page is on localhost, which makes every call from the page a genuine
// cross-origin request with a preflight, as it will be in production. One process, two origins.
//
// Beyond the hub's own routes it offers three of its own under `/_stub/`, which exist so the
// browser test can read what actually arrived rather than what the page believed it sent: the last
// bundle (with a substring search that also looks inside the gunzipped recording), the last
// screenshot's bytes, and a reset so one test's submission is never another test's listing.
//
// It serves whatever is under the repository root, which is right for something run by hand on a
// developer's machine and wrong for anything reachable from elsewhere. It binds nothing but
// loopback and is not meant to leave it.
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.STUB_PORT || 8787);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".map": "application/json",
};

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/status-cases.json", import.meta.url), "utf8"),
);
const canned = fixture.cases.map((one, index) => ({
  id: `fx-${index}`,
  at: new Date(Date.parse("2026-09-21T11:00:00.000Z") + index * 60000).toISOString(),
  section: "Rendering",
  type: "Bug",
  text: one.name,
  reporter: { id: "demo", name: "Dana" },
  status: one.status,
  label: one.label,
  verdict: one.input.verdict
    ? { ...one.input.verdict, receivedAt: "2026-09-21T11:30:00.000Z" }
    : null,
  replies: [],
}));

let submitted = [];
let last = null;

function cors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "60");
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function serveFile(res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end("bad path");
    return;
  }
  // join() normalises, so a path that climbs out of the root lands outside it and is caught by the
  // prefix test rather than being served.
  const target = join(ROOT, normalize(decoded));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(target)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// What the test is allowed to ask about the last bundle. The recording arrives gzipped, so a
// search that did not unzip it would find nothing in it and say so cheerfully; this unzips first.
function findIn(haystacks, needles) {
  const found = {};
  for (const [where, text] of Object.entries(haystacks)) {
    found[where] = needles.filter((needle) => needle && text.includes(needle));
  }
  return found;
}

// A window of text around one string, for when something private was found and the next question
// is how it got in: an attribute that escaped a scrubber and a serialised node from a child
// document look nothing alike, and the answer decides what the fix is. Capped, because the
// recording can be megabytes and nothing here should ever print one.
function contextAround(text, needle, width = 200, limit = 3) {
  const windows = [];
  let at = text.indexOf(needle);
  while (at !== -1 && windows.length < limit) {
    windows.push(text.slice(Math.max(0, at - width), at + needle.length + width));
    at = text.indexOf(needle, at + needle.length);
  }
  return windows;
}

async function readSubmission(req) {
  const form = await new Response(Readable.toWeb(req), {
    headers: { "content-type": req.headers["content-type"] || "" },
  }).formData();
  const report = JSON.parse(await form.get("report").text());
  const parts = {};
  for (const [name, value] of form.entries()) {
    parts[name] = (parts[name] || 0) + (typeof value === "string" ? value.length : value.size);
  }

  const replayPart = form.get("replay");
  let replayText = "";
  if (replayPart && typeof replayPart.arrayBuffer === "function") {
    const bytes = Buffer.from(await replayPart.arrayBuffer());
    try {
      replayText = gunzipSync(bytes).toString("utf8");
    } catch {
      // Not gzip after all: search the raw bytes rather than pretending there was nothing to look
      // at, which is the failure mode that would make every privacy assertion vacuous.
      replayText = bytes.toString("utf8");
    }
  }

  const screenshotPart = form.get("screenshot");
  const screenshot =
    screenshotPart && typeof screenshotPart.arrayBuffer === "function"
      ? Buffer.from(await screenshotPart.arrayBuffer())
      : null;

  return {
    report,
    parts: Object.keys(parts).sort(),
    sizes: parts,
    replayText,
    screenshot,
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  cors(res, req.headers.origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === "/livez") {
    res.writeHead(200).end("ok");
    return;
  }
  if (url.pathname === "/_stub/reset") {
    submitted = [];
    last = null;
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === "/_stub/last") {
    if (!last) {
      json(res, 200, { empty: true });
      return;
    }
    const needles = (url.searchParams.get("find") || "").split(",").filter(Boolean);
    // -1 for a recording that will not parse, which is a different thing from one with no events
    // in it and must not be reported as the same.
    let events;
    try {
      events = JSON.parse(last.replayText || "[]").length;
    } catch {
      events = -1;
    }
    const around = url.searchParams.get("around");
    json(res, 200, {
      report: last.report,
      parts: last.parts,
      sizes: last.sizes,
      replay: { bytes: last.replayText.length, events },
      found: findIn({ report: JSON.stringify(last.report), replay: last.replayText }, needles),
      context: around ? contextAround(last.replayText, around) : undefined,
    });
    return;
  }
  if (url.pathname === "/_stub/screenshot") {
    if (!last || !last.screenshot) {
      res.writeHead(404).end("no screenshot");
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
    res.end(last.screenshot);
    return;
  }

  if (url.pathname === "/v1/reports" && req.method === "POST") {
    last = await readSubmission(req);
    const id = `sub-${submitted.length + 1}`;
    submitted.unshift({
      id,
      at: new Date().toISOString(),
      section: last.report.section,
      type: last.report.type,
      text: last.report.text,
      reporter: { id: "demo", name: "Dana" },
      status: "triaging",
      label: "Received, being looked at",
      verdict: null,
      replies: [],
    });
    json(res, 202, { id });
    return;
  }

  if (url.pathname === "/v1/reports" && req.method === "GET") {
    json(res, 200, { items: [...submitted, ...canned], nextCursor: null });
    return;
  }

  const reply = /^\/v1\/reports\/([^/]+)\/replies$/.exec(url.pathname);
  if (reply && req.method === "POST") {
    const raw = await new Response(Readable.toWeb(req)).text();
    const body = JSON.parse(raw || "{}");
    json(res, 200, {
      replies: [{ at: new Date().toISOString(), by: "demo", text: body.text }],
      status: "triaging",
      label: "Received, being looked at",
    });
    return;
  }

  const retry = /^\/v1\/reports\/([^/]+)\/retry$/.exec(url.pathname);
  if (retry && req.method === "POST") {
    json(res, 200, { id: retry[1], status: "triaging", label: "Received, being looked at" });
    return;
  }

  await serveFile(res, url.pathname === "/" ? "/demo/index.html" : url.pathname);
}

// Loopback only, and on both families of it. The page is opened on `localhost` and the hub is
// addressed as `127.0.0.1`, which is what makes the calls cross-origin; a single socket bound to
// one of the two would leave whichever name the machine resolves the other way unreachable, and
// the failure would read as a broken library rather than a half-bound stub. `::1` is best effort:
// a host without IPv6 simply serves the IPv4 socket.
createServer(handle)
  .on("error", (err) => {
    // Without this an EADDRINUSE crashes the process silently and Playwright waits out its whole
    // webServer timeout before saying anything; with it the cause is the first line printed.
    console.error(`stub hub could not listen on ${PORT}: ${err.message}`);
    process.exit(1);
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`stub hub on http://localhost:${PORT} (demo at /demo/index.html)`);
  });
createServer(handle)
  .on("error", () => {})
  .listen(PORT, "::1");
