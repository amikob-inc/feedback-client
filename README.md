# feedback-client

The in-app "report an issue or suggestion" panel for the amikob dashboards. It captures what
happened in the page — console, errors, network, a click trail, a session replay and a screenshot —
and posts it to [`feedback-hub`](https://github.com/amikob-inc/feedback-hub), which files it,
answers it, or turns it into a pull request. Framework-free, no build step, MIT.

## Install

```sh
pnpm add github:amikob-inc/feedback-client#v0.1.0
```

The package is plain ES modules under `src/`; your bundler (Vite in both dashboards) does the rest.
`@rrweb/record` and `modern-screenshot` come with it and are loaded with dynamic `import()`, so
they land in their own chunks and only when they are needed.

## Mount it

```js
import { mountFeedback } from "@amikob/feedback-client";

const feedback = mountFeedback({
  hubUrl: APP_ENV.feedbackHubUrl, // "" or undefined: the feature is off and the button is hidden
  app: "cad",
  env: APP_ENV.name,
  version: APP_ENV.gitSha,
  getToken: async () => (await supa.auth.getSession()).data.session?.access_token ?? null,
  user: () => {
    const u = currentUser();
    return u && { id: u.id, name: u.display_name || u.name, email: u.email, role: u.role };
  },
  section: () => state.view,
  sections: ["Rendering", "Mockups", "Catalog (SKU)", "General"],
  types: ["Bug", "Efficiency suggestion", "Question", "Other"],
  button: "#topbar-issues",
  theme: () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"),
  onSummary: ({ attention }) =>
    document.getElementById("topbar-issue-dot")?.classList.toggle("show", attention > 0),
  capture: {
    replay: true,
    screenshot: true,
    console: true,
    network: true,
    maskAllInputs: false,
    blank: [],
  },
});
```

Every function is called lazily, at open or at submit, so mounting reads no app state and the
module can be imported in any order. An unknown option throws at mount, so a typo is found in
development. `getToken` returning `null` disables submit with "Sign in to report".

`mountFeedback` returns `{ open, close, submit(fields), list(), reply(id, text), retry(id), destroy }`.
An app that wants its own UI can use those and never open the built-in panel.

`open()` returns a promise. The panel is loaded on demand — it is fetched the first time it is
opened, never on page load — so the promise resolves once the panel is on the page, and code that
inspects the DOM right after calling `open()` sees nothing yet. It never rejects: if the panel's
chunk cannot be fetched (offline, a deployment that replaced it) the library warns once and
resolves, and the next `open()` tries again. Wiring `open` to a button needs no `await`.

## Theming

The panel renders in a Shadow DOM and takes its colours from thirteen custom properties with light
and dark defaults. Map your own tokens onto the host element from your own stylesheet:

```css
#fbh-host {
  --fbh-bg: var(--bg);
  --fbh-panel: var(--panel);
  --fbh-text: var(--text);
  --fbh-muted: var(--text-mute);
  --fbh-hairline: var(--hairline);
  --fbh-border: var(--border-strong);
  --fbh-accent: var(--accent);
  --fbh-accent-on: var(--accent-on);
  --fbh-danger: var(--danger);
  --fbh-success: var(--success-strong);
  --fbh-tag-bg: var(--hi-bg);
  --fbh-tag-text: var(--hi);
  --fbh-font: "Instrument Sans", sans-serif;
}
```

`theme()` sets `data-theme` on the host, which is what the dark defaults key off.

### What the shadow root does and does not keep out

Checked in a real browser against a page whose stylesheet sets out to wreck everything it can
reach (`e2e/panel.spec.js`). Your selectors never reach inside the panel, and the panel's never
reach out. Two things do cross the boundary, because the host element is an ordinary node in your
page:

- **Properties set on the host element itself.** `display` is held down with `!important` from
  inside, so a page-wide reset cannot delete the panel; the `hidden` attribute is the deliberate
  way to hide it. Inherited properties — `visibility`, typography — are declared again on the
  panel's own outermost element, so they do not flow through either.
- **`opacity`, `filter`, `transform` and their like on the host.** These apply to the host's box
  and take its whole shadow tree with them, and nothing declared inside can undo that. A page that
  dims every `div` dims the panel too. If your reset does that, exclude `#fbh-host` from it.

## Privacy

Passwords are always masked in the replay and the click trail. `maskAllInputs: true` masks every
typed value in both. `blank: [".sku-price"]` blanks matching elements in the replay
(rrweb's `blockSelector`), withholds them from the click trail, and empties them in the screenshot
— which the browser test checks by reading the sent picture back as pixels. The screenshot is a
picture of what is on screen: it masks passwords and empties `blank` elements, and nothing else —
a value typed into an ordinary field is in it, `maskAllInputs` or not. Request headers, cookies
and query strings are never captured, and neither is a URL fragment that carries parameters
(`#access_token=…`, where supabase-js's implicit flow lands a session); a plain route fragment
(`#batch-12`) is kept. The reporter sees what is attached before sending and can leave the
recording out. The only network destination is `hubUrl`.

Same-origin `<iframe>`s are part of the recording, and the same masking and the same `blank`
selectors apply inside them. An `<iframe srcdoc>`'s attribute is withheld whole, because it can
carry parts of a document that are never on screen; what the frame actually renders is recorded
like any other visible content.

The library sends **no bespoke copy of your page**. It had one until 2026-09-21; three consecutive
adversarial reviews got sensitive data through it, each through a different hiding place, so it was
removed rather than hardened again. What a page looked like comes from the screenshot and from the
replay's own first event, a masked snapshot taken by rrweb.

## Size

The budget is what a dashboard downloads for this library on a page load: under **15 KB
gzipped**, minified, built with code splitting the way an app's bundler builds it. v0.1.0 is
**11.3 KB** (`pnpm size`, which prints the number and fails if it grows past a ceiling just above
it). The panel — its markup, its list and its stylesheet, another 9.5 KB — is a chunk of its own,
fetched the first time `open()` is called, which is why `open()` returns a promise. The two
dependencies are chunks of their own too: the recorder is fetched on the first idle moment after
mount, the screenshot module when a screenshot is taken. `pnpm size` fails if any of the three
becomes a static import.

## Develop

```sh
pnpm install
pnpm test          # vitest, node and jsdom
pnpm lint
pnpm format:check
pnpm size          # the minified, gzipped size against the budget and the current ceiling
pnpm demo          # builds the demo bundle and serves it: http://localhost:8787/demo/index.html
pnpm test:e2e      # Playwright, on a stub hub and a bundle of its own (stop `pnpm demo` first)
```

`tests/stub-hub.mjs` stands in for the hub: it answers the four client routes with canned data, it
serves the repository so the demo page has an origin, and it is addressed as `127.0.0.1` while the
page is on `localhost`, so every call in the demo and the browser test is a real cross-origin
request with a preflight. The demo page's switches are documented at the top of `demo/demo.js`:
`?real=1` runs the real recorder and the real screenshot from a bundled entry, `?hostile=1` adds
the page-wide stylesheet, `?breakhooks=1` makes every hook the app supplies throw.

`fixtures/status-cases.json` is shared with `feedback-hub`: it is the list of verdict and GitHub
states and the exact label the panel shows for each. Both repositories assert the same digest of
it, so changing it means a pull request in both.

## Release

Tag it; consumers install the tag.

```sh
# after CI is green on main
git tag -a v0.1.0 -m "feedback-client v0.1.0"
git push origin v0.1.0
```
