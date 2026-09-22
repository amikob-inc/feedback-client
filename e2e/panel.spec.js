// The browser run. Everything else in this repository is tested in jsdom, which has no layout, no
// canvas, no style resolution and no Shadow DOM scoping — so four groups of claims were made by
// thirteen tasks and settled by none of them. They are settled here:
//
//   - that the shadow root really isolates the panel's styles from a hostile page, that an app's
//     own tokens really reach it, and that the result is readable in both themes and at a 200%
//     zoom;
//   - that the annotator's coordinate mapping is right on a display whose device pixel ratio is
//     not 1, that a real canvas flattens at the image's own resolution, and that an <img> whose
//     src is a blob: URL fires `load` (in jsdom it fires nothing, so that path had only ever run
//     against its timeout);
//   - that the recorder's own iframe path, which jsdom cannot reach at all, does not carry a
//     child document's secrets out with it;
//   - that `capture.blank` keeps content out of the screenshot as pixels, not merely out of a
//     clone's attributes.
//
// Each of those is written to fail if the thing it describes is broken, and each was checked by
// breaking it on purpose first. Where the page plants something private, a public marker goes
// beside it in the same place: a search that finds nothing at all looks exactly like a page that
// kept its secrets, and the control is what tells the two apart.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { MARKERS, SWATCHES } from "../demo/markers.js";

const PORT = Number(process.env.STUB_PORT || 8787);
const HUB = `http://127.0.0.1:${PORT}`;
const PRIVATE_MARKERS = [
  MARKERS.PASSWORD,
  MARKERS.BLANKED,
  MARKERS.TOKEN,
  MARKERS.IFRAME_PASSWORD,
  MARKERS.IFRAME_BLANKED,
  MARKERS.SRCDOC_HIDDEN,
];

// The page is served from localhost and the hub is addressed as 127.0.0.1, so every call the
// panel makes crosses an origin and is preflighted.
function demo(params = {}) {
  return `/demo/index.html?${new URLSearchParams({ hub: HUB, ...params })}`;
}

// Written by tools/build-demo.mjs from what esbuild actually put in each chunk, and read here
// rather than at import time because the build runs with the server, after this file is loaded.
function chunks() {
  return JSON.parse(readFileSync(new URL("../demo/dist/chunks.json", import.meta.url), "utf8"));
}

function watchConsole(page) {
  const noise = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") noise.push(message.text());
  });
  page.on("pageerror", (error) => noise.push(String(error)));
  return noise;
}

async function ready(page, params = {}) {
  await page.goto(demo(params));
  await page.waitForFunction(() => window.demoReady === true);
}

// Opens the panel and waits until it is showing a recording it really has: the note's recording
// clause appears only once the recorder has actually started, which is also the moment the replay
// part is guaranteed to be in the next submit. Without this a fast test can submit before the
// first snapshot exists and read an empty recording as a clean one.
async function openWithRecording(page) {
  await page.click("#open-feedback");
  await expect(page.locator(".fbh-panel")).toBeVisible();
  await expect(page.locator(".fbh-note")).toContainText("a recording");
}

// Where keyboard focus is, asked twice. `document.activeElement` alone is not enough: it answers
// "the host element" for everything inside the panel, so an assertion written that way is true
// whether focus is on a real control or on a wrapper with nothing in it. The second half asks the
// shadow root about its own tree, which is the answer that matters.
function focusSpot(page) {
  return page.evaluate(() => {
    const host = document.getElementById("fbh-host");
    const inner = host.shadowRoot.activeElement;
    return {
      outer: document.activeElement === host ? "host" : document.activeElement.id || "?",
      // Not the class name alone: the "leave the recording out" checkbox has none, and reading
      // one off it would be an empty string every keyboard reporter could land on unnoticed.
      inner: inner ? inner.id || inner.className || inner.tagName : null,
    };
  });
}

async function lastBundle(request, find = []) {
  const query = new URLSearchParams({ find: find.join(",") });
  const response = await request.get(`${HUB}/_stub/last?${query}`);
  return response.json();
}

