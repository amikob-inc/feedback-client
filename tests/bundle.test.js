import { describe, expect, it } from "vitest";
import { byteLength } from "../src/bytes.js";
import { CAPS, buildBundle, buildReport, describeAttachments, fitReport } from "../src/bundle.js";
import { CLIENT_ID } from "../src/version.js";

const png = (size) => new Blob([new Uint8Array(size)], { type: "image/png" });
const gz = (size) => new Blob([new Uint8Array(size)], { type: "application/gzip" });

const reportInput = {
  app: "cad",
  env: "production",
  version: "911e95d9",
  section: "Rendering",
  type: "Bug",
  text: "The ring popup does not open after I saved a shape edit.",
  reporter: { id: "sub-1", name: "Dana", email: "dana@example.com", role: "colleague" },
  page: {
    path: "/",
    view: "browse",
    title: "Ring Catalog",
    viewport: [1440, 900],
    dpr: 2,
    theme: "dark",
    language: "en-US",
    online: true,
  },
  browser: { userAgent: "Mozilla/5.0" },
  at: "2026-09-16T14:02:11.412Z",
  capture: { replay: true, screenshot: true, maskAllInputs: false },
  breadcrumbs: [
    { t: "2026-09-16T14:01:50.010Z", kind: "click", target: "button#save-ring 'Save ring'" },
  ],
  console: [{ t: "2026-09-16T14:01:51.000Z", level: "error", text: "TypeError" }],
  errors: [],
  network: [],
};

describe("buildReport", () => {
  it("is the spec's report JSON with the client string added", () => {
    const report = buildReport(reportInput);
    expect(report.client).toBe(CLIENT_ID);
    expect(report.app).toBe("cad");
    expect(report.section).toBe("Rendering");
    expect(report.type).toBe("Bug");
    expect(report.reporter).toEqual(reportInput.reporter);
    expect(report.page.view).toBe("browse");
    expect(report.capture).toEqual({ replay: true, screenshot: true, maskAllInputs: false });
    expect(report.breadcrumbs).toHaveLength(1);
    expect(Object.keys(report)).toEqual([
      "client",
      "app",
      "env",
      "version",
      "section",
      "type",
      "text",
      "reporter",
      "page",
      "browser",
      "at",
      "capture",
      "breadcrumbs",
      "console",
      "errors",
      "network",
    ]);
  });

  it("never echoes anything beyond what it was given: no DOM access, no extra fields", () => {
    // buildReport is pure — it must not go looking for cookies, headers or a query string on its
    // own (privacy carries through: it can only pass along what the buffers and the snapshot
    // already decided to keep). Passing a page/browser object with no such fields and checking
    // the output has nothing else on it is the closest a unit test gets to proving a negative.
    const report = buildReport({
      ...reportInput,
      page: { path: "/", view: "browse" },
      browser: { userAgent: "UA" },
    });
    expect(Object.keys(report.page)).toEqual(["path", "view"]);
    expect(Object.keys(report.browser)).toEqual(["userAgent"]);
  });

  it("defaults capture flags to false and coerces truthy/falsy input", () => {
    const report = buildReport({ app: "cad", capture: { replay: 1, screenshot: 0 } });
    expect(report.capture).toEqual({ replay: true, screenshot: false, maskAllInputs: false });
  });
});

