// The demo harness: one page that mounts the panel the way a dashboard does, plus the switches
// the browser test needs to ask the awkward questions. Everything is driven from the query string
// so a person can reach the same states by hand.
//
//   ?real=1       the bundle tools/build-demo.mjs produced, which resolves the two lazy
//                 dependencies' bare specifiers — the only mode that runs the real recorder and
//                 the real screenshot. Without it the sources are loaded straight from disk and
//                 stand-ins take their place, because a browser with no bundler cannot resolve
//                 `@rrweb/record` or `modern-screenshot` and the point of the default mode is to
//                 exercise the panel, the bundle and the transport rather than those two.
//   ?replay=0     mount with the recording switched off, which is also how a page that never
//                 loads the recorder is demonstrated.
//   ?theme=dark   the app's own theme, which the panel is asked for on every open.
//   ?hostile=1    a page-wide stylesheet that sets out to wreck everything it can reach, to show
//                 what the shadow root does and does not keep out.
//   ?breakhooks=1 every hook the app supplies throws. The panel must still work: this library
//                 may never break the host application, and a host that is already broken is the
//                 sharpest form of that promise.
//   ?hub=...      where the stub hub is. Defaults to 127.0.0.1 on this port while the page itself
//                 is served from localhost, so every call is a genuine cross-origin request with
//                 a preflight, exactly as it will be in production.
import { mountFeedback } from "../src/index.js";
import { MARKERS, SWATCHES } from "./markers.js";

const params = new URLSearchParams(location.search);
const hubUrl = params.get("hub") || `${location.protocol}//127.0.0.1:${location.port}`;
const useFakes = params.get("real") !== "1";
const replay = params.get("replay") !== "0";
const brokenHooks = params.get("breakhooks") === "1";
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
let signedIn = true;

function swatch(color) {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 40;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = `rgb(${color.join(",")})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

// One source for every marker: the page plants them from the same constants the test reads back,
// so a renamed marker cannot quietly turn an assertion into one that can never fail.
document.getElementById("public-text").textContent =
  `Ordinary public text on this page: ${MARKERS.PUBLIC}`;
document.getElementById("blanked-text").textContent = `Cost price: ${MARKERS.BLANKED}`;
document.getElementById("secret-input").value = MARKERS.PASSWORD;
document.getElementById("token-link").href =
  `${location.origin}/demo/somewhere?token=${MARKERS.TOKEN}#anchor`;
document.getElementById("swatch-open").src = swatch(SWATCHES.OPEN);
document.getElementById("swatch-blanked").src = swatch(SWATCHES.BLANKED);
document.getElementById("child-srcdoc").srcdoc =
  `<!doctype html><p>Inside a srcdoc frame: ${MARKERS.SRCDOC}</p><!-- ${MARKERS.SRCDOC_HIDDEN} -->`;

if (params.get("hostile") === "1") {
  // Not a straw man: this is the shape of a real page-wide reset, aimed at element types rather
  // than at `*`, so the document still has a body to render into. It sets every property that
  // would be visible if it reached the panel — including the two that can end a panel outright,
  // `display` and `visibility` — so what survives inside the shadow root is the answer to "is
  // this really isolated", not a guess.
  const style = document.createElement("style");
  style.id = "hostile";
  style.textContent = `
    div, p, section, header, ul, li, figure, figcaption, h1, h2, h3, time, span,
    button, input, select, textarea, label, a, img {
      all: revert !important;
      display: none !important;
      visibility: hidden !important;
      color: #ff00ff !important;
      background: #00ff00 !important;
      font: italic 40px/3 "Comic Sans MS", cursive !important;
      border: 6px dashed #ff0000 !important;
      border-radius: 0 !important;
      padding: 30px !important;
      margin: 30px !important;
      letter-spacing: 6px !important;
      text-transform: uppercase !important;
      opacity: 0.3 !important;
      position: static !important;
      z-index: auto !important;
      box-shadow: none !important;
    }
  `;
  document.head.appendChild(style);
}

function boom(what) {
  throw new Error(`the host app's ${what} hook is broken`);
}

async function makePng(width, height, color) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  // A shape with a known centre, so a drawing saved over this stand-in can be told apart from the
  // stand-in itself.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(width / 4, height / 4, width / 2, height / 2);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Stand-ins for the two lazy dependencies, used in every mode except `?real=1`. They have the
// same shape the library calls: `domToBlob` for the screenshot, and a `record()` that emits a
// full snapshot straight away and an incremental event twice a second, returning the stop handle
// the library insists on.
const fakes = {
  // 1280 × 800 on purpose: wider than the panel, so the annotator's canvas is displayed scaled
  // down and the mapping from a pointer position to an image pixel has real work to do.
  loadScreenshot: async () => ({ domToBlob: async () => makePng(1280, 800, "#8ec5ff") }),
  loadRecorder: async () => ({
    record(options) {
      options.emit({ type: 2, timestamp: Date.now(), data: { node: "demo snapshot" } }, true);
      const timer = setInterval(() => options.emit({ type: 3, timestamp: Date.now() }, false), 500);
      return () => clearInterval(timer);
    },
  }),
};

const feedback = mountFeedback(
  {
    hubUrl,
    app: "cad",
    env: "demo",
    version: "demo-sha",
    getToken: async () => (signedIn ? "demo-token" : null),
    user: () =>
      brokenHooks ? boom("user") : { id: "demo", name: "Dana", email: "dana@example.com" },
    section: () => (brokenHooks ? boom("section") : "Rendering"),
    sections: ["Rendering", "Mockups", "Catalog (SKU)", "General"],
    types: ["Bug", "Efficiency suggestion", "Question", "Other"],
    button: "#open-feedback",
    theme: () => (brokenHooks ? boom("theme") : document.documentElement.dataset.theme),
    onSummary: ({ attention }) => {
      if (brokenHooks) boom("onSummary");
      document.getElementById("dot").textContent = String(attention);
    },
    capture: {
      replay,
      screenshot: true,
      console: true,
      network: true,
      maskAllInputs: false,
      blank: [".secret"],
    },
  },
  useFakes ? fakes : {},
);

document.getElementById("toggle-theme").addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
});

document.getElementById("toggle-signin").addEventListener("click", (event) => {
  signedIn = !signedIn;
  event.target.textContent = signedIn ? "Sign out" : "Sign in";
});

// A host handler of the app's own, to show the page still works while the panel is mounted and
// while it is open.
let hostClicks = 0;
document.getElementById("host-click").addEventListener("click", () => {
  hostClicks += 1;
  document.getElementById("host-clicks").textContent = String(hostClicks);
});

window.feedback = feedback;
window.demoReady = true;