function rgb(text) {
  return text
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);
}

// WCAG's relative luminance and contrast ratio, so "readable in both themes" is a number rather
// than an impression.
function contrast(a, b) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Reads the last screenshot the hub was sent, as pixels. Counting colours over the whole raster
// rather than sampling a coordinate keeps the question simple: is this colour anywhere in the
// picture the hub received?
async function screenshotPixels(page) {
  return page.evaluate(
    async ({ hub, swatches }) => {
      const blob = await (await fetch(`${hub}/_stub/screenshot`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const near = (a, b) => Math.abs(a - b) <= 6;
      const counts = { open: 0, blanked: 0, white: 0 };
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (near(r, swatches.OPEN[0]) && near(g, swatches.OPEN[1]) && near(b, swatches.OPEN[2])) {
          counts.open += 1;
        }
        if (
          near(r, swatches.BLANKED[0]) &&
          near(g, swatches.BLANKED[1]) &&
          near(b, swatches.BLANKED[2])
        ) {
          counts.blanked += 1;
        }
        if (r === 255 && g === 255 && b === 255) counts.white += 1;
      }
      return { width: bitmap.width, height: bitmap.height, counts, pixels: data.length / 4 };
    },
    { hub: HUB, swatches: SWATCHES },
  );
}

test.beforeEach(async ({ request }) => {
  // The stub keeps the last bundle and everything submitted so far in memory. One test's report
  // is another test's extra row, and the status listing counts rows.
  await request.get(`${HUB}/_stub/reset`);
});

for (const theme of ["light", "dark"]) {
  test(`submits a report and shows it as received (${theme})`, async ({ page, request }) => {
    const noise = watchConsole(page);
    await ready(page, { theme });
    await openWithRecording(page);

    await expect(page.locator(".fbh-thumb figcaption").first()).toHaveText("Screenshot");
    await page.selectOption("#fbh-type", "Question");
    await page.fill("#fbh-text", "e2e smoke report");
    await page.click("#fbh-submit");

    await expect(page.locator(".fbh-row").first()).toContainText("e2e smoke report");
    await expect(page.locator(".fbh-row").first().locator(".fbh-pill")).toHaveText(
      "Received, being looked at",
    );

    const bundle = await lastBundle(request, PRIVATE_MARKERS);
    // Exactly these three, asserted whole: a `dom` part appearing here again is the regression
    // this line exists to catch, the bespoke page copy having been withdrawn before release.
    expect(bundle.parts).toEqual(["replay", "report", "screenshot"]);
    expect(bundle.report.client).toMatch(/^feedback-client\//);
    expect(bundle.report.app).toBe("cad");
    expect(bundle.report.env).toBe("demo");
    expect(bundle.report.type).toBe("Question");
    expect(bundle.report.section).toBe("Rendering");
    expect(bundle.report.reporter.name).toBe("Dana");
    expect(bundle.report.page.theme).toBe(theme);
    expect(bundle.report.page.path).toBe("/demo/index.html");
    expect(bundle.report.capture).toEqual({
      replay: true,
      screenshot: true,
      maskAllInputs: false,
    });
    expect(bundle.report.breadcrumbs.some((one) => one.kind === "click")).toBe(true);
    expect(bundle.found.report).toEqual([]);
    expect(noise).toEqual([]);
  });
}

test("leaves the recording out when asked", async ({ page, request }) => {
  await ready(page);
  await openWithRecording(page);
  await page.check("#fbh-no-replay");
  await expect(page.locator(".fbh-note")).not.toContainText("a recording");
  await page.fill("#fbh-text", "no recording please");
  await page.click("#fbh-submit");
  await expect(page.locator(".fbh-row").first()).toContainText("no recording please");

  const bundle = await lastBundle(request);
  expect(bundle.parts).not.toContain("replay");
  expect(bundle.report.capture.replay).toBe(false);
});

test("shows every status the hub can send", async ({ page }) => {
  const noise = watchConsole(page);
  await ready(page);
  await page.click("#open-feedback");
  // One row per case in fixtures/status-cases.json, which is the file the hub asserts against
  // too — so a status added on either side lands here as a count that no longer matches.
  await expect(page.locator(".fbh-row")).toHaveCount(23);
  for (const label of [
    "Received, being looked at",
    "Received, waiting",
    "Filed as #7",
    "Filed",
    "Fix in progress",
    "Fixed",
    "Closed",
    "Answered",
    "Already tracked as #3 (open)",
    "Already tracked as #3 (fixed)",
    "Already tracked as #3 (closed)",
    "Already tracked as #3",
    "Needs your reply",
    "Not filed",
    "Could not triage",
  ]) {
    await expect(page.locator(".fbh-pill", { hasText: label }).first()).toBeVisible();
  }
  // One `needs_reply` case, and one Retry per `waiting` or `error` case: two and three.
  await expect(page.locator("[data-reply]")).toHaveCount(1);
  await expect(page.locator("[data-retry]")).toHaveCount(5);
  expect(noise).toEqual([]);
});

test("answers a question and retries a failed triage", async ({ page }) => {
  await ready(page);
  await page.click("#open-feedback");
  await expect(page.locator("[data-reply]")).toHaveCount(1);

  // Pinned by id before anything is sent. A locator written as "the row that has a reply box"
  // stops matching the moment the reply lands and the box goes away, which would make every
  // assertion after it a search for nothing.
  const replyId = await page
    .locator(".fbh-row")
    .filter({ has: page.locator("[data-reply]") })
    .getAttribute("data-id");
  const replyRow = page.locator(`.fbh-row[data-id="${replyId}"]`);
  await replyRow.locator("[data-reply]").fill("It happens on the second ring only.");
  await replyRow.locator("[data-send]").click();
  await expect(replyRow.locator(".fbh-row-message")).toHaveText(
    "Sent. Now: Received, being looked at.",
  );
  await expect(replyRow).toContainText("It happens on the second ring only.");
  // The row was rebuilt under the button that was just pressed, so focus has to be put back
  // deliberately; the row's own status line is where it goes, because that is what has just been
  // announced. Left alone it would be on <body>, outside the dialog entirely.
  expect(await focusSpot(page)).toEqual({ outer: "host", inner: "fbh-row-message" });

  const retryId = await page
    .locator(".fbh-row")
    .filter({ has: page.locator("[data-retry]") })
    .first()
    .getAttribute("data-id");
  const retryRow = page.locator(`.fbh-row[data-id="${retryId}"]`);
  await retryRow.locator("[data-retry]").click();
  await expect(retryRow.locator(".fbh-row-message")).toHaveText(
    "Retried. Now: Received, being looked at.",
  );
  await expect(retryRow.locator(".fbh-pill")).toHaveText("Received, being looked at");
});

test("says to sign in when there is no session", async ({ page }) => {
  await ready(page);
  await page.click("#toggle-signin");
  await page.click("#open-feedback");
  await page.fill("#fbh-text", "signed out");
  await page.click("#fbh-submit");
  await expect(page.locator(".fbh-message")).toHaveText("Sign in to report");
});

test("keeps the keyboard inside the dialog and gives focus back on Escape", async ({ page }) => {
  await ready(page);
  await page.click("#open-feedback");
  await expect(page.locator(".fbh-panel")).toBeVisible();

  // Two questions, because the answer to the first alone can be true while focus sits on the
  // host element and nothing inside it: which element in the page holds focus, and which element
  // inside the shadow root does.
  const where = () => focusSpot(page);
  expect(await where()).toEqual({ outer: "host", inner: "fbh-close" });

  // Round the trap several times over: every stop must still be inside the shadow root, and the
  // sequence must come back round rather than run out. A trap that let go once in twenty presses
  // would pass a single Tab.
  const stops = [];
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press("Tab");
    const spot = await where();
    expect(spot.outer).toBe("host");
    expect(spot.inner).not.toBe(null);
    stops.push(spot.inner);
  }
  expect(stops).toContain("fbh-close");
  expect(new Set(stops).size).toBeLessThan(stops.length);
  await page.keyboard.press("Shift+Tab");
  expect((await where()).outer).toBe("host");

  await page.keyboard.press("Escape");
  await expect(page.locator(".fbh-panel")).toBeHidden();
  expect(await page.evaluate(() => document.activeElement.id)).toBe("open-feedback");
});

test("keeps focus inside the dialog while a report is being sent", async ({ page }) => {
  await ready(page);
  await page.click("#open-feedback");
  await page.fill("#fbh-text", "sent from the keyboard");

  // Reached and activated from the keyboard, which is the only way this goes wrong: Send is
  // disabled the instant it is pressed, and disabling the element that holds focus drops that
  // focus to <body> — outside the shadow root, so the dialog loses both its Escape and its trap
  // and Tab walks off into the page behind the modal. Focus is moved to the status line first,
  // which is also what is about to be read out.
  await page.locator("#fbh-submit").focus();
  expect((await focusSpot(page)).inner).toBe("fbh-submit");
  await page.keyboard.press("Enter");
  await expect(page.locator(".fbh-message")).toHaveText("Sent.");

  const spot = await focusSpot(page);
  expect(spot.outer).toBe("host");
  expect(spot.inner).toBe("fbh-message");
  await page.keyboard.press("Escape");
  await expect(page.locator(".fbh-panel")).toBeHidden();
});

test("locks the page behind it and gives the scrollbar back", async ({ page }) => {
  await ready(page);
  // The app's own inline overflow, so closing is shown to restore what the page had rather than
  // merely clearing the property.
  await page.evaluate(() => {
    document.documentElement.style.overflow = "auto";
    window.scrollTo(0, 300);
  });
  expect(await page.evaluate(() => window.scrollY)).toBe(300);

  // Opened through the API rather than by clicking the button: the button is at the top of the
  // page, and clicking it would scroll there first, which is the page moving for its own reasons
  // and would make the next few lines prove nothing.
  await page.evaluate(() => window.feedback.open());
  await expect(page.locator(".fbh-panel")).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
    "hidden",
  );
  // A real wheel over the backdrop, not a scrollTo: the question is whether the page scrolls
  // under the panel when someone turns the wheel.
  await page.mouse.move(40, 350);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.scrollY)).toBe(300);

  await page.keyboard.press("Escape");
  await expect(page.locator(".fbh-panel")).toBeHidden();
  // Whatever the page had, not merely an empty string: an app that set its own overflow gets it
  // back. And the page is still where the reporter left it.
  expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("auto");
  expect(await page.evaluate(() => window.scrollY)).toBe(300);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
});