describe("fitReport", () => {
  it("leaves a small report alone", () => {
    const { report, trimmed } = fitReport(buildReport(reportInput));
    expect(trimmed).toBe(0);
    expect(report.console).toHaveLength(1);
  });

  it("drops the oldest console entries first, then network, then breadcrumbs", () => {
    const big = buildReport({
      ...reportInput,
      console: Array.from({ length: 40 }, (_, i) => ({ t: "t", level: "log", text: `c${i}` })),
      network: Array.from({ length: 20 }, (_, i) => ({
        t: "t",
        method: "GET",
        url: `u${i}`,
        status: 500,
        ms: 1,
      })),
      breadcrumbs: Array.from({ length: 20 }, (_, i) => ({
        t: "t",
        kind: "click",
        target: `b${i}`,
      })),
    });
    const { report, trimmed } = fitReport(big, 1600);
    expect(trimmed).toBeGreaterThan(0);
    expect(JSON.stringify(report).length).toBeLessThanOrEqual(1600);
    expect(report.breadcrumbs.length).toBe(20);
    expect(report.console.length).toBeLessThan(40);
    if (report.console.length) expect(report.console[0].text).not.toBe("c0");
  });

  it("measures real UTF-8 bytes, not JS string .length (standing rule 1)", () => {
    // 30 entries of a 20-character Japanese string: each character is 3 bytes on the wire but
    // one UTF-16 code unit, so the byte length of the full report (3,420) and its JS .length
    // (2,220) sit either side of 2,500. An implementation that measured `.length` instead of
    // `byteLength` would see 2,220 <= 2,500, call the report already small enough, and return it
    // untouched at 3,420 real bytes — 37% over the cap it was asked to enforce, and destined for
    // a 413 the reporter never saw coming.
    const jp = "です".repeat(10);
    const big = buildReport({
      ...reportInput,
      breadcrumbs: [],
      console: Array.from({ length: 30 }, () => ({ t: "t", level: "log", text: jp })),
    });
    expect(byteLength(JSON.stringify(big))).toBeGreaterThan(2500);
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(2500);

    const { report, trimmed } = fitReport(big, 2500);
    expect(trimmed).toBeGreaterThan(0);
    expect(byteLength(JSON.stringify(report))).toBeLessThanOrEqual(2500);
  });

  it("drops errors only as an absolute last resort, once the other three buffers are empty", () => {
    const errors = Array.from({ length: 20 }, () => ({
      t: "t",
      message: "TypeError: x is not a function",
      stack: "at foo (app.js:10:5)\nat bar (app.js:20:9)\nat baz (app.js:30:2)",
    }));
    const big = buildReport({ ...reportInput, breadcrumbs: [], console: [], network: [], errors });
    const { report, trimmed } = fitReport(big, 1200);
    expect(trimmed).toBeGreaterThan(0);
    expect(report.errors.length).toBeLessThan(20);
    expect(byteLength(JSON.stringify(report))).toBeLessThanOrEqual(1200);
  });

  it("never drops the reporter's own words, even when the cap cannot otherwise be met", () => {
    // With every buffer already empty, there is nothing left fitReport is allowed to remove: it
    // must leave `text` (and the rest of the identity) untouched and simply give up, rather than
    // truncating the one thing the standing rules single out as never droppable.
    const tiny = buildReport({
      ...reportInput,
      breadcrumbs: [],
      console: [],
      network: [],
      errors: [],
    });
    const { report, trimmed } = fitReport(tiny, 10);
    expect(trimmed).toBe(0);
    expect(report.text).toBe(reportInput.text);
  });

  it("drops exactly as many entries as the cap needs, never more", () => {
    // 150 entries, not 25: dropping in fixed-percentage chunks (the plan's own snippet: 10% of
    // whatever remains, rounded up) lands within one entry of the minimum by coincidence on a
    // small array, because the chunk size decays to 1 once fewer than 10 entries are left and the
    // boundary in a small test happens to fall in that range. At this size the boundary falls
    // where a 10%-chunk implementation is still removing chunks of 4-5 at a time and overshoots
    // the true minimum by several entries — worked out by hand: a linear search over every
    // possible cut point finds the true minimum is 95 entries at this cap, five fewer than a
    // 10%-chunk implementation removes.
    const big = buildReport({
      ...reportInput,
      breadcrumbs: [],
      network: [],
      errors: [],
      console: Array.from({ length: 150 }, (_, i) => ({
        t: "t",
        level: "log",
        text: `entry-${i}`,
      })),
    });
    const { report, trimmed } = fitReport(big, 3000);
    // Measured from the arrays themselves, not from the self-reported `trimmed` count: a bogus
    // counter (say, one that undercounts a bulk removal) would otherwise let a test built on
    // `trimmed` alone reconstruct "put one back" as "put everything back" and pass regardless of
    // how much was actually thrown away.
    const removed = big.console.length - report.console.length;
    expect(removed).toBe(95);
    expect(trimmed).toBe(removed); // the count the panel would show must match reality
    // Putting back the single oldest entry fitReport chose to drop must still be over the cap —
    // otherwise fitReport removed at least one entry it did not need to.
    const putOneBack = { ...report, console: big.console.slice(removed - 1) };
    expect(byteLength(JSON.stringify(putOneBack))).toBeGreaterThan(3000);
  });
});

describe("describeAttachments", () => {
  it("names what is going", () => {
    expect(
      describeAttachments({
        screenshot: png(1),
        dom: gz(1),
        replay: gz(1),
        images: [png(1), png(1)],
      }),
    ).toBe(
      "What will be sent: a screenshot of this page, a copy of the page, a recording of the last minute or two, 2 images you added, the console and network log.",
    );
  });

  it("names one image in the singular and drops what is absent", () => {
    expect(
      describeAttachments({ screenshot: null, dom: null, replay: null, images: [png(1)] }),
    ).toBe("What will be sent: 1 image you added, the console and network log.");
  });

  it("always names the console and network log, even with nothing else attached", () => {
    expect(describeAttachments({})).toBe("What will be sent: the console and network log.");
  });
});