test("survives a page-wide stylesheet that sets out to wreck it", async ({ page }) => {
  await ready(page, { hostile: "1" });
  // The control. The page's own heading is gone, so the reset really is in force; without this
  // every assertion below would also pass against a page with no hostile stylesheet at all.
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById("page-title")).display),
  ).toBe("none");

  // The app's own button is a casualty of its own reset, so the panel is opened through the
  // headless API — which is the other thing this shows: an app can drive the panel without it.
  await page.evaluate(() => window.feedback.open());
  await expect(page.locator(".fbh-panel")).toBeVisible();

  const styles = await page.evaluate(() => {
    const host = document.getElementById("fbh-host");
    const shadow = host.shadowRoot;
    const of = (selector, property) =>
      getComputedStyle(shadow.querySelector(selector)).getPropertyValue(property);
    return {
      hostDisplay: getComputedStyle(host).display,
      overlayVisibility: of(".fbh-overlay", "visibility"),
      overlayPosition: of(".fbh-overlay", "position"),
      overlayBackground: of(".fbh-overlay", "background-color"),
      panelBackground: of(".fbh-panel", "background-color"),
      panelBorderRadius: of(".fbh-panel", "border-top-left-radius"),
      panelPadding: of(".fbh-panel", "padding-top"),
      titleFontSize: of(".fbh-title", "font-size"),
      titleColor: of(".fbh-title", "color"),
      titleLetterSpacing: of(".fbh-title", "letter-spacing"),
      titleTextTransform: of(".fbh-title", "text-transform"),
      titleFontStyle: of(".fbh-title", "font-style"),
      titleVisibility: of(".fbh-title", "visibility"),
      submitDisplay: of("#fbh-submit", "display"),
      submitBackground: of("#fbh-submit", "background-color"),
      inputBorderWidth: of(".fbh-input", "border-top-width"),
    };
  });

  // The host's own box: a `display: none !important` aimed at every div on the page cannot take
  // the panel off the screen, because a shadow tree's important declaration outranks the page's
  // for the same property on the same element.
  expect(styles.hostDisplay).toBe("block");
  // Inherited properties reach the shadow tree through the host whatever the selectors do, so
  // the outermost element inside declares them itself. `visibility: hidden` on every div hid the
  // whole panel until it did.
  expect(styles.overlayVisibility).toBe("visible");
  expect(styles.titleVisibility).toBe("visible");
  expect(styles.titleLetterSpacing).toBe("normal");
  expect(styles.titleTextTransform).toBe("none");
  expect(styles.titleFontStyle).toBe("normal");
  // Everything the page aimed at divs, paragraphs, buttons and inputs: none of it is in here.
  expect(styles.overlayPosition).toBe("fixed");
  expect(styles.overlayBackground).toBe("rgba(0, 0, 0, 0.42)");
  expect(styles.panelBackground).toBe("rgb(246, 246, 249)");
  expect(styles.panelBorderRadius).toBe("14px");
  expect(styles.panelPadding).toBe("0px");
  expect(styles.titleFontSize).toBe("15px");
  expect(styles.titleColor).toBe("rgb(27, 27, 31)");
  expect(styles.submitDisplay).toBe("block");
  expect(styles.submitBackground).toBe("rgb(31, 78, 216)");
  expect(styles.inputBorderWidth).toBe("1px");

  // And the panel is usable, not merely present.
  await page.fill("#fbh-text", "reported from a wrecked page");
  await page.click("#fbh-submit");
  await expect(page.locator(".fbh-message")).toHaveText("Sent.");
});

test("takes the app's own colours and stays readable in both themes", async ({ page }) => {
  await ready(page);
  const read = () =>
    page.evaluate(() => {
      const host = document.getElementById("fbh-host");
      const shadow = host.shadowRoot;
      const of = (selector, property) =>
        getComputedStyle(shadow.querySelector(selector)).getPropertyValue(property);
      return {
        hostTheme: host.dataset.theme,
        panel: of(".fbh-panel", "background-color"),
        text: of(".fbh-overlay", "color"),
        font: of(".fbh-overlay", "font-family"),
        tagBackground: of(".fbh-tag", "background-color"),
        tagText: of(".fbh-tag", "color"),
        primaryBackground: of("#fbh-submit", "background-color"),
        primaryText: of("#fbh-submit", "color"),
      };
    });

  await page.click("#open-feedback");
  await expect(page.locator(".fbh-row").first()).toBeVisible();
  const light = await read();
  expect(light.hostTheme).toBe("light");
  // The app's tokens, mapped onto the host from the page's own stylesheet: these are the demo
  // page's colours, not the panel's defaults, which is the whole of how theming works.
  expect(light.panel).toBe("rgb(246, 246, 249)");
  expect(light.text).toBe("rgb(27, 27, 31)");
  expect(light.primaryBackground).toBe("rgb(31, 78, 216)");
  expect(light.font).toBe("system-ui, sans-serif");
  // And these are the panel's own light defaults, for the properties the app did not map.
  expect(light.tagBackground).toBe("rgb(241, 241, 245)");

  await page.keyboard.press("Escape");
  await page.click("#toggle-theme");
  await page.click("#open-feedback");
  await expect(page.locator(".fbh-row").first()).toBeVisible();
  const dark = await read();
  expect(dark.hostTheme).toBe("dark");
  expect(dark.panel).toBe("rgb(28, 28, 34)");
  expect(dark.text).toBe("rgb(242, 242, 245)");
  expect(dark.tagBackground).toBe("rgb(43, 43, 51)");

  for (const [name, set] of [
    ["light", light],
    ["dark", dark],
  ]) {
    expect(contrast(rgb(set.text), rgb(set.panel)), `panel text, ${name}`).toBeGreaterThan(4.5);
    expect(contrast(rgb(set.tagText), rgb(set.tagBackground)), `tags, ${name}`).toBeGreaterThan(
      4.5,
    );
    expect(
      contrast(rgb(set.primaryText), rgb(set.primaryBackground)),
      `the submit button, ${name}`,
    ).toBeGreaterThan(4.5);
  }
});