describe("buildBundle", () => {
  const smallCaps = {
    ...CAPS,
    report: 4096,
    screenshot: 100,
    dom: 100,
    replay: 100,
    image: 100,
    images: 2,
    total: 5000,
  };

  it("builds the multipart parts with the hub's names", async () => {
    const { form, dropped } = buildBundle(
      {
        report: buildReport(reportInput),
        screenshot: png(10),
        dom: gz(10),
        replay: gz(10),
        images: [png(5), png(5)],
      },
      smallCaps,
    );
    expect(dropped).toEqual([]);
    expect(form.get("report")).toBeInstanceOf(Blob);
    expect(form.get("screenshot").size).toBe(10);
    expect(form.get("dom").size).toBe(10);
    expect(form.get("replay").size).toBe(10);
    expect(form.getAll("image")).toHaveLength(2);
    expect(JSON.parse(await form.get("report").text()).client).toBe(CLIENT_ID);
  });

  it("drops a part over its own cap and says so", () => {
    const { form, dropped } = buildBundle(
      {
        report: buildReport(reportInput),
        screenshot: png(200),
        dom: gz(10),
        replay: gz(10),
        images: [],
      },
      smallCaps,
    );
    expect(form.get("screenshot")).toBe(null);
    expect(dropped).toEqual(["the screenshot (over its own limit)"]);
  });

  it("keeps at most six images", () => {
    const { form, dropped } = buildBundle(
      { report: buildReport(reportInput), images: [png(5), png(5), png(5)] },
      smallCaps,
    );
    expect(form.getAll("image")).toHaveLength(2);
    expect(dropped).toContain("1 extra image");
  });

  it("drops the recording first when the bundle is over the total", () => {
    // report + dom + screenshot alone (900 + 900 = 1,800 minus the report's own ~760 bytes) must
    // stay under `total` so dropping just the recording is enough — a `total` that cannot even
    // fit the report plus the two smaller attachments would make every implementation drop dom
    // and screenshot too, no matter the drop order, which would test nothing about ordering.
    const caps = { ...smallCaps, replay: 10_000, dom: 10_000, screenshot: 10_000, total: 1600 };
    const { form, dropped } = buildBundle(
      {
        report: buildReport(reportInput),
        screenshot: png(300),
        dom: gz(300),
        replay: gz(900),
        images: [],
      },
      caps,
    );
    expect(form.get("replay")).toBe(null);
    expect(form.get("dom")).not.toBe(null);
    expect(dropped).toContain("the recording (the bundle was too big)");
  });

  it("stamps capture.replay and capture.screenshot with what is actually attached", async () => {
    const { form } = buildBundle(
      { report: buildReport(reportInput), screenshot: null, replay: null, dom: gz(10), images: [] },
      smallCaps,
    );
    const sent = JSON.parse(await form.get("report").text());
    expect(sent.capture).toEqual({ replay: false, screenshot: false, maskAllInputs: false });
  });

  it("names a jpeg attachment .jpg and a png .png", () => {
    const jpeg = new Blob([new Uint8Array(5)], { type: "image/jpeg" });
    const { form } = buildBundle(
      { report: buildReport(reportInput), images: [jpeg, png(5)] },
      smallCaps,
    );
    const names = form.getAll("image").map((file) => file.name);
    expect(names).toEqual(["1.jpg", "2.png"]);
  });

  it("refuses an image the hub would 400 on, and keeps the ones that are fine", () => {
    // service/src/intake.ts rejects the *entire* request with a 400 if any image part is not
    // image/png or image/jpeg. A gif or webp must never reach the form, or one bad attachment
    // would sink a report that was otherwise fine.
    const gif = new Blob([new Uint8Array(5)], { type: "image/gif" });
    const { form, dropped } = buildBundle(
      { report: buildReport(reportInput), images: [gif, png(5)] },
      smallCaps,
    );
    const files = form.getAll("image");
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe("image/png");
    expect(dropped).toContain("an image (not png or jpeg)");
  });

  it("never lets the request exceed the hub's total cap, across every kind of attachment", () => {
    const caps = { ...CAPS, total: 2_000_000 };
    const { size, dropped } = buildBundle(
      {
        report: buildReport(reportInput),
        screenshot: png(1_500_000),
        dom: gz(1_000_000),
        replay: gz(3_000_000),
        images: [png(600_000), png(600_000), png(600_000)],
      },
      caps,
    );
    expect(size).toBeLessThanOrEqual(caps.total);
    expect(dropped.length).toBeGreaterThan(0);
  });

  it("fits an oversized report into its own cap rather than sending it whole", () => {
    const oversized = buildReport({
      ...reportInput,
      breadcrumbs: [],
      network: [],
      errors: [],
      console: Array.from({ length: 300 }, () => ({
        t: "t",
        level: "log",
        text: "x".repeat(2000),
      })),
    });
    expect(byteLength(JSON.stringify(oversized))).toBeGreaterThan(CAPS.report);
    const { form, trimmed, report } = buildBundle({ report: oversized, images: [] });
    expect(trimmed).toBeGreaterThan(0);
    expect(byteLength(JSON.stringify(report))).toBeLessThanOrEqual(CAPS.report);
    expect(form.get("report").size).toBeLessThanOrEqual(CAPS.report);
  });

  it("uses the spec's caps by default", () => {
    expect(CAPS).toEqual({
      report: 512 * 1024,
      screenshot: 5 * 1024 * 1024,
      dom: 3 * 1024 * 1024,
      replay: 8 * 1024 * 1024,
      image: 5 * 1024 * 1024,
      images: 6,
      total: 25 * 1024 * 1024,
      text: 5000,
      reply: 2000,
    });
  });
});