test.describe("at a 200% browser zoom", () => {
  // What 200% zoom is, to the page: half as many CSS pixels each way, at twice the device pixel
  // ratio. The config already runs everything at a ratio of 2; this halves the viewport.
  test.use({ viewport: { width: 450, height: 350 } });

  test("still fits on the screen and can be used", async ({ page }) => {
    await ready(page);
    await page.click("#open-feedback");
    await expect(page.locator(".fbh-panel")).toBeVisible();

    // Every edge inside the viewport. This is the assertion that bites: a panel that cannot fit
    // overflows its flex container towards the start edge, so its x goes negative rather than its
    // width going over. Asking the document for a horizontal overflow instead would prove
    // nothing at all — the overlay is `position: fixed`, and a fixed element never adds to the
    // document's scrollable width however far past the viewport it goes.
    const box = await page.locator(".fbh-panel").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(451);
    expect(box.y + box.height).toBeLessThanOrEqual(351);

    await page.fill("#fbh-text", "reported from a small screen");
    await page.locator("#fbh-submit").scrollIntoViewIfNeeded();
    await expect(page.locator("#fbh-submit")).toBeInViewport();
    await page.click("#fbh-submit");
    await expect(page.locator(".fbh-message")).toHaveText("Sent.");
  });
});

test("draws on the screenshot at the image's own resolution", async ({ page, request }) => {
  const noise = watchConsole(page);
  await ready(page);
  await page.click("#open-feedback");
  await expect(page.locator(".fbh-thumb-draw").first()).toBeVisible();

  // The dialog only opens once the attached blob has decoded, and it decodes through an <img>
  // whose src is a blob: URL. In jsdom that element fires neither load nor error, so this path
  // had only ever been seen give up after its eight-second timeout; a dialog on screen in under
  // three seconds is that timeout not being what happened.
  await page.click(".fbh-thumb-draw");
  await expect(page.locator(".fbh-annotator-canvas")).toBeVisible({ timeout: 3000 });

  const canvas = await page.evaluate(() => {
    const node = document
      .getElementById("fbh-host")
      .shadowRoot.querySelector(".fbh-annotator-canvas");
    const rect = node.getBoundingClientRect();
    return {
      width: node.width,
      height: node.height,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      dpr: window.devicePixelRatio,
    };
  });
  // The attached screenshot is 1280 wide and the panel is not, so the canvas on screen is a good
  // deal smaller than its own backing store — which is the only arrangement in which a mapping
  // that forgot to scale, or scaled by the device pixel ratio instead, gives a wrong answer.
  expect(canvas.width).toBe(1280);
  expect(canvas.height).toBe(800);
  expect(canvas.dpr).toBe(2);
  expect(canvas.rect.width).toBeLessThan(canvas.width / 2);

  const y = canvas.rect.y + canvas.rect.height * 0.3;
  const from = canvas.rect.x + canvas.rect.width * 0.25;
  const to = canvas.rect.x + canvas.rect.width * 0.75;
  await page.mouse.move(from, y);
  await page.mouse.down();
  await page.mouse.move((from + to) / 2, y, { steps: 5 });
  await page.mouse.move(to, y, { steps: 5 });
  await page.mouse.up();
  await page.click("[data-save]");
  await expect(page.locator(".fbh-annotator")).toBeHidden();

  await page.fill("#fbh-text", "with a mark on it");
  await page.click("#fbh-submit");
  await expect(page.locator(".fbh-row").first()).toContainText("with a mark on it");

  // Worked out here from the canvas's displayed size, not read back from the code under test.
  const scaleX = canvas.width / canvas.rect.width;
  const scaleY = canvas.height / canvas.rect.height;
  const expected = {
    y: Math.round((y - canvas.rect.y) * scaleY),
    from: Math.round((from - canvas.rect.x) * scaleX),
    to: Math.round((to - canvas.rect.x) * scaleX),
  };

  const drawing = await page.evaluate(
    async ({ hub, want }) => {
      const blob = await (await fetch(`${hub}/_stub/screenshot`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvasEl = document.createElement("canvas");
      canvasEl.width = bitmap.width;
      canvasEl.height = bitmap.height;
      const ctx = canvasEl.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const isRed = (x, y) => {
        const i = (y * bitmap.width + x) * 4;
        return data[i] > 170 && data[i + 1] < 110 && data[i + 2] < 110;
      };
      // A few pixels of tolerance either way: the pen has width, and a stroke is drawn with a
      // round cap centred on the path.
      const anyRedNear = (x, y) => {
        for (let dy = -4; dy <= 4; dy += 1) {
          for (let dx = -4; dx <= 4; dx += 1) if (isRed(x + dx, y + dy)) return true;
        }
        return false;
      };
      let red = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 170 && data[i + 1] < 110 && data[i + 2] < 110) red += 1;
      }
      return {
        width: bitmap.width,
        height: bitmap.height,
        red,
        atStart: anyRedNear(want.from, want.y),
        atMiddle: anyRedNear(Math.round((want.from + want.to) / 2), want.y),
        atEnd: anyRedNear(want.to, want.y),
        // Far from the stroke, in both directions: a picture that came back red all over would
        // otherwise satisfy every line above.
        wellAbove: anyRedNear(Math.round((want.from + want.to) / 2), Math.round(want.y - 60)),
        beforeStart: anyRedNear(Math.max(4, want.from - 60), want.y),
      };
    },
    { hub: HUB, want: expected },
  );

  // Flattened at the image's own resolution: not the size it was displayed at, and not that
  // multiplied by the device pixel ratio either.
  expect(drawing.width).toBe(1280);
  expect(drawing.height).toBe(800);
  expect(drawing.atStart).toBe(true);
  expect(drawing.atMiddle).toBe(true);
  expect(drawing.atEnd).toBe(true);
  expect(drawing.wellAbove).toBe(false);
  expect(drawing.beforeStart).toBe(false);
  expect(drawing.red).toBeGreaterThan(500);

  const bundle = await lastBundle(request);
  expect(bundle.parts).toContain("screenshot");
  expect(noise).toEqual([]);
});

test("never breaks the host application, even one whose every hook throws", async ({
  page,
  request,
}) => {
  const crashes = [];
  page.on("pageerror", (error) => crashes.push(String(error)));
  await ready(page, { breakhooks: "1" });

  // The app's own handlers still run, before and while the panel is open.
  await page.click("#host-click");
  await expect(page.locator("#host-clicks")).toHaveText("1");

  await page.click("#open-feedback");
  await expect(page.locator(".fbh-panel")).toBeVisible();
  await page.fill("#fbh-text", "the app around me is broken");
  await page.click("#fbh-submit");
  await expect(page.locator(".fbh-message")).toHaveText("Sent.");

  const bundle = await lastBundle(request);
  // Each broken hook degrades to its fallback rather than taking the submit down with it.
  expect(bundle.report.reporter).toBe(null);
  expect(bundle.report.page.view).toBe("");
  expect(bundle.report.page.theme).toBe("light");
  expect(bundle.report.text).toBe("the app around me is broken");

  // And once it is closed the page is the app's own again: the host element is still in the
  // document, and nothing of it stands between a colleague and their own buttons.
  await page.keyboard.press("Escape");
  await expect(page.locator(".fbh-panel")).toBeHidden();
  await page.click("#host-click");
  await expect(page.locator("#host-clicks")).toHaveText("2");
  expect(crashes).toEqual([]);
});

test.describe("with the real recorder and the real screenshot", () => {
  test("fetches each of the three only when it is needed", async ({ page }) => {
    const seen = new Set();
    page.on("request", (request) => seen.add(new URL(request.url()).pathname));
    const { recorder, screenshot, panel } = chunks();

    // A page with the recording switched off, left alone. The window has to be long enough for a
    // fetch to have happened if one were going to: the same window is shown to be long enough by
    // the second half of this test, where the recorder does arrive in it.
    await ready(page, { real: "1", replay: "0" });
    // The dot starts at "0" and is rewritten the moment the first listing lands, which is the
    // same idle callback the recorder would have been fetched on.
    await expect(page.locator("#dot")).not.toHaveText("0");
    await page.waitForTimeout(1500);
    expect([...seen].filter((one) => [recorder, screenshot, panel].includes(one))).toEqual([]);

    // Opening the panel fetches the panel itself — the size budget is kept by not downloading it
    // until now — and takes a screenshot, so only then is that module worth fetching either.
    await page.click("#open-feedback");
    await expect(page.locator(".fbh-thumb figcaption").first()).toHaveText("Screenshot");
    expect(seen.has(panel)).toBe(true);
    expect(seen.has(screenshot)).toBe(true);
    expect(seen.has(recorder)).toBe(false);

    // With the recording on, the recorder is fetched without anyone opening anything: it has to
    // be running before there is something to report. That is the one way in which these two are
    // not alike, and it is deliberate.
    seen.clear();
    await ready(page, { real: "1" });
    await expect(page.locator("#dot")).not.toHaveText("0");
    await page.waitForTimeout(1500);
    expect(seen.has(recorder)).toBe(true);
    expect(seen.has(screenshot)).toBe(false);
    expect(seen.has(panel)).toBe(false);
  });

  test("sends a screenshot with the blanked region blank, as pixels", async ({ page }) => {
    await ready(page, { real: "1" });
    await openWithRecording(page);
    await page.fill("#fbh-text", "look at the picture");
    await page.click("#fbh-submit");
    await expect(page.locator(".fbh-row").first()).toContainText("look at the picture");

    const raster = await screenshotPixels(page);
    // The two swatches are the same size and the same kind of thing; one is inside the element
    // the app named in `capture.blank` and one is not.
    expect(raster.counts.open).toBeGreaterThan(5000);
    expect(raster.counts.blanked).toBe(0);
    // The panel itself is not in its own screenshot: its backdrop is black at 42%, so a picture
    // that had caught it would have almost no pure white left in it.
    expect(raster.counts.white).toBeGreaterThan(raster.pixels * 0.5);
  });

  test("records a child document without carrying its secrets out", async ({ page, request }) => {
    await ready(page, { real: "1" });
    await openWithRecording(page);
    await page.fill("#fbh-text", "recording the frames too");
    await page.click("#fbh-submit");
    await expect(page.locator(".fbh-row").first()).toContainText("recording the frames too");

    const bundle = await lastBundle(request, Object.values(MARKERS));
    expect(bundle.parts).toContain("replay");
    expect(bundle.replay.events).toBeGreaterThan(1);

    // The controls. Ordinary text from the page and from the same-origin child frame is in the
    // recording — which is also the only proof available that the recorder walked into the child
    // document at all, a path jsdom cannot run.
    expect(bundle.found.replay).toContain(MARKERS.PUBLIC);
    expect(bundle.found.replay).toContain(MARKERS.IFRAME_PUBLIC);
    // Text rendered inside a srcdoc frame is on screen, so it is recorded like any other visible
    // text. What must not appear is anything that was only ever in the srcdoc attribute itself:
    // the comment below it is in the attribute and nowhere else.
    expect(bundle.found.replay).toContain(MARKERS.SRCDOC);

    // And everything private, in the page and in the child frame alike: the password, the region
    // the app asked to blank, the token in a link's query string, and the part of the srcdoc
    // attribute that was never rendered.
    expect(bundle.found.replay.filter((one) => PRIVATE_MARKERS.includes(one))).toEqual([]);
    expect(bundle.found.report).toEqual([]);
  });
});
