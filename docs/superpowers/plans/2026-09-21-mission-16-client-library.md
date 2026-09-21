# Feedback client library implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@amikob/feedback-client` v0.1.0: the framework-free browser library that captures what happened in an app, shows the "report an issue or suggestion" panel, and talks to the feedback hub — installable by git tag by cad-dashboard and, later, the FWD dashboard.

**Architecture:** Four in-memory ring buffers (console, errors, network, breadcrumbs) and an rrweb recorder run from mount; at submit a pure bundle builder turns them plus a screenshot, a DOM snapshot and the replay into one `multipart/form-data` POST to the hub. `mountFeedback()` is headless — buffers, transport and the report/list/reply/retry functions — and the Shadow-DOM panel is a consumer of that same API, so an app can bring its own UI. Every module is a leaf or close to it: the buffers, the bundle builder, the status map and the transport are pure and testable without a DOM; only `src/panel/*` and `src/capture/*` touch one.

**Tech Stack:** Plain ES modules (no build step), JavaScript with JSDoc plus a hand-written `types/index.d.ts`, pnpm, ESLint flat config with `no-undef`, Prettier, Vitest (node by default, jsdom per file), Playwright against a `node:http` stub hub, GitHub Actions. Lazy runtime dependencies: `@rrweb/record` ^2.1.4 and `modern-screenshot` ^4.7.0.

**Spec:** docs/superpowers/specs/2026-09-16-mission-16-feedback-hub-design.md

## Global Constraints

- Package name `@amikob/feedback-client`, version `0.1.0`, MIT, public repository `amikob-inc/feedback-client`.
- `"type": "module"`, `"exports": { ".": "./src/index.js" }`, **no build step**: what is committed is what consumers import; Vite in each app bundles it.
- Consumers install by tag: `pnpm add github:amikob-inc/feedback-client#v0.1.0`. Releases are git tags `v0.x.y` with a CHANGELOG entry. No `prepare` script, nothing generated at install time.
- Runtime dependencies `@rrweb/record` (^2.1.4) and `modern-screenshot` (^4.7.0), both loaded with dynamic `import()`: the recorder after the first idle callback, the screenshot module only when a screenshot is taken.
- Size budget: the library's own code **under 15 KB gzipped** (minified, the two lazy dependencies excluded); the recorder is about 35 KB gzipped and lazy.
- Buffer sizes, verbatim: console **200 entries, each cut at 1 KB**; errors **20**; network **50**, kept when status ≥ 400, thrown, or slower than **3 s**; breadcrumbs **100**; click text cut at **60** characters; changed input values cut at **40**.
- Replay: `checkoutEveryNms: 60000`, `maskInputOptions: { password: true }`, `sampling: { mousemove: 50, scroll: 150, input: "last" }`, `recordCanvas: false`; two segments (current and previous, 60–120 s); over **8 MB** serialized the previous segment is dropped first.
- Bundle caps, verbatim: `report` 512 KB, `screenshot` 5 MB, `dom` 3 MB compressed, `replay` 8 MB compressed, `image` 6 files of 5 MB each, total under **25 MB**. Report text ≤ **5,000** characters, a reply ≤ **2,000** characters.
- Screenshot options: `domToBlob(document.body, { scale: 1, timeout: 5000 })`.
- Mount option keys, verbatim and exhaustive: `hubUrl`, `app`, `env`, `version`, `getToken`, `user`, `section`, `sections`, `types`, `button`, `theme`, `onSummary`, `capture`; `capture` keys are `replay`, `screenshot`, `console`, `network`, `maskAllInputs`, `blank`. **Unknown options throw at mount.**
- Handle, verbatim: `mountFeedback()` returns `{ open, close, submit(fields), list(), reply(id, text), retry(id), destroy }`.
- `hubUrl` empty or undefined: the feature is off and the button is hidden. `getToken` returning `null` disables submit with "Sign in to report".
- Theming custom properties, verbatim: `--fbh-bg`, `--fbh-panel`, `--fbh-text`, `--fbh-muted`, `--fbh-hairline`, `--fbh-border`, `--fbh-accent`, `--fbh-accent-on`, `--fbh-danger`, `--fbh-success`, `--fbh-tag-bg`, `--fbh-tag-text`, `--fbh-font`. The host element's id is `fbh-host` and carries `data-theme`.
- Status strings the panel shows, verbatim (they are `statusLabel`'s output in the hub): `Received, being looked at`, `Received, waiting`, `Filed as #N` (`Filed` with no number), `Fix in progress`, `Fixed`, `Closed`, `Answered`, `Already tracked as #M` (` (open)`, ` (fixed)`, ` (closed)` appended when the original's state is known), `Needs your reply`, `Not filed`, `Could not triage`.
- Privacy: passwords are always masked in replay, DOM snapshot and breadcrumbs; `maskAllInputs: true` masks every typed value in all three; `blank: [...]` blanks matching elements in the replay (`blockSelector`) and the DOM snapshot; request headers, cookies and **query strings are never captured**; the only network destination is `hubUrl`; no third-party calls.
- Failure handling: a patch that throws falls back to the original function and the library logs **once** with `console.warn`; a failed screenshot is omitted, not fatal; a failed submit keeps the form and offers Retry; `401` says "Your session expired; sign in again"; `413` says which attachment to drop.
- Line endings **LF** everywhere; `pnpm lint` exits 0 (warnings allowed); `pnpm format:check` and `pnpm test` pass; conventional commit messages; delete, don't comment out.
- The hub is another origin and every client route checks the `Origin` header against the app's anchored patterns. CORS allows only the headers `Authorization` and `Content-Type` and no credentials: **never send a custom header and never `credentials: "include"`**.

## Where the spec and the hub's real code differ

The hub at `amikob-inc/feedback-hub` is built and deployed; where it and §5/§6.3 disagree, the code wins. Checked against `service/src/routes.ts`, `intake.ts`, `listing.ts`, `status.ts`, `config.ts`.

1. **`?app=` is required on the reply and retry routes too.** §6.3's table names it only on `GET /v1/reports`, but `routes.ts` calls `resolveApp(config, c.req.query("app") ?? "")` in `POST /v1/reports/:id/replies` and `.../retry` as well; without it the hub answers `404 unknown_app`. `POST /v1/reports` is the exception: it reads the app from the `report` part's `app` field. **Chosen:** the transport appends `?app=<app>` to list, reply and retry, and to nothing else.
2. **`GET /v1/reports` also takes `cursor` and `limit`** (`limit` clamped to 1..50, `LIST_LIMIT = 50`), unmentioned in §5. **Chosen:** the transport supports both, the panel passes neither (the newest 50 is the whole list).
3. **A listing item carries more than §5.4 describes**: `label` (already the exact `statusLabel` string), `verdict` (`summary`, `issueNumber`, `issueUrl`, `duplicateOf`, `answer`, `questions[]`, `reason`, `candidate`, `receivedAt`), `issue`, `pullRequest`, `duplicateOf`, `progress` (the bot's latest comment, 300 characters), `degraded`, `replies[]`, `reporter: { id, name }`. **Chosen:** the panel renders the hub's `label` verbatim and falls back to its own `statusLabel()` only when `label` is absent (optimistic rows); `progress` is shown under "Fix in progress"; `degraded` is ignored by the panel (the status is still right, only the GitHub extras are missing).
4. **`duplicate` labels carry the original's state**, `Already tracked as #8 (fixed)` — §4's table shows the bare form. Both exist: the parenthesis is added only when the hub could read the original issue. **Chosen:** the shared fixture covers all four shapes.
5. **`filed` with no issue number produces the bare `Filed`.** Not in §4's table; it is a real branch of `statusLabel`. **Chosen:** covered in the fixture, rendered by the panel.
6. **A stale dispatch becomes `error` after 20 minutes** (`TRIAGE_TIMEOUT_MS`), so "Could not triage" appears without any verdict at all. §4 implies a verdict is needed. **Chosen:** the panel offers Retry on `error` whatever its cause, which the hub accepts (`retry` allows `waiting` and `error` only).
7. **Retry can answer `409 not_retryable`** when the report has moved on, and a retry within two minutes of the last dispatch is silently deferred (`REDISPATCH_MIN_AGE_MS`) and comes back as `waiting`. §5 does not mention either. **Chosen:** `409` is shown as "This report has already moved on." and the list refreshes; a deferred retry needs no special case.
8. **`413` messages name the part**: `report`/`screenshot`/`dom`/`replay`/`image`/`bundle`/`request` followed by ` exceeds N bytes` (or `image count exceeds 6`). **Chosen:** the transport parses the first word and turns it into the "which attachment to drop" sentence §5.8 asks for.
9. **The hub validates the `image` parts' MIME type strictly** (`image/png` or `image/jpeg`, else `400 invalid_image`) while it overwrites the stored type of `screenshot`, `dom` and `replay` with its own. **Chosen:** the form refuses anything that is not PNG or JPEG before it reaches the bundle, and the annotator and the screen capture always produce PNG.
10. **Rate limit**: 20 reports per rolling hour per reporter → `429 rate_limited`; replies are capped at 50 per report → `429 too_many_replies`. Not in §5. **Chosen:** both have their own message in the transport's map.
11. **`202` on submit carries only `{ id }`** — no status, no label. **Chosen:** the optimistic row is labelled with the client's own `statusLabel("triaging", {})`, which is exactly "Received, being looked at".
12. **Spec-internal conflict — when the screenshot is taken.** §5.3 says the screenshot module is loaded "only at submit"; §5.4 says the attachment strip shows "the automatic screenshot's thumbnail (removable)" while the form is being filled in. A screenshot taken at submit would also have the panel in it. **Chosen:** the panel captures when it opens, before the overlay is made visible, and passes the blob to `submit()`; a headless `submit()` with no `screenshot` field captures one itself at submit time, which is §5.3's path. A `filter` option is added to `domToBlob` so the panel's own host element can never appear in the capture; everything else about the call is verbatim.
13. **Spec §5.9 says the stub hub is "an Express file in `tests/`".** **Chosen:** `tests/stub-hub.mjs` on `node:http`, no dependency added; it speaks the same four routes with the same JSON shapes. Express would be the only devDependency whose job a dozen lines of Node already do.

---

## File Structure

| Path | Responsibility |
|---|---|
| `package.json` | name, version, `exports`, the two lazy runtime dependencies, scripts (`test`, `lint`, `format`, `format:check`, `test:e2e`, `size`) |
| `eslint.config.mjs` | flat config: `src/` and `demo/` browser globals with `no-undef`, `tests/`, `e2e/`, `tools/` Node |
| `.prettierrc`, `.prettierignore`, `.editorconfig`, `.gitattributes`, `.gitignore` | formatting and LF endings |
| `vitest.config.js` | node environment by default; jsdom opted into per file with a docblock |
| `playwright.config.js` | one chromium project, `webServer` runs `tests/stub-hub.mjs` |
| `.github/workflows/ci.yml` | `checks` (lint, format:check, test) and `e2e` (Playwright against the stub hub) |
| `src/index.js` | the public barrel: `mountFeedback`, `statusLabel`, `STATUSES`, `CLIENT_ID`, `CLIENT_VERSION`, `FeedbackError` |
| `src/version.js` | `CLIENT_VERSION`, `CLIENT_ID` (`feedback-client/0.1.0`), the string the report carries |
| `src/warn.js` | `warnOnce(label, err, warn)` — one `console.warn` per subsystem, ever |
| `src/bytes.js` | `byteLength(text)` — UTF-8 length, used by the caps |
| `src/buffers/ring.js` | `Ring` (fixed-size, pure) and `cut(text, max)` |
| `src/buffers/console.js` | patches the five console methods; `describeValue`, `describeError`, entry `{t, level, text}` |
| `src/buffers/errors.js` | `error` and `unhandledrejection` listeners; entry `{t, message, stack}` |
| `src/buffers/network.js` | patches `fetch` and `XMLHttpRequest`; `scrubUrl`, `shouldRecord`; entry `{t, method, url, status, ms}` |
| `src/buffers/breadcrumbs.js` | clicks, changes, submits, route changes, visibility, online/offline; `describeClickTarget`, `describeFieldChange` |
| `src/buffers/install.js` | `installBuffers({ win, doc, capture })` — the four buffers behind one handle with one `uninstall()` |
| `src/capture/gzip.js` | `gzip(text)` through `CompressionStream`, `null` when it is missing |
| `src/capture/dom.js` | `snapshotDom(doc, { maskAllInputs, blank })`: clone, stamp values, mask, drop `<script>`, blank selectors |
| `src/capture/replay.js` | `createSegments`, `serializeReplay`, `rrwebOptions`, `startReplay` (lazy recorder, idle start, two-segment checkout) |
| `src/capture/screenshot.js` | `captureScreenshot()` through the lazy `modern-screenshot`, host element filtered out, 5 MB cap |
| `src/capture/screen.js` | `captureScreen({ doc, win })`: `getDisplayMedia` to one PNG still, tracks stopped |
| `src/bundle.js` | `CAPS`, `buildReport`, `fitReport`, `buildBundle` (the `FormData` and every cap), `describeAttachments` — pure, no DOM |
| `src/status.js` | `STATUSES`, `statusLabel`, `originalState`, `labelContext`, `isRetryable`, `needsReply`, `statusTone` — the hub's map, mirrored |
| `src/transport.js` | `createTransport({ hubUrl, app, getToken, fetch })`: submit, list, reply, retry; `FeedbackError`, `messageFor` |
| `src/seen.js` | per-reporter `localStorage` "seen" map, `attentionIds`, `markSeen` |
| `src/options.js` | `normalizeOptions` (throws `OptionError` on an unknown key), `DEFAULT_CAPTURE`, `DEFAULT_TYPES`, `defaultSection` |
| `src/mount.js` | `mountFeedback(options, deps)`: buffers, replay, transport, the seven handle functions, `pageContext`, the summary poll |
| `src/panel/dom.js` | `el()`, `clear()`, `firstLine()`, `relativeTime()` — no `innerHTML` anywhere in the panel |
| `src/panel/styles.js` | `PANEL_CSS`: the thirteen custom properties with light and dark defaults, and the panel's rules |
| `src/panel/panel.js` | the host element, the shadow root, the overlay, `role="dialog"`, the focus trap, Escape, theming |
| `src/panel/form.js` | the report form: selects, textarea, attachment strip, paste, attach, capture screen, "What will be sent", submit states |
| `src/panel/annotate.js` | the red pen: stroke state, `drawStrokes`, `flatten` to a PNG at the image's own resolution, undo and clear |
| `src/panel/list.js` | "My reports": rows, status pills, answers, questions and the reply box, Retry, issue and PR links, 30 s polling |
| `fixtures/status-cases.json` | the 23 verdict-and-GitHub-state cases shared with the hub (canonical copy) |
| `types/index.d.ts` | hand-written types for the mount options, the handle, a report summary and the status union |
| `tests/*.test.js` | one file per module; node by default, `@vitest-environment jsdom` where a DOM is needed |
| `tests/helpers/fake-window.js` | the event-target/console/history doubles the buffer tests patch |
| `tests/stub-hub.mjs` | the stand-in hub for the demo and Playwright: the four client routes, CORS, `/_stub/last`, static files |
| `tools/size.mjs` | bundles `src/index.js` with esbuild (externals: the two lazy dependencies), minifies, gzips, prints the number |
| `demo/index.html`, `demo/demo.js` | the demo page the Playwright run drives: mount, theme switch, fake loaders, sign-out switch |
| `e2e/panel.spec.js` | Playwright: submit in both themes, every status in the list, the signed-out state, a clean console |
| `CHANGELOG.md`, `README.md` | the 0.1.0 entry; the mount recipe, the options table, theming, privacy and the release steps |

---

### Task 1: The package, its tooling and CI

**Files:**
- Create: `package.json`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.prettierrc`, `.prettierignore`, `eslint.config.mjs`, `vitest.config.js`, `src/version.js`, `src/warn.js`, `.github/workflows/ci.yml`
- Test: `tests/version.test.js`, `tests/warn.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/version.js`: `CLIENT_VERSION: string` (`"0.1.0"`), `CLIENT_ID: string` (`"feedback-client/0.1.0"`).
  - `src/warn.js`: `warnOnce(label: string, err: unknown, warn?: (msg: string) => void): void`, `resetWarnings(): void`.
  - Scripts: `pnpm test`, `pnpm lint`, `pnpm format`, `pnpm format:check`.

**Steps:**

- [ ] 1. Create `package.json`:

```json
{
  "name": "@amikob/feedback-client",
  "version": "0.1.0",
  "description": "In-app feedback panel for the amikob dashboards: capture buffers, session replay, screenshot and the report panel, framework-free",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/amikob-inc/feedback-client.git" },
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": "./src/index.js",
    "./fixtures/status-cases.json": "./fixtures/status-cases.json",
    "./package.json": "./package.json"
  },
  "engines": { "node": ">=20" },
  "packageManager": "pnpm@12.3.4",
  "scripts": {
    "test": "vitest run",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@rrweb/record": "^2.1.4",
    "modern-screenshot": "^4.7.0"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@playwright/test": "^1.63.0",
    "eslint": "^10.10.0",
    "globals": "^17.12.0",
    "jsdom": "^27.0.0",
    "prettier": "^3.9.6",
    "vitest": "^5.0.1"
  }
}
```

There is no `build`, no `prepare` and no `files`: consumers install the repository at a tag and import `src/` directly. If `pnpm install` reports that `jsdom@^27.0.0` does not exist, run `pnpm add -D jsdom@latest` and keep whatever range it writes; same for any other devDependency whose major has moved on. `@playwright/test` is installed now so the lockfile is complete, and used in Task 14.

- [ ] 2. Create the dotfiles.

`.gitignore`:

```
node_modules/
playwright-report/
test-results/
*.log
```

`.gitattributes`:

```
* text=auto eol=lf
```

`.editorconfig`:

```
root = true
[*]
end_of_line = lf
insert_final_newline = true
charset = utf-8
indent_style = space
indent_size = 2
```

`.prettierrc`:

```json
{ "printWidth": 100, "endOfLine": "lf" }
```

`.prettierignore`:

```
node_modules
playwright-report
test-results
pnpm-lock.yaml
```

- [ ] 3. Create `eslint.config.mjs`:

```js
// ESLint flat config. The library is browser ES modules with no build step: a cross-file
// reference is an import, so no-undef runs with browser globals only and nothing is declared
// global. Tests, the stub hub, the demo harness and the tooling scripts are Node.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "playwright-report/**", "test-results/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "warn",
      "no-redeclare": "error",
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["demo/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: { "no-undef": "error", "no-unused-vars": "warn" },
  },
  {
    files: ["tests/**/*.js", "tests/**/*.mjs", "e2e/**/*.js", "tools/**/*.mjs", "*.js", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { "no-undef": "error", "no-unused-vars": "warn" },
  },
];
```

- [ ] 4. Create `vitest.config.js`:

```js
import { defineConfig } from "vitest/config";

// Node is the default environment on purpose: the buffers, the bundle builder, the status map,
// the transport and the annotator's geometry are pure and must stay testable without a DOM. The
// files that need one opt in with a `@vitest-environment jsdom` docblock of their own.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    restoreMocks: true,
  },
});
```

- [ ] 5. Write the failing tests. `tests/version.test.js`:

```js
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLIENT_ID, CLIENT_VERSION } from "../src/version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("version", () => {
  it("is the version in package.json", () => {
    expect(CLIENT_VERSION).toBe(pkg.version);
  });

  it("is the client string the report carries", () => {
    expect(CLIENT_ID).toBe("feedback-client/0.1.0");
    expect(CLIENT_ID).toBe(`feedback-client/${pkg.version}`);
  });
});
```

`tests/warn.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import { resetWarnings, warnOnce } from "../src/warn.js";

describe("warnOnce", () => {
  it("warns once per label, whatever happens after", () => {
    resetWarnings();
    const warn = vi.fn();
    warnOnce("console buffer", new Error("boom"), warn);
    warnOnce("console buffer", new Error("boom again"), warn);
    warnOnce("network buffer", new Error("other"), warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toBe("[feedback-client] console buffer disabled: boom");
    expect(warn.mock.calls[1][0]).toBe("[feedback-client] network buffer disabled: other");
  });

  it("describes a thrown non-Error too", () => {
    resetWarnings();
    const warn = vi.fn();
    warnOnce("replay", "no recorder", warn);
    expect(warn.mock.calls[0][0]).toBe("[feedback-client] replay disabled: no recorder");
  });

  it("swallows a console that throws", () => {
    resetWarnings();
    expect(() =>
      warnOnce("x", new Error("e"), () => {
        throw new Error("no console here");
      }),
    ).not.toThrow();
  });
});
```

- [ ] 6. Run `pnpm install` then `pnpm test` and watch both files fail with "Failed to resolve import".

- [ ] 7. Create `src/version.js`:

```js
// Bumped together with the CHANGELOG entry and the git tag consumers install by (spec §5.1).
export const CLIENT_VERSION = "0.1.0";
export const CLIENT_ID = `feedback-client/${CLIENT_VERSION}`;
```

- [ ] 8. Create `src/warn.js`:

```js
// One warning per subsystem, ever (spec §5.8): a patch that throws falls back to the original
// function and the library says so once, never once per call. `warn` is injectable because the
// console buffer must warn through the *original* console.warn, not through its own patch.
const warned = new Set();

export function warnOnce(label, err, warn = console.warn) {
  if (warned.has(label)) return;
  warned.add(label);
  const reason = err && err.message ? err.message : String(err);
  try {
    warn(`[feedback-client] ${label} disabled: ${reason}`);
  } catch {
    // A console that throws is not a reason to break the host app.
  }
}

// Tests only: the set is process-wide, so a test that asserts a warning has to clear it first.
export function resetWarnings() {
  warned.clear();
}
```

- [ ] 9. Run `pnpm test` and watch both files pass. Run `pnpm lint` (0 errors) and `pnpm format` then `pnpm format:check`.

- [ ] 10. Create `.github/workflows/ci.yml`:

```yaml
name: CI

# Lint, format and the unit tests on every pull request and push; Task 14 adds the `e2e` job that
# drives the demo page against the stub hub. A tag push runs the same checks, so a release tag is
# never green by accident.
on:
  pull_request:
  push:
    branches: [main]
    tags: ["v*"]

concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  checks:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check
      - run: pnpm test
```

- [ ] 11. Commit:

```
git add -A && git commit -m "chore(setup): the package, its tooling and CI

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The ring and the console buffer

**Files:**
- Create: `src/buffers/ring.js`, `src/buffers/console.js`
- Test: `tests/ring.test.js`, `tests/console-buffer.test.js`

**Interfaces:**
- Consumes: `warnOnce(label, err, warn?)` from `src/warn.js`.
- Produces:
  - `src/buffers/ring.js`: `class Ring { constructor(size: number); push(item: any): any; toArray(): any[]; clear(): void; get length(): number }`, `cut(text: string, max: number): string`.
  - `src/buffers/console.js`: `CONSOLE_KEEP = 200`, `CONSOLE_TEXT_MAX = 1024`, `CONSOLE_LEVELS: string[]`, `describeError(err: Error): string`, `describeValue(value: unknown): string`, `describeArgs(args: unknown[]): string`, `installConsoleBuffer({ console?, now? }): { entries(): Array<{t,level,text}>, uninstall(): void }`.

**Steps:**

- [ ] 1. Write `tests/ring.test.js`:

```js
import { describe, expect, it } from "vitest";
import { Ring, cut } from "../src/buffers/ring.js";

describe("Ring", () => {
  it("keeps the newest N and drops the oldest", () => {
    const ring = new Ring(3);
    for (const n of [1, 2, 3, 4, 5]) ring.push(n);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.length).toBe(3);
  });

  it("returns a copy, so a caller cannot mutate the buffer", () => {
    const ring = new Ring(2);
    ring.push("a");
    const copy = ring.toArray();
    copy.push("b");
    expect(ring.toArray()).toEqual(["a"]);
  });

  it("clears", () => {
    const ring = new Ring(2);
    ring.push("a");
    ring.clear();
    expect(ring.toArray()).toEqual([]);
  });
});

describe("cut", () => {
  it("leaves a short string alone", () => expect(cut("abc", 5)).toBe("abc"));
  it("cuts at the limit", () => expect(cut("abcdef", 3)).toBe("abc"));
  it("tolerates a non-string", () => expect(cut(undefined, 3)).toBe(""));
});
```

- [ ] 2. Run `pnpm test` and watch it fail.

- [ ] 3. Create `src/buffers/ring.js`:

```js
// A fixed-size buffer of the newest N entries. Pure: no DOM, no globals — every buffer in
// src/buffers/ is one of these plus a patch that feeds it.
export class Ring {
  constructor(size) {
    this.size = size;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
    return item;
  }

  toArray() {
    return this.items.slice();
  }

  clear() {
    this.items.length = 0;
  }

  get length() {
    return this.items.length;
  }
}

export function cut(text, max) {
  const value = typeof text === "string" ? text : text === undefined || text === null ? "" : String(text);
  return value.length <= max ? value : value.slice(0, max);
}
```

- [ ] 4. Run `pnpm test` and watch `tests/ring.test.js` pass.

- [ ] 5. Write `tests/console-buffer.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import {
  CONSOLE_KEEP,
  CONSOLE_TEXT_MAX,
  describeArgs,
  describeError,
  describeValue,
  installConsoleBuffer,
} from "../src/buffers/console.js";
import { resetWarnings } from "../src/warn.js";

function fakeConsole() {
  const seen = [];
  const make = (level) => (...args) => seen.push([level, ...args]);
  return {
    seen,
    log: make("log"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    debug: make("debug"),
  };
}

const at = () => "2026-09-21T10:00:00.000Z";

describe("describeError", () => {
  it("is the name, the message and the first five stack frames", () => {
    const err = new Error("nope");
    err.name = "TypeError";
    err.stack = ["TypeError: nope", ...Array.from({ length: 8 }, (_, i) => `    at f${i} (a.js:${i})`)].join("\n");
    const text = describeError(err);
    expect(text.split("\n")[0]).toBe("TypeError: nope");
    expect(text.split("\n")).toHaveLength(6);
    expect(text).toContain("    at f4 (a.js:4)");
    expect(text).not.toContain("    at f5 (a.js:5)");
  });

  it("is just the head when there is no stack", () => {
    const err = new Error("plain");
    err.stack = undefined;
    expect(describeError(err)).toBe("Error: plain");
  });
});

describe("describeValue", () => {
  it("passes a string through", () => expect(describeValue("hi")).toBe("hi"));
  it("stringifies a number and null", () => {
    expect(describeValue(3)).toBe("3");
    expect(describeValue(null)).toBe("null");
  });
  it("serializes a plain object", () => expect(describeValue({ a: 1 })).toBe('{"a":1}'));
  it("falls back on a circular object", () => {
    const obj = {};
    obj.self = obj;
    expect(describeValue(obj)).toBe("[object Object]");
  });
});

describe("installConsoleBuffer", () => {
  it("records level, text and time, and still calls the original", () => {
    const target = fakeConsole();
    const buffer = installConsoleBuffer({ console: target, now: at });
    target.error("boom", 3);
    expect(buffer.entries()).toEqual([
      { t: "2026-09-21T10:00:00.000Z", level: "error", text: "boom 3" },
    ]);
    expect(target.seen).toEqual([["error", "boom", 3]]);
    buffer.uninstall();
  });

  it("keeps the last 200 entries", () => {
    const target = fakeConsole();
    const buffer = installConsoleBuffer({ console: target, now: at });
    for (let i = 0; i < CONSOLE_KEEP + 10; i += 1) target.log(`line ${i}`);
    const entries = buffer.entries();
    expect(entries).toHaveLength(CONSOLE_KEEP);
    expect(entries[0].text).toBe("line 10");
    expect(entries[CONSOLE_KEEP - 1].text).toBe(`line ${CONSOLE_KEEP + 9}`);
    buffer.uninstall();
  });

  it("cuts each entry at 1 KB", () => {
    const target = fakeConsole();
    const buffer = installConsoleBuffer({ console: target, now: at });
    target.log("x".repeat(5000));
    expect(buffer.entries()[0].text).toHaveLength(CONSOLE_TEXT_MAX);
    buffer.uninstall();
  });

  it("restores the originals on uninstall", () => {
    const target = fakeConsole();
    const before = target.log;
    const buffer = installConsoleBuffer({ console: target, now: at });
    expect(target.log).not.toBe(before);
    buffer.uninstall();
    expect(target.log).toBe(before);
  });

  it("falls back to the original and warns once when recording throws", () => {
    resetWarnings();
    const target = fakeConsole();
    const warn = vi.fn();
    target.warn = warn;
    const buffer = installConsoleBuffer({
      console: target,
      now: () => {
        throw new Error("clock broke");
      },
    });
    expect(() => target.log("still printed")).not.toThrow();
    expect(() => target.log("still printed")).not.toThrow();
    expect(target.seen).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    buffer.uninstall();
  });
});

describe("describeArgs", () => {
  it("joins with a space", () => expect(describeArgs(["a", 1, true])).toBe("a 1 true"));
});
```

- [ ] 4b. Run `pnpm test` and watch the console file fail.

- [ ] 6. Create `src/buffers/console.js`:

```js
// The console buffer (spec §5.2): the last 200 entries, each cut at 1 KB, with the original
// console behaviour preserved. Errors keep their name, message and the first five stack frames —
// the triage run reads this instead of asking the reporter what the console said.
import { Ring, cut } from "./ring.js";
import { warnOnce } from "../warn.js";

export const CONSOLE_KEEP = 200;
export const CONSOLE_TEXT_MAX = 1024;
export const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"];
const STACK_FRAMES = 5;

export function describeError(err) {
  const head = `${err.name || "Error"}: ${err.message || ""}`;
  const stack = typeof err.stack === "string" ? err.stack.split("\n") : [];
  const frames = stack.filter((line) => /^\s+at\s/.test(line)).slice(0, STACK_FRAMES);
  return frames.length ? `${head}\n${frames.join("\n")}` : head;
}

export function describeValue(value) {
  if (value instanceof Error) return describeError(value);
  if (typeof value === "string") return value;
  if (value === null || value === undefined || typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function describeArgs(args) {
  return cut(args.map(describeValue).join(" "), CONSOLE_TEXT_MAX);
}

export function installConsoleBuffer({
  console: target = console,
  now = () => new Date().toISOString(),
} = {}) {
  const ring = new Ring(CONSOLE_KEEP);
  const originals = new Map();

  for (const level of CONSOLE_LEVELS) {
    const original = target[level];
    if (typeof original !== "function") continue;
    originals.set(level, original);
    target[level] = function patched(...args) {
      try {
        ring.push({ t: now(), level, text: describeArgs(args) });
      } catch (err) {
        // The warning goes through the original console.warn, never through this patch.
        warnOnce("console buffer", err, originals.get("warn") || original);
      }
      return original.apply(this, args);
    };
  }

  return {
    entries: () => ring.toArray(),
    uninstall() {
      for (const [level, original] of originals) target[level] = original;
      originals.clear();
    },
  };
}
```

- [ ] 7. Run `pnpm test` and watch every test pass. Run `pnpm lint` and `pnpm format`.

- [ ] 8. Commit:

```
git add -A && git commit -m "feat(buffers): the ring buffer and the console buffer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The error and network buffers

**Files:**
- Create: `src/buffers/errors.js`, `src/buffers/network.js`, `tests/helpers/fake-window.js`
- Test: `tests/error-buffer.test.js`, `tests/network-buffer.test.js`

**Interfaces:**
- Consumes: `Ring` from `src/buffers/ring.js`, `warnOnce` from `src/warn.js`.
- Produces:
  - `src/buffers/errors.js`: `ERRORS_KEEP = 20`, `describeErrorEvent(event): { message: string, stack: string }`, `installErrorBuffer({ target?, now? }): { entries(): Array<{t,message,stack}>, uninstall(): void }`.
  - `src/buffers/network.js`: `NETWORK_KEEP = 50`, `SLOW_MS = 3000`, `scrubUrl(raw: unknown, base?: string): string`, `shouldRecord({ status?, ms?, failed? }): boolean`, `installNetworkBuffer({ target?, now?, clock? }): { entries(): Array<{t,method,url,status,ms}>, uninstall(): void }`.
  - `tests/helpers/fake-window.js`: `createFakeWindow({ href? }): FakeWindow` with `addEventListener`, `removeEventListener`, `dispatch(type, event)`, `location`, `history`.

**Steps:**

- [ ] 1. Create `tests/helpers/fake-window.js` (no test of its own; it is exercised by the two test files below):

```js
// A minimal event target with the few window fields the buffers read. The buffer tests run in
// plain Node on purpose: nothing in src/buffers/ may need a real DOM.
export function createFakeWindow({ href = "https://app.example/rings" } = {}) {
  const listeners = new Map();
  const win = {
    listeners,
    location: new URL(href),
    history: { pushState() {}, replaceState() {} },
    addEventListener(type, fn, options) {
      const key = `${type}:${options === true || (options && options.capture) ? "capture" : "bubble"}`;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
    },
    removeEventListener(type, fn, options) {
      const key = `${type}:${options === true || (options && options.capture) ? "capture" : "bubble"}`;
      const set = listeners.get(key);
      if (set) set.delete(fn);
    },
    dispatch(type, event = {}) {
      for (const phase of ["capture", "bubble"]) {
        const set = listeners.get(`${type}:${phase}`);
        if (set) for (const fn of [...set]) fn({ type, ...event });
      }
    },
    countListeners() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
  return win;
}
```

- [ ] 2. Write `tests/error-buffer.test.js`:

```js
import { describe, expect, it } from "vitest";
import { ERRORS_KEEP, describeErrorEvent, installErrorBuffer } from "../src/buffers/errors.js";
import { createFakeWindow } from "./helpers/fake-window.js";

const at = () => "2026-09-21T10:00:00.000Z";

describe("describeErrorEvent", () => {
  it("reads an Error out of an error event", () => {
    const err = new Error("kaboom");
    err.stack = "Error: kaboom\n    at f (a.js:1)";
    expect(describeErrorEvent({ error: err, message: "ignored" })).toEqual({
      message: "kaboom",
      stack: "Error: kaboom\n    at f (a.js:1)",
    });
  });

  it("reads a rejection reason that is not an Error", () => {
    expect(describeErrorEvent({ reason: "just a string" })).toEqual({
      message: "just a string",
      stack: "",
    });
  });

  it("falls back to the event's message", () => {
    expect(describeErrorEvent({ message: "Script error." })).toEqual({
      message: "Script error.",
      stack: "",
    });
  });
});

describe("installErrorBuffer", () => {
  it("records window errors and unhandled rejections", () => {
    const win = createFakeWindow();
    const buffer = installErrorBuffer({ target: win, now: at });
    win.dispatch("error", { error: Object.assign(new Error("one"), { stack: "s1" }) });
    win.dispatch("unhandledrejection", { reason: new Error("two") });
    expect(buffer.entries()).toEqual([
      { t: at(), message: "one", stack: "s1" },
      { t: at(), message: "two", stack: buffer.entries()[1].stack },
    ]);
    buffer.uninstall();
  });

  it("keeps the last 20", () => {
    const win = createFakeWindow();
    const buffer = installErrorBuffer({ target: win, now: at });
    for (let i = 0; i < ERRORS_KEEP + 5; i += 1) win.dispatch("error", { message: `e${i}` });
    expect(buffer.entries()).toHaveLength(ERRORS_KEEP);
    expect(buffer.entries()[0].message).toBe("e5");
    buffer.uninstall();
  });

  it("removes its listeners on uninstall", () => {
    const win = createFakeWindow();
    const buffer = installErrorBuffer({ target: win, now: at });
    expect(win.countListeners()).toBe(2);
    buffer.uninstall();
    expect(win.countListeners()).toBe(0);
  });
});
```

- [ ] 3. Run `pnpm test` and watch it fail.

- [ ] 4. Create `src/buffers/errors.js`:

```js
// The error buffer (spec §5.2): the last 20 uncaught errors and unhandled rejections, message and
// stack. The `error` listener is deliberately not a capturing one — a capturing listener also
// catches every failed image or stylesheet load, which is noise the triage run does not need.
import { Ring } from "./ring.js";
import { warnOnce } from "../warn.js";

export const ERRORS_KEEP = 20;

export function describeErrorEvent(event) {
  const err = event && (event.error || event.reason);
  if (err instanceof Error) {
    return { message: err.message || String(err), stack: typeof err.stack === "string" ? err.stack : "" };
  }
  if (err !== undefined && err !== null) return { message: String(err), stack: "" };
  return { message: (event && event.message) || "Unknown error", stack: "" };
}

export function installErrorBuffer({ target = window, now = () => new Date().toISOString() } = {}) {
  const ring = new Ring(ERRORS_KEEP);
  const onEvent = (event) => {
    try {
      const { message, stack } = describeErrorEvent(event);
      ring.push({ t: now(), message, stack });
    } catch (err) {
      warnOnce("error buffer", err);
    }
  };

  target.addEventListener("error", onEvent);
  target.addEventListener("unhandledrejection", onEvent);

  return {
    entries: () => ring.toArray(),
    uninstall() {
      target.removeEventListener("error", onEvent);
      target.removeEventListener("unhandledrejection", onEvent);
    },
  };
}
```

- [ ] 5. Run `pnpm test` and watch the error tests pass.

- [ ] 6. Write `tests/network-buffer.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  NETWORK_KEEP,
  SLOW_MS,
  installNetworkBuffer,
  scrubUrl,
  shouldRecord,
} from "../src/buffers/network.js";
import { createFakeWindow } from "./helpers/fake-window.js";

const at = () => "2026-09-21T10:00:00.000Z";

describe("scrubUrl", () => {
  it("keeps origin and path and drops the query string", () => {
    expect(scrubUrl("https://db.supabase.co/rest/v1/rings?select=*&id=eq.7")).toBe(
      "https://db.supabase.co/rest/v1/rings",
    );
  });
  it("drops the hash", () => {
    expect(scrubUrl("https://app.example/page#batch-3")).toBe("https://app.example/page");
  });
  it("resolves a relative URL against the page", () => {
    expect(scrubUrl("/api/x?token=abc", "https://app.example/rings")).toBe("https://app.example/api/x");
  });
  it("cuts at the first ? when it cannot parse", () => {
    expect(scrubUrl("not a url?secret=1")).toBe("not a url");
  });
});

describe("shouldRecord", () => {
  it("keeps a failure", () => expect(shouldRecord({ failed: true, status: 0, ms: 5 })).toBe(true));
  it("keeps a 400 and above", () => {
    expect(shouldRecord({ status: 400, ms: 5 })).toBe(true);
    expect(shouldRecord({ status: 399, ms: 5 })).toBe(false);
  });
  it("keeps anything slower than three seconds", () => {
    expect(shouldRecord({ status: 200, ms: SLOW_MS + 1 })).toBe(true);
    expect(shouldRecord({ status: 200, ms: SLOW_MS })).toBe(false);
  });
});

function fakeXhr() {
  return class FakeXhr {
    constructor() {
      this.status = 0;
      this.handlers = [];
    }
    addEventListener(type, fn) {
      if (type === "loadend") this.handlers.push(fn);
    }
    open() {}
    send() {}
    finish(status) {
      this.status = status;
      for (const fn of this.handlers) fn();
    }
  };
}

describe("installNetworkBuffer", () => {
  it("records a failed fetch and passes the response through", async () => {
    const win = createFakeWindow();
    let clock = 1000;
    win.fetch = async () => {
      clock += 120;
      return { status: 409 };
    };
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => clock });
    const res = await win.fetch("https://db.example/rest/v1/rings?id=eq.7", { method: "PATCH" });
    expect(res.status).toBe(409);
    expect(buffer.entries()).toEqual([
      { t: at(), method: "PATCH", url: "https://db.example/rest/v1/rings", status: 409, ms: 120 },
    ]);
    buffer.uninstall();
  });

  it("records a thrown fetch as status 0 and rethrows", async () => {
    const win = createFakeWindow();
    win.fetch = async () => {
      throw new Error("offline");
    };
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    await expect(win.fetch("/api/x")).rejects.toThrow("offline");
    expect(buffer.entries()[0]).toMatchObject({ status: 0, url: "https://app.example/api/x" });
    buffer.uninstall();
  });

  it("ignores a fast successful fetch", async () => {
    const win = createFakeWindow();
    win.fetch = async () => ({ status: 200 });
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    await win.fetch("/api/ok");
    expect(buffer.entries()).toEqual([]);
    buffer.uninstall();
  });

  it("keeps the last 50", async () => {
    const win = createFakeWindow();
    win.fetch = async () => ({ status: 500 });
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    for (let i = 0; i < NETWORK_KEEP + 3; i += 1) await win.fetch(`/api/${i}`);
    expect(buffer.entries()).toHaveLength(NETWORK_KEEP);
    expect(buffer.entries()[0].url).toBe("https://app.example/api/3");
    buffer.uninstall();
  });

  it("records an XMLHttpRequest that fails", () => {
    const win = createFakeWindow();
    win.XMLHttpRequest = fakeXhr();
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", "/api/save?token=secret");
    xhr.send();
    xhr.finish(503);
    expect(buffer.entries()).toEqual([
      { t: at(), method: "POST", url: "https://app.example/api/save", status: 503, ms: 0 },
    ]);
    buffer.uninstall();
  });

  it("restores fetch and the XHR prototype on uninstall", () => {
    const win = createFakeWindow();
    win.fetch = async () => ({ status: 200 });
    win.XMLHttpRequest = fakeXhr();
    const fetchBefore = win.fetch;
    const openBefore = win.XMLHttpRequest.prototype.open;
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    expect(win.fetch).not.toBe(fetchBefore);
    buffer.uninstall();
    expect(win.fetch).toBe(fetchBefore);
    expect(win.XMLHttpRequest.prototype.open).toBe(openBefore);
  });
});
```

- [ ] 7. Run `pnpm test` and watch the network file fail.

- [ ] 8. Create `src/buffers/network.js`:

```js
// The network buffer (spec §5.2): the last 50 requests that failed, answered 400 or worse, or took
// longer than three seconds. Never a header, never a body, and never a query string (spec §5.7) —
// `scrubUrl` keeps the origin and the path and throws the rest away before anything is stored.
import { Ring } from "./ring.js";
import { warnOnce } from "../warn.js";

export const NETWORK_KEEP = 50;
export const SLOW_MS = 3000;
const META = "__fbhRequest";

export function scrubUrl(raw, base) {
  const text = raw === undefined || raw === null ? "" : String(raw);
  try {
    const url = new URL(text, base);
    return `${url.origin}${url.pathname}`;
  } catch {
    const cutAt = text.search(/[?#]/);
    return cutAt === -1 ? text : text.slice(0, cutAt);
  }
}

export function shouldRecord({ status = 0, ms = 0, failed = false }) {
  return failed || status >= 400 || ms > SLOW_MS;
}

export function installNetworkBuffer({
  target = window,
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
} = {}) {
  const ring = new Ring(NETWORK_KEEP);
  const base = target.location ? String(target.location) : undefined;

  const record = (entry) => {
    try {
      if (!shouldRecord(entry)) return;
      ring.push({ t: entry.t, method: entry.method, url: entry.url, status: entry.status, ms: entry.ms });
    } catch (err) {
      warnOnce("network buffer", err);
    }
  };

  const originalFetch = target.fetch;
  if (typeof originalFetch === "function") {
    target.fetch = function patchedFetch(input, init) {
      const started = clock();
      const t = now();
      const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      const url = scrubUrl(input && input.url ? input.url : input, base);
      return originalFetch.call(this, input, init).then(
        (res) => {
          record({ t, method, url, status: res ? res.status : 0, ms: clock() - started, failed: false });
          return res;
        },
        (err) => {
          record({ t, method, url, status: 0, ms: clock() - started, failed: true });
          throw err;
        },
      );
    };
  }

  const Xhr = target.XMLHttpRequest;
  const originalOpen = Xhr && Xhr.prototype && Xhr.prototype.open;
  const originalSend = Xhr && Xhr.prototype && Xhr.prototype.send;
  if (originalOpen && originalSend) {
    Xhr.prototype.open = function patchedOpen(method, url, ...rest) {
      this[META] = { method: String(method || "GET").toUpperCase(), url: scrubUrl(url, base) };
      return originalOpen.call(this, method, url, ...rest);
    };
    Xhr.prototype.send = function patchedSend(...args) {
      const meta = this[META];
      if (meta) {
        const started = clock();
        const t = now();
        this.addEventListener("loadend", () => {
          const status = Number(this.status) || 0;
          record({ t, method: meta.method, url: meta.url, status, ms: clock() - started, failed: status === 0 });
        });
      }
      return originalSend.apply(this, args);
    };
  }

  return {
    entries: () => ring.toArray(),
    uninstall() {
      if (typeof originalFetch === "function") target.fetch = originalFetch;
      if (originalOpen && originalSend) {
        Xhr.prototype.open = originalOpen;
        Xhr.prototype.send = originalSend;
      }
    },
  };
}
```

- [ ] 9. Run `pnpm test` (all green), `pnpm lint`, `pnpm format`.

- [ ] 10. Commit:

```
git add -A && git commit -m "feat(buffers): the error and network buffers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The breadcrumb buffer, and the four buffers behind one handle

**Files:**
- Create: `src/buffers/breadcrumbs.js`, `src/buffers/install.js`
- Test: `tests/breadcrumb-buffer.test.js`, `tests/install-buffers.test.js`

**Interfaces:**
- Consumes: `Ring`, `cut` from `src/buffers/ring.js`; `warnOnce`; `installConsoleBuffer`, `installErrorBuffer`, `installNetworkBuffer`.
- Produces:
  - `src/buffers/breadcrumbs.js`: `BREADCRUMBS_KEEP = 100`, `CLICK_TEXT_MAX = 60`, `VALUE_MAX = 40`, `MASKED = "•••"`, `CLICK_TARGETS`, `describeClickTarget(el): string`, `fieldLabel(el): string`, `fieldValue(el, { maskAllInputs }): string`, `describeFieldChange(el, { maskAllInputs }): string`, `installBreadcrumbBuffer({ target?, doc?, now?, maskAllInputs? }): { entries(): Array<{t,kind,target}>, uninstall(): void }`.
  - `src/buffers/install.js`: `installBuffers({ win, doc, capture }): { console(): [], errors(): [], network(): [], breadcrumbs(): [], uninstall(): void }`.

**Steps:**

- [ ] 1. Write `tests/breadcrumb-buffer.test.js`:

```js
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import {
  BREADCRUMBS_KEEP,
  MASKED,
  describeClickTarget,
  describeFieldChange,
  fieldLabel,
  installBreadcrumbBuffer,
} from "../src/buffers/breadcrumbs.js";

const at = () => "2026-09-21T10:00:00.000Z";

beforeEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

describe("describeClickTarget", () => {
  it("is the tag, the id, up to three data attributes, the aria-label and the text", () => {
    document.body.innerHTML = `
      <button id="save-ring" data-view="rings" data-kind="primary" data-x="1" data-y="2"
              aria-label="Save">Save ring</button>`;
    const el = document.getElementById("save-ring");
    expect(describeClickTarget(el)).toBe(
      'button#save-ring[data-view="rings"][data-kind="primary"][data-x="1"] aria-label="Save" \'Save ring\'',
    );
  });

  it("cuts the text at 60 characters and collapses whitespace", () => {
    document.body.innerHTML = `<a href="#x">${"word ".repeat(30)}</a>`;
    const described = describeClickTarget(document.querySelector("a"));
    expect(described).toBe(`a '${"word ".repeat(30).replace(/\s+/g, " ").trim().slice(0, 60)}'`);
  });

  it("is empty for nothing", () => expect(describeClickTarget(null)).toBe(""));
});

describe("fieldLabel", () => {
  it("prefers the label element", () => {
    document.body.innerHTML = `<label for="a">Ring name</label><input id="a">`;
    expect(fieldLabel(document.getElementById("a"))).toBe("Ring name");
  });
  it("then the aria-label, then the placeholder, then the name", () => {
    document.body.innerHTML = `
      <input id="b" aria-label="Carat">
      <input id="c" placeholder="Search">
      <input id="d" name="metal">
      <input id="e">`;
    expect(fieldLabel(document.getElementById("b"))).toBe("Carat");
    expect(fieldLabel(document.getElementById("c"))).toBe("Search");
    expect(fieldLabel(document.getElementById("d"))).toBe("metal");
    expect(fieldLabel(document.getElementById("e"))).toBe("input");
  });
});

describe("describeFieldChange", () => {
  it("cuts the value at 40 characters", () => {
    document.body.innerHTML = `<input id="a" aria-label="Note">`;
    const el = document.getElementById("a");
    el.value = "y".repeat(60);
    expect(describeFieldChange(el, { maskAllInputs: false })).toBe(`Note = '${"y".repeat(40)}'`);
  });

  it("always masks a password", () => {
    document.body.innerHTML = `<input id="p" type="password" aria-label="Password">`;
    const el = document.getElementById("p");
    el.value = "hunter2";
    expect(describeFieldChange(el, { maskAllInputs: false })).toBe(`Password = ${MASKED}`);
  });

  it("masks everything under maskAllInputs", () => {
    document.body.innerHTML = `<input id="a" aria-label="Note">`;
    const el = document.getElementById("a");
    el.value = "visible";
    expect(describeFieldChange(el, { maskAllInputs: true })).toBe(`Note = ${MASKED}`);
  });

  it("describes a checkbox by its state, masked or not", () => {
    document.body.innerHTML = `<input id="c" type="checkbox" aria-label="Pair">`;
    const el = document.getElementById("c");
    el.checked = true;
    expect(describeFieldChange(el, { maskAllInputs: true })).toBe("Pair = checked");
  });
});

describe("installBreadcrumbBuffer", () => {
  it("records the nearest button for a click on its child", () => {
    document.body.innerHTML = `<button id="b"><span id="s">Go</span></button>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    document.getElementById("s").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(buffer.entries()).toEqual([{ t: at(), kind: "click", target: "button#b 'Go'" }]);
    buffer.uninstall();
  });

  it("records a change, a submit, a route change, visibility and connection", () => {
    document.body.innerHTML = `<form id="f"><input id="a" aria-label="Note"></form>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    const input = document.getElementById("a");
    input.value = "hi";
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    document.getElementById("f").dispatchEvent(new window.Event("submit", { bubbles: true }));
    window.history.pushState({}, "", "/rings#batch-3");
    document.dispatchEvent(new window.Event("visibilitychange"));
    window.dispatchEvent(new window.Event("offline"));
    expect(buffer.entries().map((e) => [e.kind, e.target])).toEqual([
      ["change", "Note = 'hi'"],
      ["submit", "form#f"],
      ["route", "/rings#batch-3"],
      ["visibility", document.visibilityState],
      ["connection", "offline"],
    ]);
    buffer.uninstall();
  });

  it("never records a query string in a route breadcrumb", () => {
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    window.history.pushState({}, "", "/rings?token=secret#x");
    expect(buffer.entries()[0].target).toBe("/rings#x");
    buffer.uninstall();
  });

  it("keeps the last 100", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    const button = document.getElementById("b");
    for (let i = 0; i < BREADCRUMBS_KEEP + 7; i += 1) {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    }
    expect(buffer.entries()).toHaveLength(BREADCRUMBS_KEEP);
    buffer.uninstall();
  });

  it("restores history.pushState and stops recording on uninstall", () => {
    const before = window.history.pushState;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    expect(window.history.pushState).not.toBe(before);
    buffer.uninstall();
    expect(window.history.pushState).toBe(before);
    window.history.pushState({}, "", "/after");
    expect(buffer.entries()).toEqual([]);
  });
});
```

- [ ] 2. Run `pnpm test` and watch it fail.

- [ ] 3. Create `src/buffers/breadcrumbs.js`:

```js
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

export function fieldValue(el, { maskAllInputs = false } = {}) {
  const type = String(el.type || "text").toLowerCase();
  if (type === "checkbox" || type === "radio") return el.checked ? "checked" : "unchecked";
  if (type === "password" || maskAllInputs) return MASKED;
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

  const history = target.history;
  const originalPush = history && history.pushState;
  const originalReplace = history && history.replaceState;
  if (originalPush) {
    history.pushState = function patchedPush(...args) {
      const result = originalPush.apply(this, args);
      onRoute();
      return result;
    };
  }
  if (originalReplace) {
    history.replaceState = function patchedReplace(...args) {
      const result = originalReplace.apply(this, args);
      onRoute();
      return result;
    };
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
      if (originalPush) history.pushState = originalPush;
      if (originalReplace) history.replaceState = originalReplace;
    },
  };
}
```

- [ ] 4. Run `pnpm test` and watch the breadcrumb tests pass.

- [ ] 5. Write `tests/install-buffers.test.js`:

```js
/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { installBuffers } from "../src/buffers/install.js";

describe("installBuffers", () => {
  it("installs all four by default and takes them all down again", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const buffers = installBuffers({ win: window, doc: document, capture: {} });
    console.log("hello");
    document.getElementById("b").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    window.dispatchEvent(new window.Event("offline"));
    expect(buffers.console().some((e) => e.text === "hello")).toBe(true);
    expect(buffers.breadcrumbs()).toHaveLength(2);
    expect(buffers.errors()).toEqual([]);
    expect(buffers.network()).toEqual([]);
    buffers.uninstall();
    console.log("after");
    expect(buffers.console().some((e) => e.text === "after")).toBe(false);
  });

  it("leaves the console and network buffers out when the app switched them off", () => {
    const buffers = installBuffers({
      win: window,
      doc: document,
      capture: { console: false, network: false },
    });
    console.log("not recorded");
    expect(buffers.console()).toEqual([]);
    expect(buffers.network()).toEqual([]);
    buffers.uninstall();
  });

  it("passes maskAllInputs to the breadcrumbs", () => {
    document.body.innerHTML = `<input id="a" aria-label="Note">`;
    const buffers = installBuffers({ win: window, doc: document, capture: { maskAllInputs: true } });
    const input = document.getElementById("a");
    input.value = "secret";
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(buffers.breadcrumbs()[0].target).toBe("Note = •••");
    buffers.uninstall();
  });
});
```

- [ ] 6. Run `pnpm test` and watch it fail.

- [ ] 7. Create `src/buffers/install.js`:

```js
// The four buffers behind one handle, so mount.js has one thing to install and one thing to take
// down. `capture.console` and `capture.network` are the only two an app can switch off (spec
// §5.5); errors and breadcrumbs are always on — they are what makes a report readable at all.
import { installBreadcrumbBuffer } from "./breadcrumbs.js";
import { installConsoleBuffer } from "./console.js";
import { installErrorBuffer } from "./errors.js";
import { installNetworkBuffer } from "./network.js";

const none = { entries: () => [], uninstall() {} };

export function installBuffers({ win = window, doc = win.document, capture = {} } = {}) {
  const consoleBuffer =
    capture.console === false ? none : installConsoleBuffer({ console: win.console || console });
  const errorBuffer = installErrorBuffer({ target: win });
  const networkBuffer = capture.network === false ? none : installNetworkBuffer({ target: win });
  const breadcrumbBuffer = installBreadcrumbBuffer({
    target: win,
    doc,
    maskAllInputs: !!capture.maskAllInputs,
  });

  return {
    console: () => consoleBuffer.entries(),
    errors: () => errorBuffer.entries(),
    network: () => networkBuffer.entries(),
    breadcrumbs: () => breadcrumbBuffer.entries(),
    uninstall() {
      consoleBuffer.uninstall();
      errorBuffer.uninstall();
      networkBuffer.uninstall();
      breadcrumbBuffer.uninstall();
    },
  };
}
```

- [ ] 8. Run `pnpm test` (all green), `pnpm lint`, `pnpm format`.

- [ ] 9. Commit:

```
git add -A && git commit -m "feat(buffers): the breadcrumb buffer and one install handle

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The DOM snapshot and gzip

**Files:**
- Create: `src/bytes.js`, `src/capture/gzip.js`, `src/capture/dom.js`
- Test: `tests/gzip.test.js`, `tests/dom-snapshot.test.js`

**Interfaces:**
- Consumes: `warnOnce` from `src/warn.js`.
- Produces:
  - `src/bytes.js`: `byteLength(text: string): number`.
  - `src/capture/gzip.js`: `gzipSupported(): boolean`, `gzip(text: string): Promise<Blob | null>` (Blob type `application/gzip`).
  - `src/capture/dom.js`: `BLANKED_ATTR = "data-fbh-blanked"`, `stampValues(live: Element, clone: Element, { maskAllInputs }): void`, `blankElements(clone: Element, selectors: string[]): void`, `snapshotDom(doc: Document, { maskAllInputs?, blank? }): string`.

**Steps:**

- [ ] 1. Write `tests/gzip.test.js`:

```js
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { gzip, gzipSupported } from "../src/capture/gzip.js";
import { byteLength } from "../src/bytes.js";

describe("byteLength", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("💍")).toBe(4);
  });
});

describe("gzip", () => {
  it("produces a gzip blob that round-trips", async () => {
    const text = "<!doctype html><html><body>hello</body></html>";
    const blob = await gzip(text);
    expect(blob.type).toBe("application/gzip");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1f, 0x8b]);
    expect(gunzipSync(bytes).toString("utf8")).toBe(text);
  });

  it("returns null when the browser has no CompressionStream", async () => {
    const original = globalThis.CompressionStream;
    delete globalThis.CompressionStream;
    try {
      expect(gzipSupported()).toBe(false);
      expect(await gzip("x")).toBe(null);
    } finally {
      globalThis.CompressionStream = original;
    }
  });
});
```

- [ ] 2. Run `pnpm test` and watch it fail.

- [ ] 3. Create `src/bytes.js`:

```js
// The caps in the spec are byte counts, and a report full of names and notes is not ASCII.
const encoder = new TextEncoder();

export function byteLength(text) {
  return encoder.encode(text).length;
}
```

- [ ] 4. Create `src/capture/gzip.js`:

```js
// The DOM snapshot and the replay go up gzipped (spec §5.3). CompressionStream is in every
// browser the dashboards support, but it is absent in older WebViews and behind some strict
// privacy settings: there it returns null and the part is simply left out, which the hub and the
// panel both cope with.
import { warnOnce } from "../warn.js";

export function gzipSupported() {
  return typeof CompressionStream === "function";
}

export async function gzip(text) {
  if (!gzipSupported()) return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Blob([buffer], { type: "application/gzip" });
  } catch (err) {
    warnOnce("gzip", err);
    return null;
  }
}
```

- [ ] 5. Run `pnpm test` and watch the gzip tests pass.

- [ ] 6. Write `tests/dom-snapshot.test.js`:

```js
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { BLANKED_ATTR, snapshotDom } from "../src/capture/dom.js";

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("snapshotDom", () => {
  it("stamps what the user typed as an attribute, so the clone shows it", () => {
    document.body.innerHTML = `<input id="a"><textarea id="b"></textarea>`;
    document.getElementById("a").value = "Solitaire";
    document.getElementById("b").value = "two lines\nhere";
    const html = snapshotDom(document, {});
    expect(html).toContain('value="Solitaire"');
    expect(html).toContain("two lines\nhere");
  });

  it("blanks a password whatever the settings", () => {
    document.body.innerHTML = `<input id="p" type="password">`;
    document.getElementById("p").value = "hunter2";
    expect(snapshotDom(document, {})).not.toContain("hunter2");
    expect(snapshotDom(document, {})).toContain('value=""');
  });

  it("blanks every typed value under maskAllInputs", () => {
    document.body.innerHTML = `<input id="a"><textarea id="b"></textarea>`;
    document.getElementById("a").value = "Dana";
    document.getElementById("b").value = "a note";
    const html = snapshotDom(document, { maskAllInputs: true });
    expect(html).not.toContain("Dana");
    expect(html).not.toContain("a note");
  });

  it("stamps a checkbox and the selected option", () => {
    document.body.innerHTML = `
      <input id="c" type="checkbox">
      <select id="s"><option value="1">One</option><option value="2">Two</option></select>`;
    document.getElementById("c").checked = true;
    document.getElementById("s").selectedIndex = 1;
    const html = snapshotDom(document, {});
    expect(html).toContain("checked");
    expect(html).toMatch(/<option value="2" selected(=""|)>Two<\/option>/);
  });

  it("removes every script element", () => {
    document.body.innerHTML = `<script>window.x = 1;</script><p>kept</p>`;
    const html = snapshotDom(document, {});
    expect(html).not.toContain("window.x = 1");
    expect(html).toContain("kept");
  });

  it("empties the blank selectors and marks them", () => {
    document.body.innerHTML = `<div class="sku-price">£4,200</div><div class="other">keep</div>`;
    const html = snapshotDom(document, { blank: [".sku-price"] });
    expect(html).not.toContain("4,200");
    expect(html).toContain(BLANKED_ATTR);
    expect(html).toContain("keep");
  });

  it("ignores a selector that is not valid CSS instead of throwing", () => {
    document.body.innerHTML = `<div class="x">keep</div>`;
    expect(() => snapshotDom(document, { blank: ["!!!"] })).not.toThrow();
  });

  it("starts with a doctype and does not touch the live page", () => {
    document.body.innerHTML = `<input id="a">`;
    document.getElementById("a").value = "live";
    const html = snapshotDom(document, { maskAllInputs: true });
    expect(html.startsWith("<!doctype html>\n<html")).toBe(true);
    expect(document.getElementById("a").value).toBe("live");
  });
});
```

- [ ] 7. Run `pnpm test` and watch it fail.

- [ ] 8. Create `src/capture/dom.js`:

```js
// The DOM snapshot (spec §5.3): a clone of the live document with what the user typed stamped
// into attributes — `cloneNode` copies the markup, not the values, so a form in the snapshot
// would otherwise look empty. Passwords are always blanked, every field is blanked under
// maskAllInputs, `<script>` elements are dropped (the snapshot is opened as a file, never run)
// and the app's `blank` selectors are emptied (spec §5.7). The live page is never modified.
export const BLANKED_ATTR = "data-fbh-blanked";
const FIELDS = "input, textarea, select";

export function stampValues(live, clone, { maskAllInputs = false } = {}) {
  const liveFields = live.querySelectorAll(FIELDS);
  const cloneFields = clone.querySelectorAll(FIELDS);
  const count = Math.min(liveFields.length, cloneFields.length);
  for (let i = 0; i < count; i += 1) {
    const from = liveFields[i];
    const to = cloneFields[i];
    const tag = from.tagName.toLowerCase();
    if (tag === "input") {
      const type = String(from.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (from.checked) to.setAttribute("checked", "");
        else to.removeAttribute("checked");
        continue;
      }
      const masked = type === "password" || maskAllInputs;
      to.setAttribute("value", masked ? "" : String(from.value ?? ""));
    } else if (tag === "textarea") {
      to.textContent = maskAllInputs ? "" : String(from.value ?? "");
    } else {
      const options = to.querySelectorAll("option");
      for (let j = 0; j < options.length; j += 1) {
        if (!maskAllInputs && j === from.selectedIndex) options[j].setAttribute("selected", "");
        else options[j].removeAttribute("selected");
      }
    }
  }
}

export function blankElements(clone, selectors) {
  for (const selector of selectors) {
    let matches;
    try {
      matches = clone.querySelectorAll(selector);
    } catch {
      continue; // a selector the app got wrong must not cost the whole snapshot
    }
    for (const el of matches) {
      el.textContent = "";
      el.setAttribute(BLANKED_ATTR, "");
    }
  }
}

export function snapshotDom(doc, { maskAllInputs = false, blank = [] } = {}) {
  const root = doc.documentElement;
  const clone = root.cloneNode(true);
  stampValues(root, clone, { maskAllInputs });
  for (const script of clone.querySelectorAll("script")) script.remove();
  blankElements(clone, blank);
  return `<!doctype html>\n${clone.outerHTML}`;
}
```

- [ ] 9. Run `pnpm test` (all green), `pnpm lint`, `pnpm format`.

- [ ] 10. Commit:

```
git add -A && git commit -m "feat(capture): the DOM snapshot and gzip

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The replay recorder and the screenshot

**Files:**
- Create: `src/capture/replay.js`, `src/capture/screenshot.js`
- Test: `tests/replay.test.js`, `tests/screenshot.test.js`

**Interfaces:**
- Consumes: `byteLength` from `src/bytes.js`, `warnOnce` from `src/warn.js`.
- Produces:
  - `src/capture/replay.js`: `REPLAY_JSON_MAX = 8388608`, `CHECKOUT_MS = 60000`, `SAMPLING`, `createSegments(): Segments`, `serializeReplay(segments, { max? }): { json: string | null, dropped: boolean, tooBig: boolean } | null`, `rrwebOptions(capture, emit): object`, `idle(fn): void`, `startReplay(capture, { load?, schedule? }): { segments, ready: Promise<boolean>, stop(): void }`.
    `Segments` is `{ push(event, isCheckout): void, previous(): any[], current(): any[], dropPrevious(): void, events(): any[], count(): number, clear(): void }`.
  - `src/capture/screenshot.js`: `SCREENSHOT_MAX = 5242880`, `HOST_ID = "fbh-host"`, `captureScreenshot({ load?, target?, hostId? }): Promise<Blob | null>`.

**Steps:**

- [ ] 1. Write `tests/replay.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import {
  CHECKOUT_MS,
  SAMPLING,
  createSegments,
  rrwebOptions,
  serializeReplay,
  startReplay,
} from "../src/capture/replay.js";
import { resetWarnings } from "../src/warn.js";

describe("createSegments", () => {
  it("keeps the current segment and the previous one, and no more", () => {
    const segments = createSegments();
    segments.push({ n: 1 }, true);
    segments.push({ n: 2 }, false);
    segments.push({ n: 3 }, true); // checkout: 1,2 become the previous segment
    segments.push({ n: 4 }, false);
    segments.push({ n: 5 }, true); // checkout again: 1,2 are gone for good
    expect(segments.previous()).toEqual([{ n: 3 }, { n: 4 }]);
    expect(segments.current()).toEqual([{ n: 5 }]);
    expect(segments.events()).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
    expect(segments.count()).toBe(3);
  });

  it("ignores a checkout flag on the very first event", () => {
    const segments = createSegments();
    segments.push({ n: 1 }, true);
    expect(segments.previous()).toEqual([]);
    expect(segments.current()).toEqual([{ n: 1 }]);
  });
});

describe("serializeReplay", () => {
  it("is null when nothing was recorded", () => {
    expect(serializeReplay(createSegments())).toBe(null);
  });

  it("serializes both segments when they fit", () => {
    const segments = createSegments();
    segments.push({ n: 1 }, true);
    segments.push({ n: 2 }, true);
    const result = serializeReplay(segments);
    expect(JSON.parse(result.json)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(result.dropped).toBe(false);
    expect(result.tooBig).toBe(false);
  });

  it("drops the previous segment first when the JSON is over the cap", () => {
    const segments = createSegments();
    segments.push({ big: "a".repeat(200) }, true);
    segments.push({ small: "b" }, true);
    const result = serializeReplay(segments, { max: 120 });
    expect(JSON.parse(result.json)).toEqual([{ small: "b" }]);
    expect(result.dropped).toBe(true);
    expect(result.tooBig).toBe(false);
    expect(segments.previous()).toEqual([]);
  });

  it("gives up when even the current segment is over the cap", () => {
    const segments = createSegments();
    segments.push({ big: "a".repeat(200) }, true);
    const result = serializeReplay(segments, { max: 50 });
    expect(result).toEqual({ json: null, dropped: true, tooBig: true });
  });
});

describe("rrwebOptions", () => {
  it("is the spec's recorder configuration", () => {
    const emit = () => {};
    expect(rrwebOptions({ maskAllInputs: false, blank: [] }, emit)).toEqual({
      emit,
      checkoutEveryNms: CHECKOUT_MS,
      maskInputOptions: { password: true },
      maskAllInputs: false,
      sampling: { ...SAMPLING },
      recordCanvas: false,
    });
    expect(CHECKOUT_MS).toBe(60000);
    expect(SAMPLING).toEqual({ mousemove: 50, scroll: 150, input: "last" });
  });

  it("turns the app's blank list into one blockSelector", () => {
    const options = rrwebOptions({ maskAllInputs: true, blank: [".sku-price", ".email"] }, () => {});
    expect(options.blockSelector).toBe(".sku-price,.email");
    expect(options.maskAllInputs).toBe(true);
  });
});

describe("startReplay", () => {
  it("loads the recorder on the scheduled callback and collects events", async () => {
    const stop = vi.fn();
    const load = vi.fn(async () => ({
      record(options) {
        options.emit({ type: 2 }, true);
        options.emit({ type: 3 }, false);
        return stop;
      },
    }));
    const schedule = (fn) => fn();
    const replay = startReplay({ maskAllInputs: false, blank: [] }, { load, schedule });
    expect(await replay.ready).toBe(true);
    expect(replay.segments.events()).toEqual([{ type: 2 }, { type: 3 }]);
    replay.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not start the recorder at all until the callback runs", async () => {
    const load = vi.fn(async () => ({ record: () => () => {} }));
    let run = null;
    const replay = startReplay({}, { load, schedule: (fn) => (run = fn) });
    expect(load).not.toHaveBeenCalled();
    await run();
    expect(await replay.ready).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("warns once and carries on when the recorder cannot be loaded", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const replay = startReplay(
      {},
      { load: async () => { throw new Error("chunk 404"); }, schedule: (fn) => fn() },
    );
    expect(await replay.ready).toBe(false);
    expect(replay.segments.events()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => replay.stop()).not.toThrow();
  });
});
```

- [ ] 2. Run `pnpm test` and watch it fail.

- [ ] 3. Create `src/capture/replay.js`:

```js
// The session replay (spec §5.2): rrweb with a checkout every minute, two segments kept, so a
// report carries between sixty and a hundred and twenty seconds of what the reporter did — and
// nothing older, which is as much a privacy decision as a size one. The recorder is imported
// dynamically on the first idle callback: recording starts about a second after load without the
// app's own start-up paying for it. At submit both segments are serialized; over the cap the
// previous one goes first (spec §5.2), and if the current one alone is still too big there is no
// replay part at all.
import { byteLength } from "../bytes.js";
import { warnOnce } from "../warn.js";

export const REPLAY_JSON_MAX = 8 * 1024 * 1024;
export const CHECKOUT_MS = 60000;
export const SAMPLING = { mousemove: 50, scroll: 150, input: "last" };

export function createSegments() {
  let previous = [];
  let current = [];
  return {
    push(event, isCheckout) {
      if (isCheckout && current.length) {
        previous = current;
        current = [];
      }
      current.push(event);
    },
    previous: () => previous,
    current: () => current,
    dropPrevious() {
      previous = [];
    },
    events: () => previous.concat(current),
    count: () => previous.length + current.length,
    clear() {
      previous = [];
      current = [];
    },
  };
}

export function serializeReplay(segments, { max = REPLAY_JSON_MAX } = {}) {
  if (segments.count() === 0) return null;
  let json = JSON.stringify(segments.events());
  let dropped = false;
  if (byteLength(json) > max && segments.previous().length) {
    segments.dropPrevious();
    json = JSON.stringify(segments.events());
    dropped = true;
  }
  if (byteLength(json) > max) return { json: null, dropped: true, tooBig: true };
  return { json, dropped, tooBig: false };
}

export function rrwebOptions({ maskAllInputs = false, blank = [] } = {}, emit) {
  const options = {
    emit,
    checkoutEveryNms: CHECKOUT_MS,
    maskInputOptions: { password: true },
    maskAllInputs: !!maskAllInputs,
    sampling: { ...SAMPLING },
    recordCanvas: false,
  };
  if (blank && blank.length) options.blockSelector = blank.join(",");
  return options;
}

export function idle(fn) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 2000 });
  else setTimeout(fn, 200);
}

export function startReplay(capture, { load = () => import("@rrweb/record"), schedule = idle } = {}) {
  const segments = createSegments();
  let stopFn = null;
  let stopped = false;

  const ready = new Promise((resolve) => {
    schedule(async () => {
      try {
        const module = await load();
        const record = module.record || module.default;
        if (typeof record !== "function") throw new Error("@rrweb/record exports no record()");
        if (stopped) {
          resolve(false);
          return;
        }
        stopFn = record(rrwebOptions(capture, (event, isCheckout) => segments.push(event, !!isCheckout)));
        resolve(true);
      } catch (err) {
        warnOnce("session replay", err);
        resolve(false);
      }
    });
  });

  return {
    segments,
    ready,
    stop() {
      stopped = true;
      try {
        if (stopFn) stopFn();
      } catch (err) {
        warnOnce("session replay stop", err);
      }
      stopFn = null;
    },
  };
}
```

- [ ] 4. Run `pnpm test` and watch the replay tests pass.

- [ ] 5. Write `tests/screenshot.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import { HOST_ID, SCREENSHOT_MAX, captureScreenshot } from "../src/capture/screenshot.js";
import { resetWarnings } from "../src/warn.js";

const blobOf = (size) => new Blob([new Uint8Array(size)], { type: "image/png" });

describe("captureScreenshot", () => {
  it("calls domToBlob with the spec's options and returns the blob", async () => {
    const domToBlob = vi.fn(async () => blobOf(10));
    const target = { tagName: "BODY" };
    const blob = await captureScreenshot({ load: async () => ({ domToBlob }), target });
    expect(blob.size).toBe(10);
    expect(domToBlob).toHaveBeenCalledTimes(1);
    const [node, options] = domToBlob.mock.calls[0];
    expect(node).toBe(target);
    expect(options.scale).toBe(1);
    expect(options.timeout).toBe(5000);
  });

  it("filters out the panel's own host element", async () => {
    const domToBlob = vi.fn(async () => blobOf(10));
    await captureScreenshot({ load: async () => ({ domToBlob }), target: {} });
    const { filter } = domToBlob.mock.calls[0][1];
    expect(filter({ nodeType: 1, id: HOST_ID })).toBe(false);
    expect(filter({ nodeType: 1, id: "app" })).toBe(true);
    expect(filter({ nodeType: 3 })).toBe(true);
  });

  it("returns null and warns once when the module will not load", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blob = await captureScreenshot({
      load: async () => {
        throw new Error("no chunk");
      },
      target: {},
    });
    expect(blob).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns null for a capture over 5 MB", async () => {
    resetWarnings();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const blob = await captureScreenshot({
      load: async () => ({ domToBlob: async () => blobOf(SCREENSHOT_MAX + 1) }),
      target: {},
    });
    expect(blob).toBe(null);
  });
});
```

- [ ] 6. Run `pnpm test` and watch it fail.

- [ ] 7. Create `src/capture/screenshot.js`:

```js
// The automatic screenshot (spec §5.3): modern-screenshot's domToBlob, imported only when a
// screenshot is actually taken. Two things beyond the spec's literal call: the panel's own host
// element is filtered out (it is on the page by the time the panel asks for a capture, and a
// screenshot of the report form helps nobody), and a capture over the hub's 5 MB cap is dropped
// here rather than rejected there. A failed capture is never fatal (spec §5.8).
import { warnOnce } from "../warn.js";

export const SCREENSHOT_MAX = 5 * 1024 * 1024;
export const HOST_ID = "fbh-host";

export async function captureScreenshot({
  load = () => import("modern-screenshot"),
  target = document.body,
  hostId = HOST_ID,
} = {}) {
  try {
    const { domToBlob } = await load();
    const blob = await domToBlob(target, {
      scale: 1,
      timeout: 5000,
      filter: (node) => !(node && node.nodeType === 1 && node.id === hostId),
    });
    if (!blob) return null;
    if (blob.size > SCREENSHOT_MAX) {
      warnOnce("screenshot", new Error(`the capture is ${blob.size} bytes, over the 5 MB cap`));
      return null;
    }
    return blob;
  } catch (err) {
    warnOnce("screenshot", err);
    return null;
  }
}
```

- [ ] 8. Run `pnpm test` (all green), `pnpm lint`, `pnpm format`.

- [ ] 9. Commit:

```
git add -A && git commit -m "feat(capture): the rrweb recorder and the screenshot

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The report JSON and the bundle builder

**Files:**
- Create: `src/bundle.js`
- Test: `tests/bundle.test.js`

**Interfaces:**
- Consumes: `CLIENT_ID` from `src/version.js`, `byteLength` from `src/bytes.js`.
- Produces `src/bundle.js`:
  - `CAPS = { report: 524288, screenshot: 5242880, dom: 3145728, replay: 8388608, image: 5242880, images: 6, total: 26214400, text: 5000, reply: 2000 }`
  - `buildReport(input): object` — input `{ app, env, version, section, type, text, reporter, page, browser, at, capture, breadcrumbs, console, errors, network }`, output the §5.3 JSON with `client` added.
  - `fitReport(report, max?): { report: object, trimmed: number }`
  - `imageName(blob, index): string`
  - `describeAttachments({ screenshot, dom, replay, images }): string`
  - `buildBundle({ report, screenshot, dom, replay, images }, caps?): { form: FormData, dropped: string[], trimmed: number, size: number, report: object }`

**Steps:**

- [ ] 1. Write `tests/bundle.test.js`:

```js
import { describe, expect, it } from "vitest";
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
  page: { path: "/", view: "browse", title: "Ring Catalog", viewport: [1440, 900], dpr: 2, theme: "dark", language: "en-US", online: true },
  browser: { userAgent: "Mozilla/5.0" },
  at: "2026-09-16T14:02:11.412Z",
  capture: { replay: true, screenshot: true, maskAllInputs: false },
  breadcrumbs: [{ t: "2026-09-16T14:01:50.010Z", kind: "click", target: "button#save-ring 'Save ring'" }],
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
      "client", "app", "env", "version", "section", "type", "text", "reporter", "page",
      "browser", "at", "capture", "breadcrumbs", "console", "errors", "network",
    ]);
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
      network: Array.from({ length: 20 }, (_, i) => ({ t: "t", method: "GET", url: `u${i}`, status: 500, ms: 1 })),
      breadcrumbs: Array.from({ length: 20 }, (_, i) => ({ t: "t", kind: "click", target: `b${i}` })),
    });
    const { report, trimmed } = fitReport(big, 1600);
    expect(trimmed).toBeGreaterThan(0);
    expect(JSON.stringify(report).length).toBeLessThanOrEqual(1600);
    expect(report.breadcrumbs.length).toBe(20);
    expect(report.console.length).toBeLessThan(40);
    if (report.console.length) expect(report.console[0].text).not.toBe("c0");
  });
});

describe("describeAttachments", () => {
  it("names what is going", () => {
    expect(describeAttachments({ screenshot: png(1), dom: gz(1), replay: gz(1), images: [png(1), png(1)] })).toBe(
      "What will be sent: a screenshot of this page, a copy of the page, a recording of the last minute or two, 2 images you added, the console and network log.",
    );
  });

  it("names one image in the singular and drops what is absent", () => {
    expect(describeAttachments({ screenshot: null, dom: null, replay: null, images: [png(1)] })).toBe(
      "What will be sent: 1 image you added, the console and network log.",
    );
  });
});

describe("buildBundle", () => {
  const smallCaps = { ...CAPS, report: 4096, screenshot: 100, dom: 100, replay: 100, image: 100, images: 2, total: 5000 };

  it("builds the multipart parts with the hub's names", async () => {
    const { form, dropped } = buildBundle(
      { report: buildReport(reportInput), screenshot: png(10), dom: gz(10), replay: gz(10), images: [png(5), png(5)] },
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
      { report: buildReport(reportInput), screenshot: png(200), dom: gz(10), replay: gz(10), images: [] },
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
    const caps = { ...smallCaps, replay: 10_000, dom: 10_000, screenshot: 10_000, total: 1200 };
    const { form, dropped } = buildBundle(
      { report: buildReport(reportInput), screenshot: png(300), dom: gz(300), replay: gz(900), images: [] },
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
    const { form } = buildBundle({ report: buildReport(reportInput), images: [jpeg, png(5)] }, smallCaps);
    const names = form.getAll("image").map((file) => file.name);
    expect(names).toEqual(["1.jpg", "2.png"]);
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
```

- [ ] 2. Run `pnpm test` and watch it fail.

- [ ] 3. Create `src/bundle.js`:

```js
// The bundle (spec §5.3): the report JSON plus the attachments, as one multipart body with the
// part names the hub reads (service/src/intake.ts). Pure — no DOM, no network — so every cap and
// every drop is testable in plain Node. The caps are the hub's own; anything over them would come
// back as a 413 naming the part, so the client drops it here and tells the reporter instead.
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

// The order entries are thrown away in when the JSON is over 512 KB: the console first (200
// entries of up to 1 KB is most of the budget), the breadcrumbs last but one and the errors never
// — twenty stack traces are the cheapest and most useful thing in the file.
const TRIM_ORDER = ["console", "network", "breadcrumbs", "errors"];

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
}) {
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
      replay: !!capture.replay,
      screenshot: !!capture.screenshot,
      maskAllInputs: !!capture.maskAllInputs,
    },
    breadcrumbs,
    console: consoleEntries,
    errors,
    network,
  };
}

export function fitReport(report, max = CAPS.report) {
  const out = { ...report };
  for (const key of TRIM_ORDER) out[key] = (report[key] || []).slice();
  let trimmed = 0;
  while (byteLength(JSON.stringify(out)) > max) {
    const from = TRIM_ORDER.find((key) => out[key].length > 0);
    if (!from) break;
    const drop = Math.max(1, Math.ceil(out[from].length / 10));
    out[from] = out[from].slice(drop);
    trimmed += drop;
  }
  return { report: out, trimmed };
}

export function imageName(blob, index) {
  return blob.type === "image/jpeg" ? `${index + 1}.jpg` : `${index + 1}.png`;
}

export function describeAttachments({ screenshot = null, dom = null, replay = null, images = [] } = {}) {
  const parts = [];
  if (screenshot) parts.push("a screenshot of this page");
  if (dom) parts.push("a copy of the page");
  if (replay) parts.push("a recording of the last minute or two");
  if (images.length === 1) parts.push("1 image you added");
  else if (images.length > 1) parts.push(`${images.length} images you added`);
  parts.push("the console and network log");
  return `What will be sent: ${parts.join(", ")}.`;
}

export function buildBundle(
  { report, screenshot = null, dom = null, replay = null, images = [] },
  caps = CAPS,
) {
  const dropped = [];

  let keptImages = images.slice(0, caps.images);
  const extra = images.length - keptImages.length;
  if (extra > 0) dropped.push(`${extra} extra image${extra === 1 ? "" : "s"}`);
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

  // The report part has the whole of its own cap reserved, so trimming the attachments can never
  // be undone by a long report.
  const budget = caps.total - caps.report;
  const attachmentSize = () =>
    (keptScreenshot ? keptScreenshot.size : 0) +
    (keptDom ? keptDom.size : 0) +
    (keptReplay ? keptReplay.size : 0) +
    keptImages.reduce((total, blob) => total + blob.size, 0);

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

  const stamped = {
    ...report,
    capture: { ...report.capture, replay: !!keptReplay, screenshot: !!keptScreenshot },
  };
  const { report: fitted, trimmed } = fitReport(stamped, caps.report);
  const json = JSON.stringify(fitted);

  const form = new FormData();
  form.append("report", new Blob([json], { type: "application/json" }), "report.json");
  if (keptScreenshot) form.append("screenshot", keptScreenshot, "screenshot.png");
  if (keptDom) form.append("dom", keptDom, "dom.html.gz");
  if (keptReplay) form.append("replay", keptReplay, "replay.json.gz");
  keptImages.forEach((blob, index) => form.append("image", blob, imageName(blob, index)));

  return { form, dropped, trimmed, size: attachmentSize() + byteLength(json), report: fitted };
}
```

- [ ] 4. Run `pnpm test` (all green), `pnpm lint`, `pnpm format`.

- [ ] 5. Commit:

```
git add -A && git commit -m "feat(bundle): the report JSON and the multipart bundle builder

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The status map, the shared fixture and the transport

**Files:**
- Create: `fixtures/status-cases.json`, `src/status.js`, `src/transport.js`
- Test: `tests/status.test.js`, `tests/transport.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `src/status.js`: `STATUSES: string[]` (the eleven), `statusLabel(status, ctx): string` where ctx is `{ issue?: number, duplicateOf?: number, originalState?: "open"|"closed"|"fixed" }`, `originalState(original): "open"|"closed"|"fixed"|undefined`, `labelContext({ verdict, original }): object`, `isRetryable(status): boolean`, `needsReply(status): boolean`, `statusTone(status): "info"|"open"|"done"|"muted"|"attention"|"bad"`.
  - `src/transport.js`: `class FeedbackError extends Error { status, code, part, cause }`, `PART_NAMES`, `partFrom(message): string | null`, `messageFor(status, code, message): string`, `createTransport({ hubUrl, app, getToken, fetch? }): { submit(form): Promise<{id}>, list({cursor?,limit?}?): Promise<{items,nextCursor}>, reply(id, text): Promise<{replies,status,label}>, retry(id): Promise<{id,status,label}> }`.
  - `fixtures/status-cases.json`: `{ version, triageTimeoutMinutes, note, cases: [{ name, input, status, label }] }`.

**Steps:**

- [ ] 1. Create `fixtures/status-cases.json` with exactly this content. It is the canonical copy; `amikob-inc/feedback-hub` keeps a byte-identical copy at `service/tests/fixtures/status-cases.json` and both repositories assert the same digest of it, so a change to the rules is a pull request in both (spec §5.9, §6.7).

```json
{
  "version": 1,
  "triageTimeoutMinutes": 20,
  "note": "Shared by amikob-inc/feedback-client (canonical) and amikob-inc/feedback-hub (copy). Changing this file means a pull request in both repositories.",
  "cases": [
    {
      "name": "no dispatch attempt yet",
      "input": {
        "dispatchedMinutesAgo": null,
        "pending": false,
        "verdict": null,
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "triaging",
      "label": "Received, being looked at"
    },
    {
      "name": "dispatched five minutes ago, no verdict",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": null,
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "triaging",
      "label": "Received, being looked at"
    },
    {
      "name": "a pending marker and no verdict",
      "input": {
        "dispatchedMinutesAgo": null,
        "pending": true,
        "verdict": null,
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "waiting",
      "label": "Received, waiting"
    },
    {
      "name": "a pending marker beats a stale dispatch",
      "input": {
        "dispatchedMinutesAgo": 25,
        "pending": true,
        "verdict": null,
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "waiting",
      "label": "Received, waiting"
    },
    {
      "name": "dispatched 25 minutes ago, no verdict, not pending",
      "input": {
        "dispatchedMinutesAgo": 25,
        "pending": false,
        "verdict": null,
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "error",
      "label": "Could not triage"
    },
    {
      "name": "an error verdict",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "error" },
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "error",
      "label": "Could not triage"
    },
    {
      "name": "an error verdict beats a pending marker",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": true,
        "verdict": { "verdict": "error" },
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "error",
      "label": "Could not triage"
    },
    {
      "name": "needs_info with no reply yet",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "needs_info", "questions": ["Which SKU?"] },
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "needs_reply",
      "label": "Needs your reply"
    },
    {
      "name": "needs_info with a reply after the verdict",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "needs_info", "questions": ["Which SKU?"] },
        "repliesAfterVerdict": true,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "triaging",
      "label": "Received, being looked at"
    },
    {
      "name": "answered",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "answered", "answer": "Click Export images." },
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "answered",
      "label": "Answered"
    },
    {
      "name": "unusable",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "unusable", "reason": "The description is empty." },
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "not_filed",
      "label": "Not filed"
    },
    {
      "name": "duplicate of an open issue",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "duplicate", "duplicateOf": 3 },
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": { "number": 3, "state": "open", "stateReason": null, "labels": ["from-panel"] }
      },
      "status": "duplicate",
      "label": "Already tracked as #3 (open)"
    },
    {
      "name": "duplicate of an issue closed as completed",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "duplicate", "duplicateOf": 3 },
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": {
          "number": 3,
          "state": "closed",
          "stateReason": "completed",
          "labels": ["from-panel"]
        }
      },
      "status": "duplicate",
      "label": "Already tracked as #3 (fixed)"
    },
    {
      "name": "duplicate of an issue closed as not planned",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "duplicate", "duplicateOf": 3 },
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": {
          "number": 3,
          "state": "closed",
          "stateReason": "not_planned",
          "labels": ["from-panel"]
        }
      },
      "status": "duplicate",
      "label": "Already tracked as #3 (closed)"
    },
    {
      "name": "duplicate whose original could not be read",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "duplicate", "duplicateOf": 3 },
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "duplicate",
      "label": "Already tracked as #3"
    },
    {
      "name": "filed, the issue could not be read",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "filed", "issueNumber": 7 },
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "filed",
      "label": "Filed as #7"
    },
    {
      "name": "filed with no issue number at all",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "filed" },
        "repliesAfterVerdict": false,
        "issue": null,
        "prs": [],
        "original": null
      },
      "status": "filed",
      "label": "Filed"
    },
    {
      "name": "filed, open issue with no fix activity",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "filed", "issueNumber": 7 },
        "repliesAfterVerdict": false,
        "issue": { "number": 7, "state": "open", "stateReason": null, "labels": ["from-panel"] },
        "prs": [],
        "original": null
      },
      "status": "filed",
      "label": "Filed as #7"
    },
    {
      "name": "filed, open issue labelled ai-candidate only",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "filed", "issueNumber": 7 },
        "repliesAfterVerdict": false,
        "issue": {
          "number": 7,
          "state": "open",
          "stateReason": null,
          "labels": ["from-panel", "ai-candidate"]
        },
        "prs": [],
        "original": null
      },
      "status": "filed",
      "label": "Filed as #7"
    },
    {
      "name": "filed, open issue labelled ai-working",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "filed", "issueNumber": 7 },
        "repliesAfterVerdict": false,
        "issue": {
          "number": 7,
          "state": "open",
          "stateReason": null,
          "labels": ["from-panel", "ai-working"]
        },
        "prs": [],
        "original": null
      },
      "status": "in_progress",
      "label": "Fix in progress"
    },
    {
      "name": "filed, open issue with an open pull request",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "filed", "issueNumber": 7 },
        "repliesAfterVerdict": false,
        "issue": { "number": 7, "state": "open", "stateReason": null, "labels": ["from-panel"] },
        "prs": [{ "number": 9, "state": "open", "merged": false }],
        "original": null
      },
      "status": "in_progress",
      "label": "Fix in progress"
    },
    {
      "name": "filed, issue closed as completed",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "filed", "issueNumber": 7 },
        "repliesAfterVerdict": false,
        "issue": {
          "number": 7,
          "state": "closed",
          "stateReason": "completed",
          "labels": ["from-panel"]
        },
        "prs": [{ "number": 9, "state": "closed", "merged": true }],
        "original": null
      },
      "status": "fixed",
      "label": "Fixed"
    },
    {
      "name": "filed, issue closed as not planned",
      "input": {
        "dispatchedMinutesAgo": 5,
        "pending": false,
        "verdict": { "verdict": "filed", "issueNumber": 7 },
        "repliesAfterVerdict": false,
        "issue": {
          "number": 7,
          "state": "closed",
          "stateReason": "not_planned",
          "labels": ["from-panel"]
        },
        "prs": [],
        "original": null
      },
      "status": "closed",
      "label": "Closed"
    }
  ]
}
```

The `input` fields map one for one onto the hub's `StatusInput` (`service/src/status.ts`): `dispatchedMinutesAgo` becomes the single dispatch attempt (`null` meaning no attempt at all), `pending` the pending marker, `verdict` the stored verdict, `repliesAfterVerdict` the reply flag, and `issue`/`prs`/`original` the GitHub reads. The hub's side of this fixture is a follow-up pull request in `amikob-inc/feedback-hub` — `service/tests/status.test.ts` gains a loop over the copied file asserting `computeStatus` and `statusLabel` for every case, and the same digest constant. Say so in the client's pull request description so the two land together.

- [ ] 2. Write `tests/status.test.js`:

```js
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STATUSES,
  isRetryable,
  labelContext,
  needsReply,
  originalState,
  statusLabel,
  statusTone,
} from "../src/status.js";

const FIXTURE_URL = new URL("../fixtures/status-cases.json", import.meta.url);
const raw = readFileSync(FIXTURE_URL, "utf8");
const fixture = JSON.parse(raw);

describe("statusLabel", () => {
  // Hand-written from the spec's §4 table and the hub's statusLabel, not produced by any code
  // here: these strings are the contract with the hub, and the panel shows them unchanged.
  const cases = [
    ["triaging", {}, "Received, being looked at"],
    ["waiting", {}, "Received, waiting"],
    ["filed", { issue: 42 }, "Filed as #42"],
    ["filed", {}, "Filed"],
    ["in_progress", {}, "Fix in progress"],
    ["fixed", {}, "Fixed"],
    ["closed", {}, "Closed"],
    ["answered", {}, "Answered"],
    ["duplicate", { duplicateOf: 8 }, "Already tracked as #8"],
    ["duplicate", { duplicateOf: 8, originalState: "open" }, "Already tracked as #8 (open)"],
    ["duplicate", { duplicateOf: 8, originalState: "fixed" }, "Already tracked as #8 (fixed)"],
    ["duplicate", { duplicateOf: 8, originalState: "closed" }, "Already tracked as #8 (closed)"],
    ["needs_reply", {}, "Needs your reply"],
    ["not_filed", {}, "Not filed"],
    ["error", {}, "Could not triage"],
  ];

  for (const [status, ctx, expected] of cases) {
    it(`${status} ${JSON.stringify(ctx)} is "${expected}"`, () => {
      expect(statusLabel(status, ctx)).toBe(expected);
    });
  }

  it("has a label for every status it knows", () => {
    for (const status of STATUSES) expect(typeof statusLabel(status, { issue: 1, duplicateOf: 1 })).toBe("string");
  });

  it("says nothing it does not know", () => {
    expect(statusLabel("invented", {})).toBe("");
  });
});

describe("originalState", () => {
  it("maps the original issue's GitHub state the way the hub's listing does", () => {
    expect(originalState(null)).toBe(undefined);
    expect(originalState({ state: "open", stateReason: null })).toBe("open");
    expect(originalState({ state: "closed", stateReason: "completed" })).toBe("fixed");
    expect(originalState({ state: "closed", stateReason: "not_planned" })).toBe("closed");
  });
});

describe("the fixture shared with the hub", () => {
  it("has not drifted (the hub asserts the same digest)", () => {
    const canonical = JSON.stringify(JSON.parse(raw));
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(
      "9ff37288abe6669007d333429ea483a854bd843bdbd473b63254021db9baacab",
    );
  });

  it("covers every status the panel can show", () => {
    const covered = new Set(fixture.cases.map((one) => one.status));
    expect([...covered].sort()).toEqual([...STATUSES].sort());
  });

  it("produces each case's label from its verdict and the original issue", () => {
    for (const one of fixture.cases) {
      const ctx = labelContext({ verdict: one.input.verdict, original: one.input.original });
      expect(`${one.name}: ${statusLabel(one.status, ctx)}`).toBe(`${one.name}: ${one.label}`);
    }
  });

  it("gives every case a tone and the right affordances", () => {
    for (const one of fixture.cases) {
      expect(statusTone(one.status)).not.toBe("");
      expect(isRetryable(one.status)).toBe(one.status === "waiting" || one.status === "error");
      expect(needsReply(one.status)).toBe(one.status === "needs_reply");
    }
  });
});
```

- [ ] 3. Run `pnpm test` and watch it fail.

- [ ] 4. Create `src/status.js`:

```js
// The hub decides a report's status and hands the panel the finished label with every listing
// (service/src/status.ts, listing.ts). This module is the same map on this side, for the row the
// panel adds optimistically after a submit — the hub's 202 carries only an id — and for the pill's
// colour. The strings are the hub's, character for character; fixtures/status-cases.json is
// checked by both repositories so they cannot drift apart quietly.
export const STATUSES = [
  "waiting",
  "triaging",
  "filed",
  "needs_reply",
  "answered",
  "duplicate",
  "not_filed",
  "in_progress",
  "fixed",
  "closed",
  "error",
];

export function statusLabel(status, ctx = {}) {
  switch (status) {
    case "triaging":
      return "Received, being looked at";
    case "waiting":
      return "Received, waiting";
    case "filed":
      return ctx.issue !== undefined ? `Filed as #${ctx.issue}` : "Filed";
    case "in_progress":
      return "Fix in progress";
    case "fixed":
      return "Fixed";
    case "closed":
      return "Closed";
    case "answered":
      return "Answered";
    case "duplicate":
      return `Already tracked as #${ctx.duplicateOf}${ctx.originalState ? ` (${ctx.originalState})` : ""}`;
    case "needs_reply":
      return "Needs your reply";
    case "not_filed":
      return "Not filed";
    case "error":
      return "Could not triage";
    default:
      return "";
  }
}

export function originalState(original) {
  if (!original) return undefined;
  if (original.state !== "closed") return "open";
  return original.stateReason === "completed" ? "fixed" : "closed";
}

export function labelContext({ verdict = null, original = null } = {}) {
  const ctx = {};
  if (verdict && typeof verdict.issueNumber === "number") ctx.issue = verdict.issueNumber;
  if (verdict && typeof verdict.duplicateOf === "number") ctx.duplicateOf = verdict.duplicateOf;
  const state = originalState(original);
  if (state !== undefined) ctx.originalState = state;
  return ctx;
}

// The hub accepts a retry for exactly these two (service/src/routes.ts: anything else is a 409).
export function isRetryable(status) {
  return status === "waiting" || status === "error";
}

export function needsReply(status) {
  return status === "needs_reply";
}

export function statusTone(status) {
  switch (status) {
    case "waiting":
    case "triaging":
      return "info";
    case "filed":
    case "in_progress":
      return "open";
    case "fixed":
      return "done";
    case "closed":
    case "not_filed":
    case "duplicate":
      return "muted";
    case "answered":
    case "needs_reply":
      return "attention";
    case "error":
      return "bad";
    default:
      return "info";
  }
}
```

- [ ] 5. Run `pnpm test` and watch the status tests pass.

- [ ] 6. Write `tests/transport.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import { FeedbackError, createTransport, messageFor, partFrom } from "../src/transport.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function transportWith(fetchImpl, { token = "tok" } = {}) {
  return createTransport({
    hubUrl: "https://hub.example/",
    app: "cad",
    getToken: async () => token,
    fetch: fetchImpl,
  });
}

describe("partFrom and messageFor", () => {
  it("names the attachment a 413 complains about", () => {
    expect(partFrom("screenshot exceeds 5242880 bytes")).toBe("screenshot");
    expect(partFrom("image count exceeds 6")).toBe("image");
    expect(partFrom("request exceeds 26214400 bytes")).toBe("request");
    expect(partFrom("nonsense")).toBe(null);
  });

  it("is the spec's copy for the failures the reporter can act on", () => {
    expect(messageFor(401, "unauthorized", "")).toBe("Your session expired; sign in again.");
    expect(messageFor(413, "too_large", "replay exceeds 8388608 bytes")).toBe(
      "That is too big to send. Leave the recording out and try again.",
    );
    expect(messageFor(413, "too_large", "nonsense")).toBe(
      "That is too big to send. Remove an attachment and try again.",
    );
    expect(messageFor(0, "network", "")).toBe("Couldn't send, retry.");
    expect(messageFor(429, "rate_limited", "")).toBe("You have sent a lot of reports this hour. Try again later.");
    expect(messageFor(429, "too_many_replies", "")).toBe("This report has all the replies it can take.");
    expect(messageFor(409, "not_retryable", "")).toBe("This report has already moved on.");
    expect(messageFor(403, "origin", "")).toBe("This site is not allowed to send reports.");
    expect(messageFor(400, "invalid_text", "")).toBe("Add a description before sending.");
    expect(messageFor(500, "internal", "")).toBe("The hub had a problem. Retry.");
  });
});

describe("createTransport", () => {
  it("posts the bundle with the bearer token and no content type of its own", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(202, { id: "abc" }));
    const form = new FormData();
    form.append("report", new Blob(["{}"], { type: "application/json" }), "report.json");
    const result = await transportWith(fetchImpl).submit(form);
    expect(result).toEqual({ id: "abc" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://hub.example/v1/reports");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer tok" });
    expect(init.body).toBe(form);
    expect(init.credentials).toBe(undefined);
  });

  it("lists with the app query the hub requires", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { items: [{ id: "1" }], nextCursor: null }));
    const page = await transportWith(fetchImpl).list();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://hub.example/v1/reports?app=cad");
    expect(page).toEqual({ items: [{ id: "1" }], nextCursor: null });
  });

  it("sends a reply and a retry to the right routes, both with ?app=", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: "triaging", label: "Received, being looked at", replies: [] }));
    const transport = transportWith(fetchImpl);
    await transport.reply("id 1", "here is more");
    await transport.retry("id 1");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://hub.example/v1/reports/id%201/replies?app=cad");
    expect(fetchImpl.mock.calls[0][1].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ text: "here is more" });
    expect(fetchImpl.mock.calls[1][0]).toBe("https://hub.example/v1/reports/id%201/retry?app=cad");
  });

  it("refuses to call at all without a token", async () => {
    const fetchImpl = vi.fn();
    await expect(transportWith(fetchImpl, { token: null }).list()).rejects.toMatchObject({
      message: "Sign in to report",
      code: "no_token",
      status: 401,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns the hub's error shape into a FeedbackError the panel can show", async () => {
    const fetchImpl = async () => jsonResponse(413, { error: "too_large", message: "screenshot exceeds 5242880 bytes" });
    const error = await transportWith(fetchImpl).submit(new FormData()).catch((err) => err);
    expect(error).toBeInstanceOf(FeedbackError);
    expect(error.status).toBe(413);
    expect(error.code).toBe("too_large");
    expect(error.part).toBe("screenshot");
    expect(error.message).toBe("That is too big to send. Leave the screenshot out and try again.");
  });

  it("turns a thrown fetch into the offline message", async () => {
    const fetchImpl = async () => {
      throw new TypeError("Failed to fetch");
    };
    const error = await transportWith(fetchImpl).list().catch((err) => err);
    expect(error.status).toBe(0);
    expect(error.message).toBe("Couldn't send, retry.");
  });

  it("copes with a body that is not JSON", async () => {
    const fetchImpl = async () => ({ ok: false, status: 502, text: async () => "<html>bad gateway</html>" });
    const error = await transportWith(fetchImpl).list().catch((err) => err);
    expect(error.status).toBe(502);
    expect(error.message).toBe("The hub had a problem. Retry.");
  });
});
```

- [ ] 7. Run `pnpm test` and watch it fail.

- [ ] 8. Create `src/transport.js`:

```js
// The four client routes of the hub (spec §6.3, service/src/routes.ts). Three of them need
// `?app=` — the spec's table only shows it on the listing, but the hub reads the query on the
// reply and retry routes too and answers 404 unknown_app without it. Submit is the exception:
// there the app travels inside the report JSON.
//
// CORS on the hub allows exactly `Authorization` and `Content-Type` and no credentials, so this
// module must never add a header of its own and never set `credentials` (service/src/routes.ts's
// cors()). The multipart POST deliberately sets no Content-Type: the browser writes it with the
// boundary.
export class FeedbackError extends Error {
  constructor(message, { status = 0, code = "network", part = null, cause = null } = {}) {
    super(message);
    this.name = "FeedbackError";
    this.status = status;
    this.code = code;
    this.part = part;
    this.cause = cause;
  }
}

// The hub's 413 message starts with the part it refused (service/src/intake.ts's checkSize).
export const PART_NAMES = {
  report: "the report itself",
  screenshot: "the screenshot",
  dom: "the page copy",
  replay: "the recording",
  image: "an image",
  bundle: "some of the attachments",
  request: "some of the attachments",
};

export function partFrom(message) {
  const match = /^([a-z]+)/.exec(String(message || ""));
  return match && PART_NAMES[match[1]] ? match[1] : null;
}

export function messageFor(status, code, message) {
  if (status === 401) return "Your session expired; sign in again.";
  if (status === 413) {
    const part = partFrom(message);
    return part
      ? `That is too big to send. Leave ${PART_NAMES[part]} out and try again.`
      : "That is too big to send. Remove an attachment and try again.";
  }
  if (status === 429) {
    return code === "too_many_replies"
      ? "This report has all the replies it can take."
      : "You have sent a lot of reports this hour. Try again later.";
  }
  if (status === 409) return "This report has already moved on.";
  if (status === 403) {
    return code === "origin"
      ? "This site is not allowed to send reports."
      : "That report is not yours to open.";
  }
  if (status === 404) {
    return code === "unknown_app"
      ? "This app is not set up in the feedback hub yet."
      : "That report is gone.";
  }
  if (status === 400) {
    if (code === "invalid_text") return "Add a description before sending.";
    if (code === "invalid_image") return "Only PNG and JPEG images can be attached.";
    return "The hub could not read that report.";
  }
  if (status >= 500) return "The hub had a problem. Retry.";
  if (status === 0) return "Couldn't send, retry.";
  return message || "Something went wrong.";
}

export function createTransport({ hubUrl, app, getToken, fetch: fetchImpl } = {}) {
  const base = String(hubUrl || "").replace(/\/+$/, "");
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const appQuery = `app=${encodeURIComponent(app)}`;

  async function authorization() {
    let token = null;
    try {
      token = await getToken();
    } catch (err) {
      throw new FeedbackError("Sign in to report", { status: 401, code: "no_token", cause: err });
    }
    if (!token) throw new FeedbackError("Sign in to report", { status: 401, code: "no_token" });
    return { Authorization: `Bearer ${token}` };
  }

  async function call(path, { method = "GET", headers = {}, body } = {}) {
    const auth = await authorization();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new FeedbackError(messageFor(0, "offline", ""), { status: 0, code: "offline" });
    }
    let res;
    try {
      res = await doFetch(`${base}${path}`, { method, headers: { ...auth, ...headers }, body });
    } catch (err) {
      throw new FeedbackError(messageFor(0, "network", ""), { status: 0, code: "network", cause: err });
    }
    const text = await res.text().catch(() => "");
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const code = (data && data.error) || "http_error";
      const detail = (data && data.message) || "";
      throw new FeedbackError(messageFor(res.status, code, detail), {
        status: res.status,
        code,
        part: res.status === 413 ? partFrom(detail) : null,
      });
    }
    return data || {};
  }

  return {
    submit(form) {
      return call("/v1/reports", { method: "POST", body: form });
    },
    async list({ cursor, limit } = {}) {
      let path = `/v1/reports?${appQuery}`;
      if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
      if (limit) path += `&limit=${encodeURIComponent(limit)}`;
      const page = await call(path);
      return {
        items: Array.isArray(page.items) ? page.items : [],
        nextCursor: page.nextCursor === undefined ? null : page.nextCursor,
      };
    },
    reply(id, text) {
      return call(`/v1/reports/${encodeURIComponent(id)}/replies?${appQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    },
    retry(id) {
      return call(`/v1/reports/${encodeURIComponent(id)}/retry?${appQuery}`, { method: "POST" });
    },
  };
}
```

- [ ] 9. Run `pnpm test` (all green), `pnpm lint`, `pnpm format`.

- [ ] 10. Commit:

```
git add -A && git commit -m "feat(hub): the shared status fixture, the status map and the transport

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The options, the "seen" map and the headless mount API

**Files:**
- Create: `src/options.js`, `src/seen.js`, `src/mount.js`, `src/index.js`
- Test: `tests/options.test.js`, `tests/seen.test.js`, `tests/mount.test.js`

**Interfaces:**
- Consumes: `installBuffers`; `CAPS`, `buildReport`, `buildBundle`; `snapshotDom`; `gzip`; `startReplay`, `serializeReplay`, `idle`; `captureScreenshot`; `createTransport`, `FeedbackError`; `warnOnce`.
- Produces:
  - `src/options.js`: `class OptionError extends Error`, `OPTION_KEYS`, `CAPTURE_KEYS`, `DEFAULT_TYPES`, `DEFAULT_SECTIONS`, `DEFAULT_CAPTURE`, `defaultSection(sections, view): string`, `normalizeOptions(raw): NormalizedOptions`.
  - `src/seen.js`: `SEEN_PREFIX`, `SEEN_CAP`, `seenKey(app, reporterId): string`, `safeStorage(win): Storage | null`, `readSeen(storage, key): object`, `writeSeen(storage, key, seen): void`, `attentionIds(items, seen): string[]`, `markSeen(seen, items): { seen, changed }`.
  - `src/mount.js`: `mountFeedback(rawOptions, deps?): { open, close, submit, list, reply, retry, destroy }`, `pageContext({ doc, win, options }): object`, `resolveButton(button, doc): Element | null`.
    `deps` (a test and embedding seam, not part of the option object): `{ doc, win, fetch, transport, storage, schedule, loadRecorder, loadScreenshot, createPanel }`.
  - `src/index.js`: re-exports `mountFeedback`, `FeedbackError`, `statusLabel`, `STATUSES`, `CLIENT_ID`, `CLIENT_VERSION`.

**Steps:**

- [ ] 1. Write `tests/options.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPTURE,
  DEFAULT_TYPES,
  OptionError,
  defaultSection,
  normalizeOptions,
} from "../src/options.js";

const base = { app: "cad", hubUrl: "https://hub.example", getToken: async () => "t" };

describe("normalizeOptions", () => {
  it("throws on an option it does not know, naming it", () => {
    expect(() => normalizeOptions({ ...base, hubURL: "x" })).toThrow(OptionError);
    expect(() => normalizeOptions({ ...base, hubURL: "x" })).toThrow(/unknown option "hubURL"/);
  });

  it("throws on an unknown capture key", () => {
    expect(() => normalizeOptions({ ...base, capture: { relpay: true } })).toThrow(/unknown capture option "relpay"/);
  });

  it("requires app", () => {
    expect(() => normalizeOptions({ hubUrl: "https://h", getToken: async () => "t" })).toThrow(/"app"/);
  });

  it("requires getToken when there is a hub", () => {
    expect(() => normalizeOptions({ app: "cad", hubUrl: "https://h" })).toThrow(/"getToken"/);
  });

  it("allows a missing getToken when the feature is off", () => {
    expect(normalizeOptions({ app: "cad" }).hubUrl).toBe("");
  });

  it("trims trailing slashes off the hub URL", () => {
    expect(normalizeOptions({ ...base, hubUrl: "https://hub.example//" }).hubUrl).toBe("https://hub.example");
  });

  it("fills in the defaults the spec names", () => {
    const options = normalizeOptions(base);
    expect(options.types).toEqual(DEFAULT_TYPES);
    expect(options.sections).toEqual(["General"]);
    expect(options.capture).toEqual(DEFAULT_CAPTURE);
    expect(options.theme()).toBe("light");
    expect(options.user()).toBe(null);
    expect(options.section()).toBe("");
  });

  it("keeps the app's own lists and capture switches", () => {
    const options = normalizeOptions({
      ...base,
      sections: ["Rendering", "Mockups", "Catalog (SKU)", "General"],
      types: ["Bug", "Question"],
      capture: { replay: false, blank: [".sku-price"] },
    });
    expect(options.sections).toHaveLength(4);
    expect(options.types).toEqual(["Bug", "Question"]);
    expect(options.capture.replay).toBe(false);
    expect(options.capture.screenshot).toBe(true);
    expect(options.capture.blank).toEqual([".sku-price"]);
  });

  it("rejects a list that is not strings and a hook that is not a function", () => {
    expect(() => normalizeOptions({ ...base, sections: "General" })).toThrow(/"sections"/);
    expect(() => normalizeOptions({ ...base, types: [1] })).toThrow(/"types"/);
    expect(() => normalizeOptions({ ...base, theme: "dark" })).toThrow(/"theme"/);
    expect(() => normalizeOptions({ ...base, capture: { blank: ".x" } })).toThrow(/"blank"/);
  });
});

describe("defaultSection", () => {
  const sections = ["Rendering", "Mockups", "Catalog (SKU)", "General"];
  it("matches the app's current view when it is one of the sections", () => {
    expect(defaultSection(sections, "Mockups")).toBe("Mockups");
    expect(defaultSection(sections, "mockups")).toBe("Mockups");
  });
  it("falls back to the last section, which is the catch-all", () => {
    expect(defaultSection(sections, "browse")).toBe("General");
    expect(defaultSection(sections, "")).toBe("General");
  });
});
```

- [ ] 2. Run `pnpm test` and watch it fail.

- [ ] 3. Create `src/options.js`:

```js
// Mount options (spec §5.5). Unknown keys throw so a typo is a development-time error rather than
// a feature that silently does nothing — `hubURL` instead of `hubUrl` would otherwise hide the
// whole panel. Every hook is stored as a function and called lazily, at open or submit, so
// nothing here reads app state at module-evaluation time (cad-dashboard's import-cycle rule).
export class OptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "OptionError";
  }
}

export const OPTION_KEYS = [
  "hubUrl",
  "app",
  "env",
  "version",
  "getToken",
  "user",
  "section",
  "sections",
  "types",
  "button",
  "theme",
  "onSummary",
  "capture",
];

export const CAPTURE_KEYS = ["replay", "screenshot", "console", "network", "maskAllInputs", "blank"];
export const DEFAULT_TYPES = ["Bug", "Efficiency suggestion", "Question", "Other"];
export const DEFAULT_SECTIONS = ["General"];
export const DEFAULT_CAPTURE = {
  replay: true,
  screenshot: true,
  console: true,
  network: true,
  maskAllInputs: false,
  blank: [],
};

function text(value) {
  return typeof value === "string" ? value : "";
}

function hook(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "function") throw new OptionError(`option "${name}" must be a function`);
  return value;
}

function stringList(value, name, fallback) {
  if (value === undefined || value === null) return fallback.slice();
  if (!Array.isArray(value) || value.some((one) => typeof one !== "string" || !one.trim())) {
    throw new OptionError(`option "${name}" must be an array of non-empty strings`);
  }
  return value.slice();
}

function normalizeCapture(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_CAPTURE, blank: [] };
  if (typeof raw !== "object") throw new OptionError('option "capture" must be an object');
  for (const key of Object.keys(raw)) {
    if (!CAPTURE_KEYS.includes(key)) {
      throw new OptionError(`unknown capture option "${key}"; the capture options are ${CAPTURE_KEYS.join(", ")}`);
    }
  }
  const capture = { ...DEFAULT_CAPTURE, blank: [] };
  for (const key of ["replay", "screenshot", "console", "network", "maskAllInputs"]) {
    if (raw[key] !== undefined) capture[key] = !!raw[key];
  }
  capture.blank = stringList(raw.blank, "blank", []);
  return capture;
}

export function defaultSection(sections, view) {
  const list = sections && sections.length ? sections : DEFAULT_SECTIONS;
  const wanted = String(view || "").trim().toLowerCase();
  return list.find((one) => one.toLowerCase() === wanted) || list[list.length - 1];
}

export function normalizeOptions(raw) {
  if (!raw || typeof raw !== "object") throw new OptionError("mountFeedback needs an options object");
  for (const key of Object.keys(raw)) {
    if (!OPTION_KEYS.includes(key)) {
      throw new OptionError(`unknown option "${key}"; the options are ${OPTION_KEYS.join(", ")}`);
    }
  }
  if (typeof raw.app !== "string" || !raw.app.trim()) {
    throw new OptionError('option "app" is required and must be a non-empty string');
  }
  const hubUrl = text(raw.hubUrl).replace(/\/+$/, "");
  if (hubUrl && typeof raw.getToken !== "function") {
    throw new OptionError('option "getToken" must be a function returning the access token');
  }
  if (raw.button !== undefined && raw.button !== null) {
    const ok = typeof raw.button === "string" || typeof raw.button.addEventListener === "function";
    if (!ok) throw new OptionError('option "button" must be a selector or an element');
  }

  return {
    hubUrl,
    app: raw.app.trim(),
    env: text(raw.env),
    version: text(raw.version),
    getToken: hook(raw.getToken, "getToken", async () => null),
    user: hook(raw.user, "user", () => null),
    section: hook(raw.section, "section", () => ""),
    sections: stringList(raw.sections, "sections", DEFAULT_SECTIONS),
    types: stringList(raw.types, "types", DEFAULT_TYPES),
    button: raw.button === undefined ? null : raw.button,
    theme: hook(raw.theme, "theme", () => "light"),
    onSummary: hook(raw.onSummary, "onSummary", () => {}),
    capture: normalizeCapture(raw.capture),
  };
}
```

- [ ] 4. Run `pnpm test` and watch the options tests pass.

- [ ] 5. Write `tests/seen.test.js`:

```js
import { describe, expect, it } from "vitest";
import { SEEN_CAP, attentionIds, markSeen, readSeen, seenKey, writeSeen } from "../src/seen.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
  };
}

const answered = (id, at) => ({ id, status: "answered", verdict: { receivedAt: at } });

describe("seenKey", () => {
  it("is per app and per reporter", () => {
    expect(seenKey("cad", "sub-1")).toBe("fbh.seen.cad.sub-1");
    expect(seenKey("cad", null)).toBe("fbh.seen.cad.anon");
  });
});

describe("readSeen and writeSeen", () => {
  it("round-trips and survives rubbish in storage", () => {
    const storage = fakeStorage({ "fbh.seen.cad.a": "not json" });
    expect(readSeen(storage, "fbh.seen.cad.a")).toEqual({});
    writeSeen(storage, "fbh.seen.cad.a", { one: "2026-09-21T10:00:00.000Z" });
    expect(readSeen(storage, "fbh.seen.cad.a")).toEqual({ one: "2026-09-21T10:00:00.000Z" });
  });

  it("does nothing at all without storage", () => {
    expect(readSeen(null, "k")).toEqual({});
    expect(() => writeSeen(null, "k", { a: "b" })).not.toThrow();
  });

  it("keeps at most 200 entries", () => {
    const storage = fakeStorage();
    const seen = {};
    for (let i = 0; i < SEEN_CAP + 10; i += 1) seen[`id${i}`] = "t";
    writeSeen(storage, "k", seen);
    expect(Object.keys(readSeen(storage, "k"))).toHaveLength(SEEN_CAP);
  });

  it("swallows a storage that refuses to write", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => writeSeen(storage, "k", { a: "b" })).not.toThrow();
  });
});

describe("attentionIds", () => {
  it("counts questions waiting and answers not yet seen", () => {
    const items = [
      { id: "q", status: "needs_reply", verdict: { receivedAt: "t1" } },
      answered("a", "t2"),
      answered("b", "t3"),
      { id: "f", status: "filed", verdict: { receivedAt: "t4" } },
    ];
    expect(attentionIds(items, { b: "t3" })).toEqual(["q", "a"]);
  });

  it("counts an answer again when the verdict is newer than what was seen", () => {
    expect(attentionIds([answered("a", "t9")], { a: "t2" })).toEqual(["a"]);
  });
});

describe("markSeen", () => {
  it("records each item's verdict time and reports whether anything changed", () => {
    const first = markSeen({}, [answered("a", "t1"), { id: "n", status: "triaging", verdict: null }]);
    expect(first.changed).toBe(true);
    expect(first.seen).toEqual({ a: "t1" });
    const again = markSeen(first.seen, [answered("a", "t1")]);
    expect(again.changed).toBe(false);
  });
});
```

- [ ] 6. Run `pnpm test` and watch it fail.

- [ ] 7. Create `src/seen.js`:

```js
// What the reporter has already seen, per reporter, in localStorage (spec §5.4). It decides the
// topbar dot: a report needs attention when the AI is waiting for an answer, or when it answered
// since the last time this reporter looked. Storage can be absent, full or blocked (private
// windows, strict settings), and none of that may cost the panel anything.
export const SEEN_PREFIX = "fbh.seen";
export const SEEN_CAP = 200;

export function seenKey(app, reporterId) {
  return `${SEEN_PREFIX}.${app}.${reporterId || "anon"}`;
}

export function safeStorage(win) {
  try {
    const storage = win.localStorage;
    storage.getItem(`${SEEN_PREFIX}.probe`);
    return storage;
  } catch {
    return null;
  }
}

export function readSeen(storage, key) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSeen(storage, key, seen) {
  if (!storage) return;
  try {
    const entries = Object.entries(seen).slice(-SEEN_CAP);
    storage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // A full or blocked storage costs the dot its memory, nothing more.
  }
}

export function attentionIds(items, seen = {}) {
  const ids = [];
  for (const item of items) {
    if (item.status === "needs_reply") {
      ids.push(item.id);
      continue;
    }
    const at = item.verdict && item.verdict.receivedAt;
    if (item.status === "answered" && at && seen[item.id] !== at) ids.push(item.id);
  }
  return ids;
}

export function markSeen(seen, items) {
  const next = { ...seen };
  let changed = false;
  for (const item of items) {
    const at = item.verdict && item.verdict.receivedAt;
    if (at && next[item.id] !== at) {
      next[item.id] = at;
      changed = true;
    }
  }
  return { seen: next, changed };
}
```

- [ ] 8. Run `pnpm test` and watch the seen tests pass.

- [ ] 9. Write `tests/mount.test.js`:

```js
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountFeedback, pageContext, resolveButton } from "../src/mount.js";

const run = (fn) => fn();

function fakeTransport(overrides = {}) {
  return {
    submit: vi.fn(async () => ({ id: "report-1" })),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    reply: vi.fn(async () => ({ replies: [], status: "triaging", label: "Received, being looked at" })),
    retry: vi.fn(async () => ({ id: "report-1", status: "triaging", label: "Received, being looked at" })),
    ...overrides,
  };
}

function mount(options = {}, deps = {}) {
  const transport = deps.transport || fakeTransport();
  const handle = mountFeedback(
    {
      hubUrl: "https://hub.example",
      app: "cad",
      env: "production",
      version: "sha-1",
      getToken: async () => "token",
      user: () => ({ id: "sub-1", name: "Dana", email: "dana@example.com", role: "admin" }),
      section: () => "Mockups",
      sections: ["Rendering", "Mockups", "Catalog (SKU)", "General"],
      types: ["Bug", "Efficiency suggestion", "Question", "Other"],
      capture: { replay: false, screenshot: false },
      ...options,
    },
    { transport, schedule: () => {}, storage: null, ...deps },
  );
  return { handle, transport };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("resolveButton", () => {
  it("takes a selector or an element", () => {
    document.body.innerHTML = `<button id="b"></button>`;
    expect(resolveButton("#b", document)).toBe(document.getElementById("b"));
    expect(resolveButton(document.getElementById("b"), document)).toBe(document.getElementById("b"));
    expect(resolveButton("#missing", document)).toBe(null);
    expect(resolveButton(null, document)).toBe(null);
  });
});

describe("mountFeedback with no hub", () => {
  it("hides the button and answers inertly", async () => {
    document.body.innerHTML = `<button id="b"></button>`;
    const handle = mountFeedback({ app: "cad", button: "#b" });
    expect(document.getElementById("b").hidden).toBe(true);
    expect(await handle.list()).toEqual({ items: [], nextCursor: null });
    expect(() => handle.open()).not.toThrow();
    handle.destroy();
  });
});

describe("pageContext", () => {
  it("carries the path and hash but never a query string", () => {
    window.history.replaceState({}, "", "/rings?token=secret#batch-3");
    const context = pageContext({
      doc: document,
      win: window,
      options: { section: () => "browse", theme: () => "dark" },
    });
    expect(context.path).toBe("/rings#batch-3");
    expect(context.view).toBe("browse");
    expect(context.theme).toBe("dark");
    expect(Array.isArray(context.viewport)).toBe(true);
    expect(context.online).toBe(true);
  });
});

describe("submit", () => {
  it("sends a report with the buffers, the page context and the client id", async () => {
    document.body.innerHTML = `<button id="save">Save ring</button>`;
    const { handle, transport } = mount();
    document.getElementById("save").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    console.error("TypeError: nope");
    const result = await handle.submit({ type: "Bug", text: "  the popup does not open  ", images: [] });
    expect(result.id).toBe("report-1");
    const form = transport.submit.mock.calls[0][0];
    const report = JSON.parse(await form.get("report").text());
    expect(report.client).toMatch(/^feedback-client\//);
    expect(report.app).toBe("cad");
    expect(report.env).toBe("production");
    expect(report.version).toBe("sha-1");
    expect(report.text).toBe("the popup does not open");
    expect(report.type).toBe("Bug");
    expect(report.section).toBe("Mockups");
    expect(report.reporter.name).toBe("Dana");
    expect(report.breadcrumbs.some((one) => one.target.includes("Save ring"))).toBe(true);
    expect(report.console.some((one) => one.text.includes("TypeError"))).toBe(true);
    expect(report.capture).toEqual({ replay: false, screenshot: false, maskAllInputs: false });
    expect(form.get("dom")).not.toBe(null);
    handle.destroy();
  });

  it("refuses an empty description without calling the hub", async () => {
    const { handle, transport } = mount();
    await expect(handle.submit({ text: "   " })).rejects.toMatchObject({ code: "invalid_text" });
    expect(transport.submit).not.toHaveBeenCalled();
    handle.destroy();
  });

  it("takes a screenshot it is given and captures one when it is not", async () => {
    const screenshot = new Blob([new Uint8Array(4)], { type: "image/png" });
    const loadScreenshot = vi.fn(async () => ({ domToBlob: async () => screenshot }));
    const { handle, transport } = mount({ capture: { replay: false, screenshot: true } }, { loadScreenshot });
    await handle.submit({ text: "one", screenshot: null });
    expect(transport.submit.mock.calls[0][0].get("screenshot")).toBe(null);
    expect(loadScreenshot).not.toHaveBeenCalled();
    await handle.submit({ text: "two" });
    expect(transport.submit.mock.calls[1][0].get("screenshot")).not.toBe(null);
    handle.destroy();
  });

  it("attaches the recording, gzipped, unless it is left out", async () => {
    const loadRecorder = async () => ({
      record(options) {
        options.emit({ type: 2, data: { x: 1 } }, true);
        return () => {};
      },
    });
    const { handle, transport } = mount(
      { capture: { replay: true, screenshot: false } },
      { loadRecorder, schedule: run },
    );
    await handle.submit({ text: "with" });
    const withReplay = transport.submit.mock.calls[0][0].get("replay");
    expect(withReplay.type).toBe("application/gzip");
    await handle.submit({ text: "without", includeReplay: false });
    expect(transport.submit.mock.calls[1][0].get("replay")).toBe(null);
    handle.destroy();
  });
});

describe("list, reply, retry and the summary", () => {
  it("reports how many need attention, and again when it changes", async () => {
    const onSummary = vi.fn();
    const items = [
      { id: "q", status: "needs_reply", verdict: { receivedAt: "t1", questions: ["Which SKU?"] } },
      { id: "a", status: "answered", verdict: { receivedAt: "t2", answer: "Click Export" } },
    ];
    const transport = fakeTransport({ list: vi.fn(async () => ({ items, nextCursor: null })) });
    const { handle } = mount({ onSummary }, { transport });
    await handle.list();
    expect(onSummary).toHaveBeenCalledWith({ attention: 2 });
    await handle.list();
    expect(onSummary).toHaveBeenCalledTimes(1); // unchanged, so no second call
    handle.destroy();
  });

  it("primes the dot once after mount", async () => {
    const transport = fakeTransport();
    const { handle } = mount({}, { transport, schedule: run });
    await Promise.resolve();
    expect(transport.list).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it("trims a reply and refuses an empty one", async () => {
    const { handle, transport } = mount();
    await handle.reply("id-1", "  more detail  ");
    expect(transport.reply).toHaveBeenCalledWith("id-1", "more detail");
    await expect(handle.reply("id-1", " ")).rejects.toMatchObject({ code: "invalid_text" });
    handle.destroy();
  });

  it("passes a retry through", async () => {
    const { handle, transport } = mount();
    await handle.retry("id-1");
    expect(transport.retry).toHaveBeenCalledWith("id-1");
    handle.destroy();
  });
});

describe("destroy", () => {
  it("stops recording everything", async () => {
    const { handle } = mount();
    handle.destroy();
    console.error("after destroy");
    document.body.innerHTML = `<button id="x">x</button>`;
    document.getElementById("x").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const { handle: second, transport } = mount();
    await second.submit({ text: "fresh" });
    const report = JSON.parse(await transport.submit.mock.calls[0][0].get("report").text());
    expect(report.console.some((one) => one.text === "after destroy")).toBe(false);
    second.destroy();
  });
});
```

- [ ] 10. Run `pnpm test` and watch it fail.

- [ ] 11. Create `src/mount.js`:

```js
// mountFeedback (spec §5.5) and the headless API behind the panel (spec §5.4, "Headless use").
// Everything the app gave us is a function called lazily, at open or submit, so mounting reads no
// app state and the module can be imported in any order. The second argument is a seam for tests
// and for an app that brings its own panel: it is not part of the public option object, so a typo
// there is a missing feature, not a thrown OptionError.
import { installBuffers } from "./buffers/install.js";
import { CAPS, buildBundle, buildReport } from "./bundle.js";
import { snapshotDom } from "./capture/dom.js";
import { gzip } from "./capture/gzip.js";
import { idle, serializeReplay, startReplay } from "./capture/replay.js";
import { captureScreenshot } from "./capture/screenshot.js";
import { defaultSection, normalizeOptions } from "./options.js";
import { attentionIds, markSeen, readSeen, safeStorage, seenKey, writeSeen } from "./seen.js";
import { FeedbackError, createTransport } from "./transport.js";
import { warnOnce } from "./warn.js";

// Task 13 sets this to the built-in panel; until then a mount without its own `createPanel` is
// headless and `open()` says so once.
const defaultPanelFactory = null;

function safeCall(fn, fallback, label = "callback") {
  try {
    return fn();
  } catch (err) {
    warnOnce(label, err);
    return fallback;
  }
}

export function resolveButton(button, doc) {
  if (!button) return null;
  if (typeof button === "string") return doc.querySelector(button);
  return typeof button.addEventListener === "function" ? button : null;
}

export function pageContext({ doc, win, options }) {
  const nav = win.navigator || {};
  return {
    path: `${win.location.pathname}${win.location.hash}`,
    view: safeCall(options.section, "", "section()") || "",
    title: doc.title || "",
    viewport: [win.innerWidth || 0, win.innerHeight || 0],
    dpr: win.devicePixelRatio || 1,
    theme: safeCall(options.theme, "light", "theme()") === "dark" ? "dark" : "light",
    language: nav.language || "",
    online: nav.onLine !== false,
  };
}

function inertHandle() {
  const noop = () => {};
  return {
    open: noop,
    close: noop,
    async submit() {
      return null;
    },
    async list() {
      return { items: [], nextCursor: null };
    },
    async reply() {
      return null;
    },
    async retry() {
      return null;
    },
    destroy: noop,
  };
}

export function mountFeedback(rawOptions, deps = {}) {
  const options = normalizeOptions(rawOptions);
  const doc = deps.doc || document;
  const win = deps.win || doc.defaultView || window;
  const button = resolveButton(options.button, doc);

  // No hub URL: the feature is off, the app's button is hidden and every call is a no-op
  // (spec §5.5). This is also the emergency switch — a redeploy without the variable.
  if (!options.hubUrl) {
    if (button) button.hidden = true;
    return inertHandle();
  }
  if (button) button.hidden = false;

  const transport =
    deps.transport ||
    createTransport({
      hubUrl: options.hubUrl,
      app: options.app,
      getToken: options.getToken,
      fetch: deps.fetch,
    });
  const buffers = installBuffers({ win, doc, capture: options.capture });
  const replay = options.capture.replay
    ? startReplay(options.capture, { load: deps.loadRecorder, schedule: deps.schedule })
    : null;
  const storage = deps.storage !== undefined ? deps.storage : safeStorage(win);
  const schedule = deps.schedule || idle;

  let panel = null;
  let seen = {};
  let seenFor = null;
  let attention = -1;
  let destroyed = false;

  function currentUser() {
    return safeCall(options.user, null, "user()");
  }

  function loadSeen() {
    const user = currentUser();
    const key = seenKey(options.app, user && user.id);
    if (key !== seenFor) {
      seenFor = key;
      seen = readSeen(storage, key);
    }
    return key;
  }

  function publishSummary(items) {
    loadSeen();
    const count = attentionIds(items, seen).length;
    if (count === attention) return count;
    attention = count;
    safeCall(() => options.onSummary({ attention: count }), undefined, "onSummary()");
    return count;
  }

  async function list() {
    const page = await transport.list();
    publishSummary(page.items);
    return page;
  }

  // The panel calls this once it has rendered a page of reports: what the reporter has now seen
  // stops counting towards the dot.
  function markRead(items) {
    const key = loadSeen();
    const next = markSeen(seen, items);
    if (next.changed) {
      seen = next.seen;
      writeSeen(storage, key, seen);
    }
    publishSummary(items);
  }

  function captureNow() {
    return captureScreenshot({ load: deps.loadScreenshot, target: doc.body });
  }

  async function domPart() {
    try {
      const html = snapshotDom(doc, {
        maskAllInputs: options.capture.maskAllInputs,
        blank: options.capture.blank,
      });
      return await gzip(html);
    } catch (err) {
      warnOnce("page snapshot", err);
      return null;
    }
  }

  async function replayPart() {
    if (!replay) return null;
    const serialized = serializeReplay(replay.segments);
    if (!serialized || !serialized.json) return null;
    return gzip(serialized.json);
  }

  async function submit(fields = {}) {
    const text = String(fields.text || "").trim();
    if (!text) {
      throw new FeedbackError("Add a description before sending.", { status: 400, code: "invalid_text" });
    }
    if (text.length > CAPS.text) {
      throw new FeedbackError(`Keep the description under ${CAPS.text} characters.`, {
        status: 400,
        code: "invalid_text",
      });
    }

    const section = fields.section || defaultSection(options.sections, safeCall(options.section, "", "section()"));
    const type = fields.type || options.types[0];
    const images = Array.isArray(fields.images) ? fields.images : [];
    const screenshot =
      fields.screenshot !== undefined
        ? fields.screenshot
        : options.capture.screenshot
          ? await captureNow()
          : null;
    const replayBlob = fields.includeReplay === false ? null : await replayPart();
    const domBlob = await domPart();

    const report = buildReport({
      app: options.app,
      env: options.env,
      version: options.version,
      section,
      type,
      text,
      reporter: currentUser(),
      page: pageContext({ doc, win, options }),
      browser: { userAgent: (win.navigator && win.navigator.userAgent) || "" },
      at: new Date().toISOString(),
      capture: {
        replay: !!replayBlob,
        screenshot: !!screenshot,
        maskAllInputs: options.capture.maskAllInputs,
      },
      breadcrumbs: buffers.breadcrumbs(),
      console: buffers.console(),
      errors: buffers.errors(),
      network: buffers.network(),
    });

    const bundle = buildBundle({ report, screenshot, dom: domBlob, replay: replayBlob, images });
    const answer = await transport.submit(bundle.form);
    return { id: answer.id, dropped: bundle.dropped };
  }

  async function reply(id, value) {
    const text = String(value || "").trim();
    if (!text) throw new FeedbackError("Write a reply first.", { status: 400, code: "invalid_text" });
    if (text.length > CAPS.reply) {
      throw new FeedbackError(`Keep the reply under ${CAPS.reply} characters.`, {
        status: 400,
        code: "invalid_text",
      });
    }
    return transport.reply(id, text);
  }

  function retry(id) {
    return transport.retry(id);
  }

  function ensurePanel() {
    if (panel || destroyed) return panel;
    const factory = deps.createPanel || defaultPanelFactory;
    if (!factory) {
      warnOnce("panel", new Error("this build was mounted headless: open() has no panel to show"));
      return null;
    }
    panel = factory({ api: internal, options, doc });
    return panel;
  }

  function open() {
    const current = ensurePanel();
    if (current) current.open();
  }

  function close() {
    if (panel) panel.close();
  }

  function onButtonClick(event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    open();
  }

  function destroy() {
    destroyed = true;
    if (button) button.removeEventListener("click", onButtonClick);
    if (panel) panel.destroy();
    panel = null;
    if (replay) replay.stop();
    buffers.uninstall();
  }

  const handle = { open, close, submit, list, reply, retry, destroy };
  // What the panel gets: the same seven functions plus the two it alone needs.
  const internal = { ...handle, markRead, captureScreenshot: captureNow, options };

  if (button) button.addEventListener("click", onButtonClick);
  // One listing after the first idle callback, so the app's topbar dot is right before anyone
  // opens the panel. A signed-out visitor has no token and the call is dropped silently.
  schedule(() => {
    if (destroyed) return;
    list().catch(() => {});
  });

  return handle;
}
```

- [ ] 12. Create `src/index.js`:

```js
// The package's only entry (package.json "exports"). Everything else is an implementation detail,
// though nothing stops an app importing a leaf module directly.
export { mountFeedback } from "./mount.js";
export { FeedbackError } from "./transport.js";
export { STATUSES, statusLabel } from "./status.js";
export { CLIENT_ID, CLIENT_VERSION } from "./version.js";
```

- [ ] 13. Run `pnpm test` (all green), `pnpm lint`, `pnpm format`.

- [ ] 14. Commit:

```
git add -A && git commit -m "feat(mount): the options, the seen map and the headless mount API

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: The DOM helpers, the screen capture and the report form

**Files:**
- Create: `src/panel/dom.js`, `src/capture/screen.js`, `src/panel/form.js`
- Test: `tests/panel-dom.test.js`, `tests/screen-capture.test.js`, `tests/form.test.js`

**Interfaces:**
- Consumes: `CAPS`, `describeAttachments` from `src/bundle.js`; `defaultSection` from `src/options.js`; the internal api from `src/mount.js` (`submit`, `captureScreenshot`, `options`).
- Produces:
  - `src/panel/dom.js`: `el(doc, tag, attrs?, children?): Element`, `clear(node): void`, `firstLine(text, max?): string`, `relativeTime(iso, now?): string`.
  - `src/capture/screen.js`: `FRAME_WAIT_MS = 200`, `screenCaptureSupported(win): boolean`, `captureScreen({ doc, win, frameWaitMs? }): Promise<Blob | null>`.
  - `src/panel/form.js`: `ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg"]`, `createForm({ api, options, doc, win?, onSubmitted, captureScreen? }): { element, prepare(): Promise<void>, release(): void, destroy(): void, addImage(blob, name?): boolean, replaceImage(id, blob): void, focus(): void }`.

**Steps:**

- [ ] 1. Write `tests/panel-dom.test.js`:

```js
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { clear, el, firstLine, relativeTime } from "../src/panel/dom.js";

describe("el", () => {
  it("builds an element with attributes, text and children", () => {
    const child = el(document, "span", { text: "inner" });
    const node = el(document, "button", { class: "fbh-btn", id: "go", "aria-label": "Go" }, [child]);
    expect(node.outerHTML).toBe(
      '<button class="fbh-btn" id="go" aria-label="Go"><span>inner</span></button>',
    );
  });

  it("wires a listener and skips nothing-values", () => {
    const onClick = vi.fn();
    const node = el(document, "button", { onClick, title: null, disabled: false, hidden: true });
    node.dispatchEvent(new window.MouseEvent("click"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(node.hasAttribute("title")).toBe(false);
    expect(node.hasAttribute("disabled")).toBe(false);
    expect(node.hasAttribute("hidden")).toBe(true);
  });

  it("never interprets text as markup", () => {
    const node = el(document, "p", { text: "<img src=x onerror=alert(1)>" });
    expect(node.querySelector("img")).toBe(null);
    expect(node.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("clear", () => {
  it("empties a node", () => {
    const node = el(document, "div", {}, [el(document, "b", { text: "x" })]);
    clear(node);
    expect(node.childNodes).toHaveLength(0);
  });
});

describe("firstLine", () => {
  it("is the first line, cut", () => {
    expect(firstLine("one\ntwo", 20)).toBe("one");
    expect(firstLine("a".repeat(30), 10)).toBe(`${"a".repeat(10)}…`);
    expect(firstLine("   padded  ", 20)).toBe("padded");
    expect(firstLine(undefined, 20)).toBe("");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");
  it("reads as a person would say it", () => {
    expect(relativeTime("2026-09-21T11:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-09-21T11:45:00.000Z", now)).toBe("15 min ago");
    expect(relativeTime("2026-09-21T09:00:00.000Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-09-20T12:00:00.000Z", now)).toBe("1 day ago");
    expect(relativeTime("2026-09-18T12:00:00.000Z", now)).toBe("3 days ago");
    expect(relativeTime("2026-08-01T12:00:00.000Z", now)).toBe("2026-08-01");
    expect(relativeTime("not a date", now)).toBe("");
  });
});
```

- [ ] 2. Run `pnpm test` and watch it fail.

- [ ] 3. Create `src/panel/dom.js`:

```js
// The panel builds its DOM with these four helpers and never with innerHTML: a report's own text,
// a reporter's name and the AI's answer all end up on screen, and none of them may be parsed as
// markup. `text` always goes through textContent.
export function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function firstLine(text, max = 120) {
  const line = String(text || "").split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function relativeTime(iso, now = new Date()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(then).toISOString().slice(0, 10);
}
```

- [ ] 4. Run `pnpm test` and watch the dom tests pass.

- [ ] 5. Write `tests/screen-capture.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import { captureScreen, screenCaptureSupported } from "../src/capture/screen.js";
import { resetWarnings } from "../src/warn.js";

function fakeEnvironment({ getDisplayMedia, context = {} } = {}) {
  const stopped = [];
  const track = { getSettings: () => ({ width: 800, height: 600 }), stop: () => stopped.push("video") };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage, ...context }),
    toBlob: (cb) => cb(new Blob([new Uint8Array(3)], { type: "image/png" })),
  };
  const video = { play: async () => {}, pause: () => {}, srcObject: null, videoWidth: 0, videoHeight: 0 };
  const doc = { createElement: (tag) => (tag === "canvas" ? canvas : video) };
  const win = {
    navigator: {
      mediaDevices: { getDisplayMedia: getDisplayMedia || (async () => stream) },
    },
  };
  return { doc, win, canvas, drawImage, stopped };
}

describe("screenCaptureSupported", () => {
  it("is false without the API", () => {
    expect(screenCaptureSupported({ navigator: {} })).toBe(false);
    expect(screenCaptureSupported({ navigator: { mediaDevices: {} } })).toBe(false);
    expect(screenCaptureSupported({ navigator: { mediaDevices: { getDisplayMedia() {} } } })).toBe(true);
  });
});

describe("captureScreen", () => {
  it("draws one frame at the track's size, returns a PNG and stops the stream", async () => {
    const env = fakeEnvironment();
    const blob = await captureScreen({ doc: env.doc, win: env.win, frameWaitMs: 0 });
    expect(blob.type).toBe("image/png");
    expect(env.canvas.width).toBe(800);
    expect(env.canvas.height).toBe(600);
    expect(env.drawImage).toHaveBeenCalledTimes(1);
    expect(env.stopped).toEqual(["video"]);
  });

  it("is null when the reporter cancels the picker, and the warning is not repeated", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = fakeEnvironment({
      getDisplayMedia: async () => {
        throw new Error("Permission denied");
      },
    });
    expect(await captureScreen({ doc: env.doc, win: env.win, frameWaitMs: 0 })).toBe(null);
    expect(await captureScreen({ doc: env.doc, win: env.win, frameWaitMs: 0 })).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is null where the API does not exist", async () => {
    expect(await captureScreen({ doc: {}, win: { navigator: {} }, frameWaitMs: 0 })).toBe(null);
  });
});
```

- [ ] 6. Run `pnpm test` and watch it fail.

- [ ] 7. Create `src/capture/screen.js`:

```js
// "Capture screen" in the report form (spec §5.4): getDisplayMedia to a single still, never a
// video — the reporter picks a window or a screen, one frame is drawn to a canvas, and the tracks
// are stopped immediately so no sharing indicator lingers. The button is only shown where the API
// exists (spec §5.4), and a cancelled picker is an ordinary outcome, not an error.
import { warnOnce } from "../warn.js";

export const FRAME_WAIT_MS = 200;

export function screenCaptureSupported(win) {
  const media = win && win.navigator && win.navigator.mediaDevices;
  return !!(media && typeof media.getDisplayMedia === "function");
}

export async function captureScreen({ doc, win, frameWaitMs = FRAME_WAIT_MS } = {}) {
  if (!screenCaptureSupported(win)) return null;
  let stream = null;
  try {
    stream = await win.navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = doc.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // The first frame is not there the instant play() resolves.
    await new Promise((resolve) => setTimeout(resolve, frameWaitMs));

    const track = stream.getVideoTracks()[0];
    const settings = track && typeof track.getSettings === "function" ? track.getSettings() : {};
    const canvas = doc.createElement("canvas");
    canvas.width = settings.width || video.videoWidth || 0;
    canvas.height = settings.height || video.videoHeight || 0;
    const context = canvas.width && canvas.height ? canvas.getContext("2d") : null;
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    video.pause();
    video.srcObject = null;
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch (err) {
    warnOnce("screen capture", err);
    return null;
  } finally {
    if (stream) for (const track of stream.getTracks()) track.stop();
  }
}
```

- [ ] 8. Run `pnpm test` and watch the screen-capture tests pass.

- [ ] 9. Write `tests/form.test.js`:

```js
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createForm } from "../src/panel/form.js";
import { normalizeOptions } from "../src/options.js";

const png = (size = 4) => new Blob([new Uint8Array(size)], { type: "image/png" });

function setup({ options: extra = {}, api: apiOverrides = {}, captureScreen } = {}) {
  const options = normalizeOptions({
    hubUrl: "https://hub.example",
    app: "cad",
    getToken: async () => "t",
    section: () => "Mockups",
    sections: ["Rendering", "Mockups", "Catalog (SKU)", "General"],
    types: ["Bug", "Efficiency suggestion", "Question", "Other"],
    ...extra,
  });
  const api = {
    submit: vi.fn(async () => ({ id: "r1", dropped: [] })),
    captureScreenshot: vi.fn(async () => png()),
    options,
    ...apiOverrides,
  };
  const onSubmitted = vi.fn();
  const form = createForm({ api, options, doc: document, win: window, onSubmitted, captureScreen });
  document.body.appendChild(form.element);
  return { api, form, onSubmitted, options };
}

const $ = (selector) => document.querySelector(selector);

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("createForm", () => {
  it("offers the app's sections and types, with the current view selected", async () => {
    const { form } = setup();
    await form.prepare();
    expect([...$("#fbh-section").options].map((o) => o.value)).toEqual([
      "Rendering",
      "Mockups",
      "Catalog (SKU)",
      "General",
    ]);
    expect($("#fbh-section").value).toBe("Mockups");
    expect($("#fbh-type").value).toBe("Bug");
    form.destroy();
  });

  it("shows the automatic screenshot in the strip and lets it be removed", async () => {
    const { form, api } = setup();
    await form.prepare();
    expect(api.captureScreenshot).toHaveBeenCalledTimes(1);
    expect($(".fbh-strip").textContent).toContain("Screenshot");
    $(".fbh-strip button[data-remove]").click();
    expect($(".fbh-strip").textContent).not.toContain("Screenshot");
    expect($(".fbh-note").textContent).toBe(
      "What will be sent: a copy of the page, a recording of the last minute or two, the console and network log.",
    );
    form.destroy();
  });

  it("refuses an empty description without calling the hub", async () => {
    const { form, api } = setup();
    await form.prepare();
    $("#fbh-submit").click();
    await Promise.resolve();
    expect(api.submit).not.toHaveBeenCalled();
    expect($(".fbh-message").textContent).toBe("Add a description before sending.");
    form.destroy();
  });

  it("submits everything it holds, then clears", async () => {
    const { form, api, onSubmitted } = setup();
    await form.prepare();
    $("#fbh-text").value = "the popup does not open";
    $("#fbh-type").value = "Question";
    $("#fbh-no-replay").checked = true;
    $("#fbh-no-replay").dispatchEvent(new window.Event("change"));
    $("#fbh-submit").click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(api.submit.mock.calls[0][0]).toMatchObject({
      section: "Mockups",
      type: "Question",
      text: "the popup does not open",
      includeReplay: false,
    });
    expect(onSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", section: "Mockups", type: "Question" }),
    );
    expect($("#fbh-text").value).toBe("");
    form.destroy();
  });

  it("keeps everything and offers Retry when the hub refuses", async () => {
    const api = { submit: vi.fn(async () => {
      throw Object.assign(new Error("Your session expired; sign in again."), { status: 401 });
    }) };
    const { form } = setup({ api });
    await form.prepare();
    $("#fbh-text").value = "still here";
    $("#fbh-submit").click();
    await vi.waitFor(() => expect($(".fbh-message").textContent).toBe("Your session expired; sign in again."));
    expect($("#fbh-text").value).toBe("still here");
    expect($("#fbh-retry")).not.toBe(null);
    $("#fbh-retry").click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
    form.destroy();
  });

  it("says what was left out when the hub took the report but the bundle was trimmed", async () => {
    const api = { submit: vi.fn(async () => ({ id: "r2", dropped: ["the recording (the bundle was too big)"] })) };
    const { form } = setup({ api });
    await form.prepare();
    $("#fbh-text").value = "big one";
    $("#fbh-submit").click();
    await vi.waitFor(() =>
      expect($(".fbh-message").textContent).toBe("Sent. Left out: the recording (the bundle was too big)."),
    );
    form.destroy();
  });

  it("takes a pasted image and refuses one that is not PNG or JPEG", async () => {
    const { form } = setup();
    await form.prepare();
    const paste = new window.Event("paste");
    paste.clipboardData = {
      items: [
        { kind: "file", type: "image/png", getAsFile: () => png() },
        { kind: "file", type: "image/gif", getAsFile: () => new Blob([new Uint8Array(2)], { type: "image/gif" }) },
      ],
    };
    document.dispatchEvent(paste);
    await vi.waitFor(() => expect($(".fbh-strip").textContent).toContain("Image 1"));
    expect($(".fbh-strip").textContent).not.toContain("Image 2");
    expect($(".fbh-message").textContent).toBe("Only PNG and JPEG images can be attached.");
    form.destroy();
  });

  it("stops at six images", async () => {
    const { form } = setup();
    await form.prepare();
    for (let i = 0; i < 7; i += 1) form.addImage(png(), `shot-${i}.png`);
    expect($(".fbh-strip").querySelectorAll("[data-image]")).toHaveLength(6);
    expect($(".fbh-message").textContent).toBe("Six images is the most that can go with a report.");
    form.destroy();
  });

  it("refuses an image over five megabytes", async () => {
    const { form } = setup();
    await form.prepare();
    form.addImage({ size: 6 * 1024 * 1024, type: "image/png" }, "huge.png");
    expect($(".fbh-strip").querySelectorAll("[data-image]")).toHaveLength(0);
    expect($(".fbh-message").textContent).toBe("That image is over 5 MB.");
    form.destroy();
  });

  it("hides Capture screen where the browser has no getDisplayMedia, and uses it where it has", async () => {
    const { form } = setup();
    await form.prepare();
    expect($("#fbh-capture")).toBe(null);
    form.destroy();

    document.body.innerHTML = "";
    const captureScreen = vi.fn(async () => png(9));
    const withApi = setup({
      captureScreen,
      options: {},
    });
    withApi.form.element.ownerDocument.defaultView.navigator.mediaDevices = { getDisplayMedia() {} };
    await withApi.form.prepare();
    expect($("#fbh-capture")).not.toBe(null);
    $("#fbh-capture").click();
    await vi.waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    expect($(".fbh-strip").textContent).toContain("Image 1");
    withApi.form.destroy();
    delete window.navigator.mediaDevices;
  });

  it("stops listening for pastes once released", async () => {
    const { form } = setup();
    await form.prepare();
    form.release();
    const paste = new window.Event("paste");
    paste.clipboardData = { items: [{ kind: "file", type: "image/png", getAsFile: () => png() }] };
    document.dispatchEvent(paste);
    expect($(".fbh-strip").textContent).not.toContain("Image 1");
    form.destroy();
  });
});
```

- [ ] 10. Run `pnpm test` and watch it fail.

- [ ] 11. Create `src/panel/form.js`:

```js
// The report form (spec §5.4): the two dropdowns, the description, the attachment strip and
// Submit. The strip holds the automatic screenshot — taken when the panel opens, before the
// overlay is shown, so the reporter sees the page they are reporting on and not this form — plus
// anything pasted, attached or captured. Everything is optional and removable: the reporter sees
// what is going before it goes (spec §5.7).
import { CAPS, describeAttachments } from "../bundle.js";
import { captureScreen as defaultCaptureScreen, screenCaptureSupported } from "../capture/screen.js";
import { defaultSection } from "../options.js";
import { clear, el } from "./dom.js";

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg"];

export function createForm({
  api,
  options,
  doc,
  win = doc.defaultView,
  onSubmitted = () => {},
  captureScreen = defaultCaptureScreen,
}) {
  let screenshot = null;
  let includeReplay = true;
  let busy = false;
  let pasting = false;
  const images = [];
  const urls = [];

  const sectionSelect = el(doc, "select", { id: "fbh-section", class: "fbh-input" });
  const typeSelect = el(doc, "select", { id: "fbh-type", class: "fbh-input" });
  const textarea = el(doc, "textarea", {
    id: "fbh-text",
    class: "fbh-input fbh-textarea",
    rows: "4",
    maxlength: String(CAPS.text),
    placeholder: "What happened, and what did you expect?",
  });
  const strip = el(doc, "div", { class: "fbh-strip" });
  const note = el(doc, "p", { class: "fbh-note" });
  const message = el(doc, "p", { class: "fbh-message", role: "status", "aria-live": "polite" });
  const fileInput = el(doc, "input", {
    id: "fbh-file",
    type: "file",
    accept: ACCEPTED_IMAGE_TYPES.join(","),
    multiple: true,
    class: "fbh-hidden-file",
    onChange: onFilesPicked,
  });
  const attachButton = el(doc, "button", {
    id: "fbh-attach",
    type: "button",
    class: "fbh-ghost",
    text: "Attach image",
    onClick: () => fileInput.click(),
  });
  const actions = el(doc, "div", { class: "fbh-actions" }, [attachButton, fileInput]);
  const replayToggle = el(doc, "input", {
    id: "fbh-no-replay",
    type: "checkbox",
    onChange: () => {
      includeReplay = !replayToggle.checked;
      renderNote();
    },
  });
  const submitButton = el(doc, "button", {
    id: "fbh-submit",
    type: "button",
    class: "fbh-primary",
    text: "Send report",
    onClick: () => {
      send();
    },
  });

  const element = el(doc, "section", { class: "fbh-form" }, [
    el(doc, "div", { class: "fbh-fields" }, [
      el(doc, "label", { class: "fbh-field" }, [
        el(doc, "span", { class: "fbh-label", text: "Section" }),
        sectionSelect,
      ]),
      el(doc, "label", { class: "fbh-field" }, [
        el(doc, "span", { class: "fbh-label", text: "Type" }),
        typeSelect,
      ]),
    ]),
    el(doc, "label", { class: "fbh-field" }, [
      el(doc, "span", { class: "fbh-label", text: "What happened" }),
      textarea,
    ]),
    strip,
    actions,
    note,
    el(doc, "label", { class: "fbh-check" }, [
      replayToggle,
      el(doc, "span", { text: "Leave the recording out" }),
    ]),
    message,
    el(doc, "div", { class: "fbh-submit-row" }, [submitButton]),
  ]);

  function fill(select, values, chosen) {
    clear(select);
    for (const value of values) {
      select.appendChild(el(doc, "option", { value, text: value, selected: value === chosen }));
    }
    select.value = chosen;
  }

  function say(text) {
    message.textContent = text;
  }

  function objectUrl(blob) {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return "";
    try {
      const url = URL.createObjectURL(blob);
      urls.push(url);
      return url;
    } catch {
      return "";
    }
  }

  function releaseUrls() {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      for (const url of urls) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // nothing to do
        }
      }
    }
    urls.length = 0;
  }

  function renderNote() {
    note.textContent = describeAttachments({
      screenshot,
      dom: true,
      replay: includeReplay && options.capture.replay ? true : null,
      images,
    });
  }

  function thumbnail(blob, label, onRemove, extra = {}) {
    const url = objectUrl(blob);
    const preview = url
      ? el(doc, "img", { class: "fbh-thumb-img", src: url, alt: label })
      : el(doc, "span", { class: "fbh-thumb-img", text: label });
    return el(doc, "figure", { class: "fbh-thumb", ...extra }, [
      preview,
      el(doc, "figcaption", { text: label }),
      el(doc, "button", {
        type: "button",
        class: "fbh-thumb-remove",
        "data-remove": true,
        "aria-label": `Remove ${label}`,
        text: "✕",
        onClick: onRemove,
      }),
    ]);
  }

  function renderStrip() {
    clear(strip);
    if (screenshot) {
      strip.appendChild(
        thumbnail(screenshot, "Screenshot", () => {
          screenshot = null;
          renderStrip();
        }),
      );
    }
    images.forEach((entry, index) => {
      strip.appendChild(
        thumbnail(
          entry.blob,
          `Image ${index + 1}`,
          () => {
            images.splice(index, 1);
            renderStrip();
          },
          { "data-image": entry.id },
        ),
      );
    });
    renderNote();
  }

  function addImage(blob, name = "image.png") {
    if (!blob || !ACCEPTED_IMAGE_TYPES.includes(blob.type)) {
      say("Only PNG and JPEG images can be attached.");
      return false;
    }
    if (blob.size > CAPS.image) {
      say("That image is over 5 MB.");
      return false;
    }
    if (images.length >= CAPS.images) {
      say("Six images is the most that can go with a report.");
      return false;
    }
    images.push({ id: `${Date.now()}-${images.length}`, blob, name });
    renderStrip();
    return true;
  }

  function replaceImage(id, blob) {
    const entry = images.find((one) => one.id === id);
    if (!entry) return;
    entry.blob = blob;
    renderStrip();
  }

  function onFilesPicked() {
    for (const file of fileInput.files || []) addImage(file, file.name);
    fileInput.value = "";
  }

  function onPaste(event) {
    const data = event.clipboardData;
    if (!data || !data.items) return;
    for (const item of data.items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile ? item.getAsFile() : null;
      if (file) addImage(file, file.name || "pasted.png");
    }
  }

  function setBusy(value) {
    busy = value;
    submitButton.disabled = value;
    submitButton.textContent = value ? "Sending…" : "Send report";
  }

  function showRetry() {
    // The form lives in a shadow root when the built-in panel hosts it, so doc.getElementById
    // would never find these: look inside our own subtree.
    if (message.querySelector("#fbh-retry")) return;
    message.appendChild(
      el(doc, "button", {
        id: "fbh-retry",
        type: "button",
        class: "fbh-ghost fbh-inline",
        text: "Retry",
        onClick: () => {
          send();
        },
      }),
    );
  }

  async function send() {
    if (busy) return;
    const text = textarea.value.trim();
    if (!text) {
      say("Add a description before sending.");
      textarea.focus();
      return;
    }
    setBusy(true);
    say("Sending…");
    const fields = {
      section: sectionSelect.value,
      type: typeSelect.value,
      text,
      images: images.map((one) => one.blob),
      includeReplay,
      screenshot,
    };
    try {
      const result = await api.submit(fields);
      const sent = { id: result.id, section: fields.section, type: fields.type, text, at: new Date().toISOString() };
      reset();
      say(result.dropped && result.dropped.length ? `Sent. Left out: ${result.dropped.join(", ")}.` : "Sent.");
      onSubmitted(sent);
    } catch (err) {
      say(err && err.message ? err.message : "Couldn't send, retry.");
      showRetry();
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    textarea.value = "";
    images.length = 0;
    screenshot = null;
    releaseUrls();
    renderStrip();
  }

  async function prepare() {
    say("");
    fill(sectionSelect, options.sections, defaultSection(options.sections, options.section()));
    fill(typeSelect, options.types, options.types[0]);
    includeReplay = true;
    replayToggle.checked = false;
    if (screenCaptureSupported(win) && !element.querySelector("#fbh-capture")) {
      actions.insertBefore(
        el(doc, "button", {
          id: "fbh-capture",
          type: "button",
          class: "fbh-ghost",
          text: "Capture screen",
          onClick: async () => {
            const blob = await captureScreen({ doc, win });
            if (blob) addImage(blob, "capture.png");
          },
        }),
        fileInput,
      );
    }
    renderStrip();
    doc.addEventListener("paste", onPaste);
    pasting = true;
    if (options.capture.screenshot && !screenshot) {
      screenshot = await api.captureScreenshot();
      renderStrip();
    }
  }

  function release() {
    if (!pasting) return;
    doc.removeEventListener("paste", onPaste);
    pasting = false;
  }

  function destroy() {
    release();
    releaseUrls();
    element.remove();
  }

  return { element, prepare, release, destroy, addImage, replaceImage, focus: () => textarea.focus() };
}
```

- [ ] 12. Run `pnpm test` (all green), `pnpm lint`, `pnpm format`.

- [ ] 13. Commit:

```
git add -A && git commit -m "feat(panel): the report form, its attachments and the screen capture

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: The red-pen annotator

**Files:**
- Create: `src/panel/annotate.js`
- Modify: `src/panel/form.js` (a Draw button on every thumbnail)
- Test: `tests/annotate.test.js`, `tests/form.test.js` (one case added)

**Interfaces:**
- Consumes: `el`, `clear` from `src/panel/dom.js`; `warnOnce`.
- Produces `src/panel/annotate.js`: `PEN_COLOR = "#e5484d"`, `penWidth(imageWidth): number`, `createStrokes(): Strokes`, `drawStrokes(ctx, strokes, width): void`, `pointFrom(event, canvas): { x, y }`, `loadImageBlob(doc, blob): Promise<{ element, width, height, revoke }>`, `flattenAnnotation({ doc, image, strokes, makeCanvas? }): Promise<Blob>`, `openAnnotator({ doc, blob, mount, onSave, onClose?, loadImage?, makeCanvas? }): Promise<{ element, close() }>`.
  `Strokes` is `{ begin(point), extend(point), end(), undo(), clear(), toArray(), length, isDrawing() }`.

**Steps:**

- [ ] 1. Write `tests/annotate.test.js`:

```js
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  PEN_COLOR,
  createStrokes,
  drawStrokes,
  flattenAnnotation,
  openAnnotator,
  penWidth,
  pointFrom,
} from "../src/panel/annotate.js";

function fakeContext() {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    set lineWidth(value) {
      calls.push(["lineWidth", value]);
    },
    set strokeStyle(value) {
      calls.push(["strokeStyle", value]);
    },
    set lineCap(value) {
      calls.push(["lineCap", value]);
    },
    set lineJoin(value) {
      calls.push(["lineJoin", value]);
    },
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    stroke: record("stroke"),
    drawImage: record("drawImage"),
  };
}

function fakeCanvas(context = fakeContext()) {
  return {
    width: 0,
    height: 0,
    context,
    style: {},
    listeners: {},
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 300 }),
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    removeEventListener(type) {
      delete this.listeners[type];
    },
    toBlob: (cb) => cb(new Blob([new Uint8Array(7)], { type: "image/png" })),
  };
}

describe("createStrokes", () => {
  it("collects a stroke, turns a single tap into a dot and undoes one at a time", () => {
    const strokes = createStrokes();
    strokes.begin({ x: 1, y: 1 });
    strokes.extend({ x: 5, y: 5 });
    strokes.end();
    strokes.begin({ x: 9, y: 9 });
    strokes.end();
    expect(strokes.toArray()).toEqual([
      { color: PEN_COLOR, points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] },
      { color: PEN_COLOR, points: [{ x: 9, y: 9 }, { x: 9, y: 9 }] },
    ]);
    strokes.undo();
    expect(strokes.length).toBe(1);
    strokes.clear();
    expect(strokes.length).toBe(0);
    expect(strokes.isDrawing()).toBe(false);
  });

  it("ignores movement before the pen went down", () => {
    const strokes = createStrokes();
    strokes.extend({ x: 1, y: 1 });
    expect(strokes.length).toBe(0);
  });
});

describe("penWidth", () => {
  it("scales with the image and never goes under two pixels", () => {
    expect(penWidth(300)).toBe(2);
    expect(penWidth(1800)).toBe(6);
  });
});

describe("drawStrokes", () => {
  it("draws every stroke in the pen's colour", () => {
    const context = fakeContext();
    drawStrokes(context, [{ color: PEN_COLOR, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }], 4);
    expect(context.calls).toEqual([
      ["lineCap", "round"],
      ["lineJoin", "round"],
      ["lineWidth", 4],
      ["strokeStyle", PEN_COLOR],
      ["beginPath"],
      ["moveTo", 1, 2],
      ["lineTo", 3, 4],
      ["stroke"],
    ]);
  });
});

describe("pointFrom", () => {
  it("turns a client position into image pixels", () => {
    const canvas = fakeCanvas();
    canvas.width = 800;
    canvas.height = 600;
    expect(pointFrom({ clientX: 210, clientY: 170 }, canvas)).toEqual({ x: 400, y: 300 });
  });
});

describe("flattenAnnotation", () => {
  it("draws the image first, then the strokes, at the image's own size", async () => {
    const context = fakeContext();
    const canvas = fakeCanvas(context);
    const image = { element: { tag: "img" }, width: 1200, height: 800 };
    const strokes = [{ color: PEN_COLOR, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }];
    const blob = await flattenAnnotation({ doc: document, image, strokes, makeCanvas: () => canvas });
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(800);
    expect(context.calls[0]).toEqual(["drawImage", image.element, 0, 0, 1200, 800]);
    expect(context.calls.some(([name, value]) => name === "lineWidth" && value === 4)).toBe(true);
    expect(blob.type).toBe("image/png");
  });
});

describe("openAnnotator", () => {
  async function open({ onSave = vi.fn() } = {}) {
    const canvas = fakeCanvas();
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const image = { element: { tag: "img" }, width: 800, height: 600, revoke: vi.fn() };
    const annotator = await openAnnotator({
      doc: document,
      blob: new Blob([new Uint8Array(3)], { type: "image/png" }),
      mount,
      onSave,
      loadImage: async () => image,
      makeCanvas: () => canvas,
    });
    return { annotator, canvas, mount, onSave, image };
  }

  it("shows the image on a canvas with Undo, Clear, Cancel and Save", async () => {
    const { mount, canvas } = await open();
    expect(mount.querySelector("[data-undo]")).not.toBe(null);
    expect(mount.querySelector("[data-clear]")).not.toBe(null);
    expect(mount.querySelector("[data-cancel]")).not.toBe(null);
    expect(mount.querySelector("[data-save]")).not.toBe(null);
    expect(canvas.width).toBe(800);
    expect(canvas.context.calls[0][0]).toBe("drawImage");
  });

  it("draws while the pointer is down and saves a flattened PNG", async () => {
    const { annotator, canvas, mount, onSave } = await open();
    canvas.listeners.pointerdown({ clientX: 10, clientY: 20, preventDefault() {} });
    document.dispatchEvent(Object.assign(new window.Event("pointermove"), { clientX: 210, clientY: 170 }));
    document.dispatchEvent(new window.Event("pointerup"));
    mount.querySelector("[data-save]").click();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].type).toBe("image/png");
    annotator.close();
    expect(mount.querySelector(".fbh-annotator")).toBe(null);
  });

  it("undoes and clears without saving, and cancels without calling onSave", async () => {
    const { annotator, canvas, mount, onSave } = await open();
    canvas.listeners.pointerdown({ clientX: 10, clientY: 20, preventDefault() {} });
    document.dispatchEvent(new window.Event("pointerup"));
    mount.querySelector("[data-undo]").click();
    mount.querySelector("[data-clear]").click();
    mount.querySelector("[data-cancel]").click();
    expect(onSave).not.toHaveBeenCalled();
    expect(mount.querySelector(".fbh-annotator")).toBe(null);
    annotator.close();
  });
});
```

- [ ] 2. Run `pnpm test` and watch it fail.

- [ ] 3. Create `src/panel/annotate.js`:

```js
// The red pen (spec §5.4, ported in spirit from the FWD dashboard's _fbAnnotate): draw on any
// attached image, undo, clear, and flatten at the image's own resolution so the arrow the
// reporter drew lands on the same pixel the triage run looks at. The canvas on screen may be
// scaled down to fit the panel; pointFrom converts every position back to image pixels, so the
// strokes are resolution-independent.
import { clear, el } from "./dom.js";
import { warnOnce } from "../warn.js";

export const PEN_COLOR = "#e5484d";

export function penWidth(imageWidth) {
  return Math.max(2, Math.round(imageWidth / 300));
}

export function createStrokes() {
  const strokes = [];
  let active = null;
  return {
    begin(point) {
      active = { color: PEN_COLOR, points: [point] };
      strokes.push(active);
    },
    extend(point) {
      if (active) active.points.push(point);
    },
    end() {
      // A tap with no movement is a dot: two identical points and a round cap.
      if (active && active.points.length === 1) active.points.push({ ...active.points[0] });
      active = null;
    },
    undo() {
      strokes.pop();
      active = null;
    },
    clear() {
      strokes.length = 0;
      active = null;
    },
    toArray() {
      return strokes.map((stroke) => ({ color: stroke.color, points: stroke.points.slice() }));
    },
    get length() {
      return strokes.length;
    },
    isDrawing() {
      return active !== null;
    },
  };
}

export function drawStrokes(ctx, strokes, width) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    ctx.strokeStyle = stroke.color;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
}

export function pointFrom(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width ? canvas.width / rect.width : 1;
  const scaleY = rect.height ? canvas.height / rect.height : 1;
  return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
}

export function loadImageBlob(doc, blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const element = doc.createElement("img");
    element.onload = () =>
      resolve({
        element,
        width: element.naturalWidth,
        height: element.naturalHeight,
        revoke: () => URL.revokeObjectURL(url),
      });
    element.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("the image could not be read"));
    };
    element.src = url;
  });
}

export async function flattenAnnotation({ doc, image, strokes, makeCanvas = (d) => d.createElement("canvas") }) {
  const canvas = makeCanvas(doc);
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image.element, 0, 0, image.width, image.height);
  drawStrokes(ctx, strokes, penWidth(image.width));
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export async function openAnnotator({
  doc,
  blob,
  mount,
  onSave,
  onClose = () => {},
  loadImage = (d, b) => loadImageBlob(d, b),
  makeCanvas = (d) => d.createElement("canvas"),
}) {
  let image;
  try {
    image = await loadImage(doc, blob);
  } catch (err) {
    warnOnce("annotator", err);
    return { element: null, close() {} };
  }

  const strokes = createStrokes();
  const canvas = makeCanvas(doc);
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.className = "fbh-annotator-canvas";
  const ctx = canvas.getContext("2d");

  function redraw() {
    ctx.drawImage(image.element, 0, 0, image.width, image.height);
    drawStrokes(ctx, strokes.toArray(), penWidth(image.width));
  }

  function onDown(event) {
    if (event.preventDefault) event.preventDefault();
    strokes.begin(pointFrom(event, canvas));
    redraw();
  }
  function onMove(event) {
    if (!strokes.isDrawing()) return;
    strokes.extend(pointFrom(event, canvas));
    redraw();
  }
  function onUp() {
    if (!strokes.isDrawing()) return;
    strokes.end();
    redraw();
  }

  canvas.addEventListener("pointerdown", onDown);
  doc.addEventListener("pointermove", onMove);
  doc.addEventListener("pointerup", onUp);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    canvas.removeEventListener("pointerdown", onDown);
    doc.removeEventListener("pointermove", onMove);
    doc.removeEventListener("pointerup", onUp);
    if (image.revoke) image.revoke();
    if (element.parentNode) element.parentNode.removeChild(element);
    onClose();
  }

  const element = el(doc, "div", { class: "fbh-annotator", role: "dialog", "aria-label": "Draw on the image" }, [
    el(doc, "div", { class: "fbh-annotator-stage" }, [canvas]),
    el(doc, "div", { class: "fbh-annotator-actions" }, [
      el(doc, "button", {
        type: "button",
        class: "fbh-ghost",
        "data-undo": true,
        text: "Undo",
        onClick: () => {
          strokes.undo();
          redraw();
        },
      }),
      el(doc, "button", {
        type: "button",
        class: "fbh-ghost",
        "data-clear": true,
        text: "Clear",
        onClick: () => {
          strokes.clear();
          redraw();
        },
      }),
      el(doc, "button", { type: "button", class: "fbh-ghost", "data-cancel": true, text: "Cancel", onClick: close }),
      el(doc, "button", {
        type: "button",
        class: "fbh-primary",
        "data-save": true,
        text: "Save",
        onClick: async () => {
          const flattened = await flattenAnnotation({ doc, image, strokes: strokes.toArray(), makeCanvas });
          if (flattened) onSave(flattened);
          close();
        },
      }),
    ]),
  ]);

  clear(mount);
  mount.appendChild(element);
  redraw();
  return { element, close };
}
```

- [ ] 4. Run `pnpm test` and watch the annotator tests pass.

- [ ] 5. Add the Draw button to the form. In `src/panel/form.js`, add the import:

```js
import { openAnnotator } from "./annotate.js";
```

replace the whole `thumbnail` function with:

```js
  function thumbnail(blob, label, onRemove, onDraw, extra = {}) {
    const url = objectUrl(blob);
    const preview = url
      ? el(doc, "img", { class: "fbh-thumb-img", src: url, alt: label })
      : el(doc, "span", { class: "fbh-thumb-img", text: label });
    return el(doc, "figure", { class: "fbh-thumb", ...extra }, [
      preview,
      el(doc, "figcaption", { text: label }),
      el(doc, "button", {
        type: "button",
        class: "fbh-thumb-draw",
        "data-draw": true,
        "aria-label": `Draw on ${label}`,
        text: "✎",
        onClick: () => onDraw(blob),
      }),
      el(doc, "button", {
        type: "button",
        class: "fbh-thumb-remove",
        "data-remove": true,
        "aria-label": `Remove ${label}`,
        text: "✕",
        onClick: onRemove,
      }),
    ]);
  }
```

replace the whole `renderStrip` function with:

```js
  function renderStrip() {
    clear(strip);
    if (screenshot) {
      strip.appendChild(
        thumbnail(
          screenshot,
          "Screenshot",
          () => {
            screenshot = null;
            renderStrip();
          },
          (blob) =>
            annotate(blob, (flattened) => {
              screenshot = flattened;
              renderStrip();
            }),
        ),
      );
    }
    images.forEach((entry, index) => {
      strip.appendChild(
        thumbnail(
          entry.blob,
          `Image ${index + 1}`,
          () => {
            images.splice(index, 1);
            renderStrip();
          },
          (blob) => annotate(blob, (flattened) => replaceImage(entry.id, flattened)),
          { "data-image": entry.id },
        ),
      );
    });
    renderNote();
  }

  // The editor takes over the form area while it is open: one image, one pen, and no way to
  // submit half-way through an annotation. `onClose` fires for Save, for Cancel and for a failure
  // to read the image, so there is one place that puts the form back.
  async function annotate(blob, onDone) {
    annotatorMount.hidden = false;
    element.classList.add("fbh-form-annotating");
    const stop = () => {
      annotatorMount.hidden = true;
      element.classList.remove("fbh-form-annotating");
    };
    const annotator = await openAnnotator({
      doc,
      blob,
      mount: annotatorMount,
      onSave: (flattened) => onDone(flattened),
      onClose: stop,
    });
    if (!annotator.element) {
      stop();
      say("That image could not be opened for drawing.");
    }
  }
```

add the mount element next to `strip` — declare it beside the other element constants:

```js
  const annotatorMount = el(doc, "div", { class: "fbh-annotator-mount", hidden: true });
```

and insert it into the form's children list, immediately after `strip`:

```js
    strip,
    annotatorMount,
    actions,
```

- [ ] 6. Add this case to `tests/form.test.js`:

```js
  it("opens the pen on a thumbnail and keeps what it saves", async () => {
    const { form } = setup();
    await form.prepare();
    expect($(".fbh-strip button[data-draw]")).not.toBe(null);
    form.addImage(png(), "one.png");
    $(".fbh-strip [data-image] button[data-draw]").click();
    await vi.waitFor(() => expect($(".fbh-annotator-mount").hidden).toBe(false));
    form.destroy();
  });
```

- [ ] 7. Run `pnpm test`. The new case exercises the real `openAnnotator`, whose `loadImageBlob` needs `URL.createObjectURL` and an `<img>` that fires `load` — neither works in jsdom, so the annotator returns `{ element: null }` and the form says so. Assert what actually happens: if the case fails, change its last two lines to

```js
    await vi.waitFor(() => expect($(".fbh-message").textContent).toBe("That image could not be opened for drawing."));
```

and keep the earlier assertion that the Draw button exists. The drawing itself is covered by `tests/annotate.test.js` with an injected image, and end to end by the Playwright run in Task 14.

- [ ] 8. Run `pnpm test` (all green), `pnpm lint`, `pnpm format`.

- [ ] 9. Commit:

```
git add -A && git commit -m "feat(panel): the red-pen annotator on any attached image

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: "My reports" — the list, its statuses, replies and Retry

**Files:**
- Create: `src/panel/list.js`
- Test: `tests/list.test.js`

**Interfaces:**
- Consumes: `el`, `clear`, `firstLine`, `relativeTime` from `src/panel/dom.js`; `statusLabel`, `statusTone`, `isRetryable`, `needsReply`, `labelContext` from `src/status.js`; `CAPS` from `src/bundle.js`; the internal api (`list`, `reply`, `retry`, `markRead`).
- Produces `src/panel/list.js`: `POLL_MS = 30000`, `renderRow(doc, item, handlers, { me, now }): Element`, `createList({ api, options, doc, now? }): { element, refresh(): Promise<void>, addOptimistic(seed): void, start(): void, stop(): void, destroy(): void }`.

**Steps:**

- [ ] 1. Write `tests/list.test.js`:

```js
/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_MS, createList, renderRow } from "../src/panel/list.js";
import { normalizeOptions } from "../src/options.js";
import { labelContext, statusLabel } from "../src/status.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/status-cases.json", import.meta.url), "utf8"));
const now = () => new Date("2026-09-21T12:00:00.000Z");

const options = normalizeOptions({
  hubUrl: "https://hub.example",
  app: "cad",
  getToken: async () => "t",
  user: () => ({ id: "me", name: "Dana", role: "admin" }),
});

function item(over = {}) {
  return {
    id: "r1",
    at: "2026-09-21T11:45:00.000Z",
    section: "Rendering",
    type: "Bug",
    text: "The ring popup does not open\nafter I saved a shape edit.",
    reporter: { id: "me", name: "Dana" },
    status: "triaging",
    label: "Received, being looked at",
    verdict: null,
    replies: [],
    ...over,
  };
}

function setup(apiOverrides = {}) {
  const api = {
    list: vi.fn(async () => ({ items: [item()], nextCursor: null })),
    reply: vi.fn(async () => ({ replies: [{ at: "t", by: "me", text: "more" }], status: "triaging", label: "Received, being looked at" })),
    retry: vi.fn(async () => ({ id: "r1", status: "triaging", label: "Received, being looked at" })),
    markRead: vi.fn(),
    ...apiOverrides,
  };
  const list = createList({ api, options, doc: document, now });
  document.body.appendChild(list.element);
  return { api, list };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("renderRow", () => {
  it("shows the tags, the first line, when it came in and the hub's label", () => {
    const row = renderRow(document, item(), {}, { me: "me", now: now() });
    expect(row.querySelector(".fbh-tag").textContent).toBe("Rendering");
    expect(row.querySelector(".fbh-tag-type").textContent).toBe("Bug");
    expect(row.querySelector(".fbh-row-text").textContent).toBe("The ring popup does not open");
    expect(row.querySelector(".fbh-when").textContent).toBe("15 min ago");
    expect(row.querySelector(".fbh-pill").textContent).toBe("Received, being looked at");
  });

  it("labels every case in the shared fixture exactly as the hub does", () => {
    for (const one of fixture.cases) {
      const ctx = labelContext({ verdict: one.input.verdict, original: one.input.original });
      const row = renderRow(
        document,
        item({ id: one.name, status: one.status, label: statusLabel(one.status, ctx), verdict: one.input.verdict }),
        {},
        { me: "me", now: now() },
      );
      expect(`${one.name}: ${row.querySelector(".fbh-pill").textContent}`).toBe(`${one.name}: ${one.label}`);
    }
  });

  it("falls back to its own label when the hub sent none (an optimistic row)", () => {
    const row = renderRow(document, item({ label: undefined }), {}, { me: "me", now: now() });
    expect(row.querySelector(".fbh-pill").textContent).toBe("Received, being looked at");
  });

  it("shows the answer, the questions with a reply box, and the reason", () => {
    const answered = renderRow(
      document,
      item({ status: "answered", label: "Answered", verdict: { verdict: "answered", answer: "Click Export images.", receivedAt: "t" } }),
      {},
      { me: "me", now: now() },
    );
    expect(answered.querySelector(".fbh-answer").textContent).toBe("Click Export images.");

    const asked = renderRow(
      document,
      item({ status: "needs_reply", label: "Needs your reply", verdict: { verdict: "needs_info", questions: ["Which SKU?", "Which browser?"], receivedAt: "t" } }),
      {},
      { me: "me", now: now() },
    );
    expect([...asked.querySelectorAll(".fbh-questions li")].map((li) => li.textContent)).toEqual([
      "Which SKU?",
      "Which browser?",
    ]);
    expect(asked.querySelector("[data-reply]")).not.toBe(null);

    const refused = renderRow(
      document,
      item({ status: "not_filed", label: "Not filed", verdict: { verdict: "unusable", reason: "There is no description.", receivedAt: "t" } }),
      {},
      { me: "me", now: now() },
    );
    expect(refused.querySelector(".fbh-reason").textContent).toBe("There is no description.");
  });

  it("links the issue and the pull request, and shows the fix's progress note", () => {
    const row = renderRow(
      document,
      item({
        status: "in_progress",
        label: "Fix in progress",
        verdict: { verdict: "filed", issueNumber: 7, receivedAt: "t" },
        issue: { number: 7, url: "https://github.com/a/b/issues/7", state: "open" },
        pullRequest: { number: 9, url: "https://github.com/a/b/pull/9", state: "open", merged: false },
        progress: "Reproduced it; the id is null after the save.",
      }),
      {},
      { me: "me", now: now() },
    );
    expect(row.querySelector("a[data-issue]").href).toBe("https://github.com/a/b/issues/7");
    expect(row.querySelector("a[data-issue]").textContent).toBe("Issue #7");
    expect(row.querySelector("a[data-pr]").textContent).toBe("Pull request #9");
    expect(row.querySelector(".fbh-progress").textContent).toBe("Reproduced it; the id is null after the save.");
  });

  it("offers Retry only where the hub would accept one", () => {
    for (const status of ["waiting", "error"]) {
      const row = renderRow(document, item({ status, label: "x" }), {}, { me: "me", now: now() });
      expect(row.querySelector("[data-retry]")).not.toBe(null);
    }
    for (const status of ["triaging", "filed", "fixed", "answered"]) {
      const row = renderRow(document, item({ status, label: "x" }), {}, { me: "me", now: now() });
      expect(row.querySelector("[data-retry]")).toBe(null);
    }
  });

  it("names someone else's reporter, and not your own", () => {
    const mine = renderRow(document, item(), {}, { me: "me", now: now() });
    expect(mine.querySelector(".fbh-who")).toBe(null);
    const theirs = renderRow(document, item({ reporter: { id: "other", name: "Sam" } }), {}, { me: "me", now: now() });
    expect(theirs.querySelector(".fbh-who").textContent).toBe("Sam");
  });

  it("shows the replies already on the report", () => {
    const row = renderRow(
      document,
      item({ replies: [{ at: "2026-09-21T11:50:00.000Z", by: "me", text: "It is the batch view." }] }),
      {},
      { me: "me", now: now() },
    );
    expect(row.querySelector(".fbh-replies li").textContent).toContain("It is the batch view.");
  });
});

describe("createList", () => {
  it("fetches on refresh, renders and marks what was read", async () => {
    const { list, api } = setup();
    await list.refresh();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(".fbh-row")).toHaveLength(1);
    expect(api.markRead).toHaveBeenCalledTimes(1);
    list.destroy();
  });

  it("says so when there is nothing yet", async () => {
    const { list } = setup({ list: async () => ({ items: [], nextCursor: null }) });
    await list.refresh();
    expect(document.querySelector(".fbh-empty").textContent).toBe("Nothing yet. Your reports will show up here.");
    list.destroy();
  });

  it("shows why the list could not be fetched", async () => {
    const { list } = setup({
      list: async () => {
        throw new Error("Couldn't send, retry.");
      },
    });
    await list.refresh();
    expect(document.querySelector(".fbh-empty").textContent).toBe("Couldn't send, retry.");
    list.destroy();
  });

  it("puts a new report at the top as Received, being looked at", async () => {
    const { list } = setup();
    await list.refresh();
    list.addOptimistic({ id: "new", section: "General", type: "Question", text: "just sent", at: "2026-09-21T11:59:50.000Z" });
    const first = document.querySelector(".fbh-row");
    expect(first.dataset.id).toBe("new");
    expect(first.querySelector(".fbh-pill").textContent).toBe("Received, being looked at");
    list.destroy();
  });

  it("sends a reply and takes the hub's new status", async () => {
    const { list, api } = setup({
      list: async () => ({
        items: [item({ status: "needs_reply", label: "Needs your reply", verdict: { verdict: "needs_info", questions: ["Which SKU?"], receivedAt: "t" } })],
        nextCursor: null,
      }),
    });
    await list.refresh();
    document.querySelector("[data-reply]").value = "SKU 12";
    document.querySelector("[data-send]").click();
    await vi.waitFor(() => expect(api.reply).toHaveBeenCalledWith("r1", "SKU 12"));
    await vi.waitFor(() => expect(document.querySelector(".fbh-pill").textContent).toBe("Received, being looked at"));
    list.destroy();
  });

  it("retries a report the hub can still retry", async () => {
    const { list, api } = setup({
      list: async () => ({ items: [item({ status: "error", label: "Could not triage" })], nextCursor: null }),
    });
    await list.refresh();
    document.querySelector("[data-retry]").click();
    await vi.waitFor(() => expect(api.retry).toHaveBeenCalledWith("r1"));
    await vi.waitFor(() => expect(document.querySelector(".fbh-pill").textContent).toBe("Received, being looked at"));
    list.destroy();
  });

  it("shows what the hub said when a reply is refused", async () => {
    const { list } = setup({
      list: async () => ({
        items: [item({ status: "needs_reply", label: "Needs your reply", verdict: { verdict: "needs_info", questions: ["?"], receivedAt: "t" } })],
        nextCursor: null,
      }),
      reply: async () => {
        throw new Error("This report has all the replies it can take.");
      },
    });
    await list.refresh();
    document.querySelector("[data-reply]").value = "more";
    document.querySelector("[data-send]").click();
    await vi.waitFor(() =>
      expect(document.querySelector(".fbh-row-message").textContent).toBe("This report has all the replies it can take."),
    );
    list.destroy();
  });

  it("polls every thirty seconds between start and stop", async () => {
    vi.useFakeTimers();
    const { list, api } = setup();
    list.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(api.list).toHaveBeenCalledTimes(2);
    list.stop();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(api.list).toHaveBeenCalledTimes(2);
    list.destroy();
  });
});
```

- [ ] 2. Run `pnpm test` and watch it fail.

- [ ] 3. Create `src/panel/list.js`:

```js
// "My reports" (spec §5.4): everyone's for an admin, the reporter's own otherwise — the hub
// decides which, from the token. Each row shows the hub's own label, never one computed here: the
// hub already ran the status rules against GitHub (service/src/listing.ts). The local statusLabel
// is the fallback for the row added the moment a report is sent, when all the hub has said is an
// id.
import { CAPS } from "../bundle.js";
import { isRetryable, labelContext, needsReply, statusLabel, statusTone } from "../status.js";
import { clear, el, firstLine, relativeTime } from "./dom.js";

export const POLL_MS = 30000;

function labelFor(item) {
  if (item.label) return item.label;
  return statusLabel(item.status, labelContext({ verdict: item.verdict }));
}

export function renderRow(doc, item, handlers = {}, { me = null, now = new Date() } = {}) {
  const verdict = item.verdict || {};
  const message = el(doc, "p", { class: "fbh-row-message", role: "status", "aria-live": "polite" });
  const row = el(doc, "li", {
    class: "fbh-row",
    "data-id": item.id,
    "data-status": item.status,
  });

  const head = el(doc, "div", { class: "fbh-row-head" }, [
    el(doc, "span", { class: "fbh-tag", text: item.section || "General" }),
    el(doc, "span", { class: "fbh-tag fbh-tag-type", text: item.type || "Other" }),
    item.reporter && item.reporter.name && item.reporter.id !== me
      ? el(doc, "span", { class: "fbh-who", text: item.reporter.name })
      : null,
    el(doc, "time", { class: "fbh-when", datetime: item.at, text: relativeTime(item.at, now) }),
    el(doc, "span", { class: `fbh-pill fbh-pill-${statusTone(item.status)}`, text: labelFor(item) }),
  ]);
  row.appendChild(head);
  row.appendChild(el(doc, "p", { class: "fbh-row-text", text: firstLine(item.text) }));

  if (item.status === "answered" && verdict.answer) {
    row.appendChild(el(doc, "p", { class: "fbh-answer", text: verdict.answer }));
  }

  if (item.status === "not_filed" && verdict.reason) {
    row.appendChild(el(doc, "p", { class: "fbh-reason", text: verdict.reason }));
  }

  if (item.progress) {
    row.appendChild(el(doc, "p", { class: "fbh-progress", text: item.progress }));
  }

  const links = [];
  if (item.issue) {
    links.push(
      el(doc, "a", {
        class: "fbh-link",
        "data-issue": true,
        href: item.issue.url,
        target: "_blank",
        rel: "noreferrer noopener",
        text: `Issue #${item.issue.number}`,
      }),
    );
  }
  if (item.duplicateOf) {
    links.push(
      el(doc, "a", {
        class: "fbh-link",
        "data-duplicate": true,
        href: item.duplicateOf.url,
        target: "_blank",
        rel: "noreferrer noopener",
        text: `Issue #${item.duplicateOf.number}`,
      }),
    );
  }
  if (item.pullRequest) {
    links.push(
      el(doc, "a", {
        class: "fbh-link",
        "data-pr": true,
        href: item.pullRequest.url,
        target: "_blank",
        rel: "noreferrer noopener",
        text: `Pull request #${item.pullRequest.number}`,
      }),
    );
  }
  if (links.length) row.appendChild(el(doc, "p", { class: "fbh-links" }, links));

  if (item.replies && item.replies.length) {
    row.appendChild(
      el(
        doc,
        "ul",
        { class: "fbh-replies" },
        item.replies.map((reply) =>
          el(doc, "li", { text: `${reply.text} · ${relativeTime(reply.at, now)}` }),
        ),
      ),
    );
  }

  if (needsReply(item.status)) {
    const questions = Array.isArray(verdict.questions) ? verdict.questions : [];
    if (questions.length) {
      row.appendChild(
        el(doc, "ul", { class: "fbh-questions" }, questions.map((q) => el(doc, "li", { text: q }))),
      );
    }
    const box = el(doc, "textarea", {
      class: "fbh-input fbh-reply",
      "data-reply": true,
      rows: "2",
      maxlength: String(CAPS.reply),
      placeholder: "Answer here",
      "aria-label": "Your reply",
    });
    const send = el(doc, "button", {
      type: "button",
      class: "fbh-primary fbh-inline",
      "data-send": true,
      text: "Send reply",
      onClick: () => {
        if (handlers.onReply) handlers.onReply(item.id, box.value, message);
      },
    });
    row.appendChild(el(doc, "div", { class: "fbh-reply-row" }, [box, send]));
  }

  if (isRetryable(item.status)) {
    row.appendChild(
      el(doc, "button", {
        type: "button",
        class: "fbh-ghost fbh-inline",
        "data-retry": true,
        text: "Retry",
        onClick: () => {
          if (handlers.onRetry) handlers.onRetry(item.id, message);
        },
      }),
    );
  }

  row.appendChild(message);
  return row;
}

export function createList({ api, options, doc, now = () => new Date() }) {
  const listEl = el(doc, "ul", { class: "fbh-list" });
  const empty = el(doc, "p", { class: "fbh-empty", text: "Nothing yet. Your reports will show up here." });
  const element = el(doc, "section", { class: "fbh-reports" }, [
    el(doc, "h3", { class: "fbh-subhead", text: "My reports" }),
    empty,
    listEl,
  ]);

  let items = [];
  let timer = null;

  function me() {
    const user = options.user();
    return user && user.id ? user.id : null;
  }

  function render() {
    clear(listEl);
    empty.hidden = items.length > 0;
    const handlers = { onReply, onRetry };
    const context = { me: me(), now: now() };
    for (const item of items) listEl.appendChild(renderRow(doc, item, handlers, context));
  }

  function replaceItem(id, patch) {
    items = items.map((one) => (one.id === id ? { ...one, ...patch } : one));
    render();
  }

  async function onReply(id, text, message) {
    message.textContent = "Sending…";
    try {
      const answer = await api.reply(id, text);
      replaceItem(id, {
        status: answer.status,
        label: answer.label,
        replies: Array.isArray(answer.replies) ? answer.replies : [],
      });
    } catch (err) {
      message.textContent = err && err.message ? err.message : "Couldn't send, retry.";
    }
  }

  async function onRetry(id, message) {
    message.textContent = "Retrying…";
    try {
      const answer = await api.retry(id);
      replaceItem(id, { status: answer.status, label: answer.label });
    } catch (err) {
      message.textContent = err && err.message ? err.message : "Couldn't send, retry.";
    }
  }

  async function refresh() {
    try {
      const page = await api.list();
      items = page.items;
      render();
      api.markRead(items);
    } catch (err) {
      if (!items.length) {
        empty.hidden = false;
        empty.textContent = err && err.message ? err.message : "Couldn't send, retry.";
      }
    }
  }

  // The row the reporter sees the instant a report is sent: the hub's 202 carries only an id, and
  // the next poll replaces this with the real thing.
  function addOptimistic(seed) {
    items = [
      {
        id: seed.id,
        at: seed.at || new Date().toISOString(),
        section: seed.section,
        type: seed.type,
        text: seed.text,
        reporter: { id: me(), name: "" },
        status: "triaging",
        label: statusLabel("triaging", {}),
        verdict: null,
        replies: [],
      },
      ...items,
    ];
    render();
  }

  function start() {
    stop();
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }

  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function destroy() {
    stop();
    element.remove();
  }

  return { element, refresh, addOptimistic, start, stop, destroy };
}
```

- [ ] 4. Run `pnpm test` (all green), `pnpm lint`, `pnpm format`.

- [ ] 5. Commit:

```
git add -A && git commit -m "feat(panel): My reports, its statuses, replies and Retry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: The panel shell — Shadow DOM, theming, focus trap

**Files:**
- Create: `src/panel/styles.js`, `src/panel/panel.js`
- Modify: `src/mount.js` (the built-in panel becomes the default factory)
- Test: `tests/panel.test.js`

**Interfaces:**
- Consumes: `createForm` from `src/panel/form.js`; `createList` from `src/panel/list.js`; `el` from `src/panel/dom.js`.
- Produces:
  - `src/panel/styles.js`: `PANEL_CSS: string`, `THEME_PROPERTIES: string[]` (the thirteen custom properties).
  - `src/panel/panel.js`: `HOST_ID = "fbh-host"`, `FOCUSABLE: string`, `createPanel({ api, options, doc }): { open(): void, close(): void, destroy(): void, host: Element, isOpen(): boolean }`.
  - `src/mount.js`: `defaultPanelFactory` is now `createPanel`, so `mountFeedback(...).open()` shows the built-in panel.

**Steps:**

- [ ] 1. Write `tests/panel.test.js`:

```js
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_ID, createPanel } from "../src/panel/panel.js";
import { THEME_PROPERTIES } from "../src/panel/styles.js";
import { normalizeOptions } from "../src/options.js";

function setup({ theme = () => "light" } = {}) {
  const api = {
    submit: vi.fn(async () => ({ id: "r1", dropped: [] })),
    captureScreenshot: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    reply: vi.fn(),
    retry: vi.fn(),
    markRead: vi.fn(),
  };
  const options = normalizeOptions({
    hubUrl: "https://hub.example",
    app: "cad",
    getToken: async () => "t",
    sections: ["Rendering", "General"],
    types: ["Bug", "Question"],
    theme,
    capture: { screenshot: false, replay: false },
  });
  const panel = createPanel({ api, options, doc: document });
  return { api, panel };
}

const shadow = () => document.getElementById(HOST_ID).shadowRoot;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("createPanel", () => {
  it("puts one host with a shadow root on the page, closed", () => {
    const { panel } = setup();
    const host = document.getElementById(HOST_ID);
    expect(host).not.toBe(null);
    expect(host.shadowRoot).not.toBe(null);
    expect(shadow().querySelector(".fbh-overlay").hidden).toBe(true);
    expect(panel.isOpen()).toBe(false);
    panel.destroy();
    expect(document.getElementById(HOST_ID)).toBe(null);
  });

  it("carries the thirteen theming properties and a dark block", () => {
    const { panel } = setup();
    const css = shadow().querySelector("style").textContent;
    for (const property of THEME_PROPERTIES) expect(css).toContain(`${property}:`);
    expect(THEME_PROPERTIES).toHaveLength(13);
    expect(css).toContain(':host([data-theme="dark"])');
    panel.destroy();
  });

  it("is a modal dialog with a label, and opens with the app's theme", () => {
    const { panel } = setup({ theme: () => "dark" });
    panel.open();
    const overlay = shadow().querySelector(".fbh-overlay");
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    expect(overlay.getAttribute("aria-labelledby")).toBe("fbh-title");
    expect(shadow().getElementById("fbh-title").textContent).toBe("Report an issue or suggestion");
    expect(document.getElementById(HOST_ID).dataset.theme).toBe("dark");
    expect(overlay.hidden).toBe(false);
    panel.destroy();
  });

  it("starts and stops the list polling with the panel", () => {
    const { panel, api } = setup();
    panel.open();
    expect(api.list).toHaveBeenCalledTimes(1);
    panel.close();
    expect(panel.isOpen()).toBe(false);
    panel.destroy();
  });

  it("closes on Escape, on the close button and on the backdrop, and gives focus back", () => {
    document.body.innerHTML = `<button id="opener"></button>`;
    const opener = document.getElementById("opener");
    const { panel } = setup();
    opener.focus();
    panel.open();
    shadow().querySelector(".fbh-overlay").dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(panel.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);

    panel.open();
    shadow().querySelector(".fbh-close").click();
    expect(panel.isOpen()).toBe(false);

    panel.open();
    shadow().querySelector(".fbh-overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(panel.isOpen()).toBe(false);
    panel.destroy();
  });

  it("keeps Tab inside the panel", () => {
    const { panel } = setup();
    panel.open();
    const root = shadow();
    const focusable = [...root.querySelectorAll("button, select, textarea, input, a[href]")].filter(
      (node) => !node.hidden,
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    const forward = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    root.querySelector(".fbh-overlay").dispatchEvent(forward);
    expect(root.activeElement).toBe(first);

    const backward = new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    root.querySelector(".fbh-overlay").dispatchEvent(backward);
    expect(root.activeElement).toBe(last);
    panel.destroy();
  });
});
```

- [ ] 2. Run `pnpm test` and watch it fail.

- [ ] 3. Create `src/panel/styles.js`:

```js
// The panel's whole stylesheet. It lives in the shadow root, so nothing here can reach the app
// and nothing in the app can reach the panel (spec §5.4). Colour comes from thirteen custom
// properties with light and dark defaults; an app maps its own tokens onto `#fbh-host` from its
// own stylesheet, and an id selector from outside beats `:host` from inside, which is what makes
// that mapping work (spec §5.6).
export const THEME_PROPERTIES = [
  "--fbh-bg",
  "--fbh-panel",
  "--fbh-text",
  "--fbh-muted",
  "--fbh-hairline",
  "--fbh-border",
  "--fbh-accent",
  "--fbh-accent-on",
  "--fbh-danger",
  "--fbh-success",
  "--fbh-tag-bg",
  "--fbh-tag-text",
  "--fbh-font",
];

export const PANEL_CSS = `
:host {
  --fbh-bg: #ffffff;
  --fbh-panel: #ffffff;
  --fbh-text: #1b1b1f;
  --fbh-muted: #6b7280;
  --fbh-hairline: #ececf1;
  --fbh-border: #d7d7de;
  --fbh-accent: #111827;
  --fbh-accent-on: #ffffff;
  --fbh-danger: #c0392b;
  --fbh-success: #12805c;
  --fbh-tag-bg: #f1f1f5;
  --fbh-tag-text: #45454f;
  --fbh-font: system-ui, -apple-system, "Segoe UI", sans-serif;
  all: initial;
}
:host([data-theme="dark"]) {
  --fbh-bg: #17171b;
  --fbh-panel: #1f1f25;
  --fbh-text: #f2f2f5;
  --fbh-muted: #a0a0ab;
  --fbh-hairline: #2b2b33;
  --fbh-border: #3a3a44;
  --fbh-accent: #e8e8ee;
  --fbh-accent-on: #17171b;
  --fbh-danger: #ff6b5e;
  --fbh-success: #46c79a;
  --fbh-tag-bg: #2b2b33;
  --fbh-tag-text: #d7d7de;
}
.fbh-overlay {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: flex-end; justify-content: flex-end;
  background: rgba(0, 0, 0, 0.42);
  font-family: var(--fbh-font); color: var(--fbh-text);
  font-size: 13px; line-height: 1.45;
}
.fbh-overlay[hidden] { display: none; }
.fbh-panel {
  width: min(460px, 100vw); max-height: 88vh; background: var(--fbh-panel);
  border: 1px solid var(--fbh-border); border-radius: 14px 14px 0 0;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.25);
}
@media (min-width: 520px) {
  .fbh-overlay { align-items: center; justify-content: center; }
  .fbh-panel { border-radius: 14px; margin: 20px; }
}
.fbh-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid var(--fbh-hairline);
}
.fbh-title { margin: 0; font-size: 15px; font-weight: 600; }
.fbh-close {
  background: none; border: 0; font-size: 18px; line-height: 1; cursor: pointer; color: var(--fbh-muted);
}
.fbh-body { padding: 14px 16px; overflow-y: auto; }
.fbh-form { display: grid; gap: 9px; padding-bottom: 12px; border-bottom: 1px dashed var(--fbh-hairline); }
.fbh-fields { display: flex; gap: 9px; }
.fbh-fields > * { flex: 1; }
.fbh-field { display: block; }
.fbh-label { display: block; margin-bottom: 3px; font-size: 11px; font-weight: 600; color: var(--fbh-muted); }
.fbh-input {
  width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit; font-size: 13px;
  color: var(--fbh-text); background: var(--fbh-bg);
  border: 1px solid var(--fbh-border); border-radius: 8px;
}
.fbh-textarea { min-height: 64px; resize: vertical; }
.fbh-strip { display: flex; flex-wrap: wrap; gap: 8px; }
.fbh-strip:empty { display: none; }
.fbh-thumb {
  position: relative; margin: 0; width: 84px; font-size: 10.5px; color: var(--fbh-muted); text-align: center;
}
.fbh-thumb-img {
  display: block; width: 84px; height: 56px; object-fit: cover;
  border: 1px solid var(--fbh-border); border-radius: 6px; background: var(--fbh-tag-bg);
}
.fbh-thumb-remove, .fbh-thumb-draw {
  position: absolute; top: 2px; border: 0; border-radius: 50%; width: 18px; height: 18px;
  cursor: pointer; font-size: 10px; line-height: 1; color: var(--fbh-accent-on); background: var(--fbh-accent);
}
.fbh-thumb-remove { right: 2px; }
.fbh-thumb-draw { right: 24px; }
.fbh-annotator-mount[hidden] { display: none; }
.fbh-annotator-stage { max-height: 40vh; overflow: auto; }
.fbh-annotator-canvas { max-width: 100%; height: auto; cursor: crosshair; touch-action: none; }
.fbh-annotator-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
.fbh-form-annotating .fbh-strip, .fbh-form-annotating .fbh-submit-row { opacity: 0.4; pointer-events: none; }
.fbh-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.fbh-hidden-file { display: none; }
.fbh-note, .fbh-message, .fbh-row-message { margin: 0; font-size: 11.5px; color: var(--fbh-muted); }
.fbh-message:empty, .fbh-row-message:empty { display: none; }
.fbh-check { display: flex; gap: 6px; align-items: center; font-size: 11.5px; color: var(--fbh-muted); }
.fbh-submit-row { display: flex; justify-content: flex-end; }
.fbh-primary {
  padding: 8px 16px; border: 0; border-radius: 8px; cursor: pointer; font: inherit; font-weight: 600;
  background: var(--fbh-accent); color: var(--fbh-accent-on);
}
.fbh-primary[disabled] { opacity: 0.6; cursor: default; }
.fbh-ghost {
  padding: 6px 10px; border: 1px solid var(--fbh-border); border-radius: 7px; cursor: pointer;
  font: inherit; font-size: 11.5px; font-weight: 600; background: none; color: var(--fbh-text);
}
.fbh-inline { margin-left: 6px; }
.fbh-reports { padding-top: 12px; }
.fbh-subhead { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--fbh-muted); }
.fbh-empty { margin: 0; padding: 14px 0; text-align: center; font-size: 12.5px; color: var(--fbh-muted); }
.fbh-empty[hidden] { display: none; }
.fbh-list { list-style: none; margin: 0; padding: 0; }
.fbh-row { padding: 10px 0; border-bottom: 1px solid var(--fbh-hairline); }
.fbh-row:last-child { border-bottom: 0; }
.fbh-row-head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
.fbh-tag {
  padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600;
  background: var(--fbh-tag-bg); color: var(--fbh-tag-text);
}
.fbh-who { font-size: 10.5px; color: var(--fbh-muted); }
.fbh-when { font-size: 10.5px; color: var(--fbh-muted); }
.fbh-pill {
  margin-left: auto; padding: 2px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 700;
  background: var(--fbh-tag-bg); color: var(--fbh-tag-text);
}
.fbh-pill-info { background: var(--fbh-tag-bg); color: var(--fbh-tag-text); }
.fbh-pill-open { background: var(--fbh-accent); color: var(--fbh-accent-on); }
.fbh-pill-done { background: var(--fbh-success); color: var(--fbh-accent-on); }
.fbh-pill-attention { background: var(--fbh-danger); color: #ffffff; }
.fbh-pill-bad { background: var(--fbh-danger); color: #ffffff; }
.fbh-pill-muted { background: var(--fbh-tag-bg); color: var(--fbh-muted); }
.fbh-row-text { margin: 0; white-space: pre-wrap; word-break: break-word; }
.fbh-answer, .fbh-reason, .fbh-progress { margin: 6px 0 0; font-size: 12.5px; color: var(--fbh-muted); }
.fbh-answer { color: var(--fbh-text); }
.fbh-questions, .fbh-replies { margin: 6px 0 0; padding-left: 18px; font-size: 12.5px; color: var(--fbh-muted); }
.fbh-links { display: flex; gap: 10px; margin: 6px 0 0; }
.fbh-link { font-size: 11.5px; font-weight: 600; color: var(--fbh-accent); }
:host([data-theme="dark"]) .fbh-link { color: var(--fbh-text); }
.fbh-reply-row { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; }
.fbh-reply { min-height: 38px; }
`;
```

- [ ] 4. Create `src/panel/panel.js`:

```js
// The panel (spec §5.4): one host element on the page, a shadow root so neither stylesheet can
// reach the other, and inside it the report form above "My reports". It is a modal dialog — a
// focus trap, Escape, a click on the backdrop, and focus handed back to whatever opened it.
// The panel is a consumer of the same headless API an app could use on its own (spec §5.4).
import { el } from "./dom.js";
import { createForm } from "./form.js";
import { createList } from "./list.js";
import { PANEL_CSS } from "./styles.js";

export const HOST_ID = "fbh-host";
export const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function createPanel({ api, options, doc }) {
  const win = doc.defaultView;
  const host = doc.createElement("div");
  host.id = HOST_ID;
  host.dataset.theme = "light";
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);

  const list = createList({ api, options, doc });
  const form = createForm({
    api,
    options,
    doc,
    win,
    onSubmitted: (sent) => list.addOptimistic(sent),
  });

  const closeButton = el(doc, "button", {
    type: "button",
    class: "fbh-close",
    "aria-label": "Close",
    text: "✕",
    onClick: () => close(),
  });
  const overlay = el(
    doc,
    "div",
    {
      class: "fbh-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "fbh-title",
      hidden: true,
      onKeydown: onKeydown,
      onClick: (event) => {
        if (event.target === overlay) close();
      },
    },
    [
      el(doc, "div", { class: "fbh-panel" }, [
        el(doc, "header", { class: "fbh-head" }, [
          el(doc, "h2", { class: "fbh-title", id: "fbh-title", text: "Report an issue or suggestion" }),
          closeButton,
        ]),
        el(doc, "div", { class: "fbh-body" }, [form.element, list.element]),
      ]),
    ],
  );
  shadow.appendChild(overlay);
  doc.body.appendChild(host);

  let open_ = false;
  let lastFocus = null;

  function focusable() {
    // No visibility test: jsdom has no layout, and everything inside the overlay is visible
    // whenever the overlay itself is.
    return [...shadow.querySelectorAll(FOCUSABLE)].filter((node) => !node.hidden);
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable();
    if (!items.length) return;
    const index = items.indexOf(shadow.activeElement);
    if (event.shiftKey && index <= 0) {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (!event.shiftKey && index === items.length - 1) {
      event.preventDefault();
      items[0].focus();
    }
  }

  function open() {
    if (open_) return;
    open_ = true;
    lastFocus = doc.activeElement;
    host.dataset.theme = options.theme() === "dark" ? "dark" : "light";
    overlay.hidden = false;
    form.prepare().catch(() => {});
    list.start();
    const items = focusable();
    if (items.length) items[0].focus();
  }

  function close() {
    if (!open_) return;
    open_ = false;
    overlay.hidden = true;
    form.release();
    list.stop();
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function destroy() {
    close();
    form.destroy();
    list.destroy();
    host.remove();
  }

  return { open, close, destroy, host, isOpen: () => open_ };
}
```

- [ ] 5. In `src/mount.js`, replace

```js
// Task 13 sets this to the built-in panel; until then a mount without its own `createPanel` is
// headless and `open()` says so once.
const defaultPanelFactory = null;
```

with

```js
// An app that wants its own UI passes `deps.createPanel` (spec §5.4, "Headless use"); everyone
// else gets the built-in panel.
const defaultPanelFactory = createPanel;
```

and add the import, in its alphabetical place among the other imports:

```js
import { createPanel } from "./panel/panel.js";
```

- [ ] 6. Add this case to the end of `tests/mount.test.js`:

```js
describe("open", () => {
  it("shows the built-in panel and takes it away again on destroy", () => {
    const { handle } = mount();
    handle.open();
    const host = document.getElementById("fbh-host");
    expect(host).not.toBe(null);
    expect(host.shadowRoot.querySelector(".fbh-overlay").hidden).toBe(false);
    handle.close();
    expect(host.shadowRoot.querySelector(".fbh-overlay").hidden).toBe(true);
    handle.destroy();
    expect(document.getElementById("fbh-host")).toBe(null);
  });

  it("opens from the app's own button", () => {
    document.body.innerHTML = `<button id="topbar-issues"></button>`;
    const { handle } = mount({ button: "#topbar-issues" });
    expect(document.getElementById("topbar-issues").hidden).toBe(false);
    document.getElementById("topbar-issues").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("fbh-host").shadowRoot.querySelector(".fbh-overlay").hidden).toBe(false);
    handle.destroy();
  });
});
```

- [ ] 7. Run `pnpm test` (all green), `pnpm lint`, `pnpm format`.

- [ ] 8. Commit:

```
git add -A && git commit -m "feat(panel): the Shadow-DOM shell, its theming and its focus trap

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: The demo page, the stub hub, the browser test, the size budget and the v0.1.0 release

**Files:**
- Create: `tests/stub-hub.mjs`, `demo/index.html`, `demo/demo.js`, `playwright.config.js`, `e2e/panel.spec.js`, `tools/size.mjs`, `types/index.d.ts`, `CHANGELOG.md`
- Modify: `package.json` (the `size` script, the `types` export, `esbuild`), `.github/workflows/ci.yml` (the `e2e` job), `README.md`
- Test: `tests/size.test.js`, `e2e/panel.spec.js`

**Interfaces:**
- Consumes: `mountFeedback` from `src/index.js`; `fixtures/status-cases.json`.
- Produces: `tools/size.mjs` exporting `measure(): Promise<{ raw: number, gzipped: number }>`; the stub hub's routes `POST /v1/reports`, `GET /v1/reports`, `POST /v1/reports/:id/replies`, `POST /v1/reports/:id/retry`, `GET /_stub/last`, `GET /livez` and static files; `types/index.d.ts` declaring `MountOptions`, `CaptureOptions`, `MountDeps`, `ReportFields`, `ReportSummary`, `Status`, `FeedbackHandle`, `mountFeedback`, `statusLabel`.

**Steps:**

- [ ] 1. Create `tests/stub-hub.mjs`:

```js
// A stand-in for feedback-hub, for the demo page and the Playwright run (spec §5.9). It answers
// the four client routes with the shapes service/src/routes.ts answers, canned: every status in
// the shared fixture is in the listing, so the panel's rendering of all eleven is exercised in a
// real browser. It also serves the repository's files, so the demo page has a real origin — and
// it is reached on 127.0.0.1 while the page is on localhost, which makes every call in the test a
// genuine cross-origin request with a preflight, as it will be in production.
import { createServer } from "node:http";
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
};

const fixture = JSON.parse(await readFile(new URL("../fixtures/status-cases.json", import.meta.url), "utf8"));
const canned = fixture.cases.map((one, index) => ({
  id: `fx-${index}`,
  at: new Date(Date.parse("2026-09-21T11:00:00.000Z") + index * 60000).toISOString(),
  section: "Rendering",
  type: "Bug",
  text: one.name,
  reporter: { id: "demo", name: "Dana" },
  status: one.status,
  label: one.label,
  verdict: one.input.verdict ? { ...one.input.verdict, receivedAt: "2026-09-21T11:30:00.000Z" } : null,
  replies: [],
}));

const submitted = [];
let last = null;

function cors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function serveFile(res, pathname) {
  const target = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, { "Content-Type": TYPES[extname(target)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = createServer(async (req, res) => {
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
  if (url.pathname === "/_stub/last") {
    json(res, 200, last || {});
    return;
  }

  if (url.pathname === "/v1/reports" && req.method === "POST") {
    const form = await new Response(Readable.toWeb(req), {
      headers: { "content-type": req.headers["content-type"] || "" },
    }).formData();
    const report = JSON.parse(await form.get("report").text());
    const parts = {};
    for (const [name, value] of form.entries()) {
      parts[name] = (parts[name] || 0) + (typeof value === "string" ? value.length : value.size);
    }
    last = { report, parts: Object.keys(parts).sort(), sizes: parts };
    const id = `sub-${submitted.length + 1}`;
    submitted.unshift({
      id,
      at: new Date().toISOString(),
      section: report.section,
      type: report.type,
      text: report.text,
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
    const body = JSON.parse(await new Response(Readable.toWeb(req)).text() || "{}");
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
});

server.listen(PORT, () => {
  console.log(`stub hub on http://localhost:${PORT} (demo at /demo/index.html)`);
});
```

- [ ] 2. Create `demo/index.html`:

```html
<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>feedback-client demo</title>
    <style>
      :root { --bg: #fff; --text: #1b1b1f; }
      html[data-theme="dark"] { --bg: #111114; --text: #f2f2f5; }
      body { margin: 0; padding: 24px; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--text); }
      /* How an app maps its own tokens onto the panel (spec §5.6). */
      #fbh-host { --fbh-bg: var(--bg); --fbh-text: var(--text); --fbh-font: system-ui, sans-serif; }
      button { font: inherit; padding: 6px 12px; }
      .secret { color: #b00; }
    </style>
  </head>
  <body>
    <h1>feedback-client demo</h1>
    <p>A page to drive the panel by hand and in Playwright. It talks to the stub hub, never a real one.</p>
    <p>
      <button id="open-feedback" type="button">Report an issue</button>
      <span id="dot" aria-label="reports needing attention">0</span>
      <button id="toggle-theme" type="button">Toggle theme</button>
      <button id="toggle-signin" type="button">Sign out</button>
    </p>
    <form>
      <label>Ring name <input id="ring-name" value="Solitaire" /></label>
      <label>Password <input id="secret" type="password" value="hunter2" /></label>
      <p class="secret">£4,200</p>
    </form>
    <script type="module" src="./demo.js"></script>
  </body>
</html>
```

- [ ] 3. Create `demo/demo.js`:

```js
// The demo harness. `?fake=1` (the default) injects stand-ins for the two lazy dependencies:
// without a bundler a browser cannot resolve the bare specifiers `@rrweb/record` and
// `modern-screenshot`, and the point of this page is to exercise the panel, the bundle and the
// transport end to end rather than those two libraries. `?fake=0` uses the real dynamic imports
// and is for driving the page through a bundler by hand.
import { mountFeedback } from "../src/index.js";

const params = new URLSearchParams(location.search);
const hubUrl = params.get("hub") || `${location.protocol}//127.0.0.1:${location.port}`;
const useFakes = params.get("fake") !== "0";
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
let signedIn = true;

async function makePng(width, height, color) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

const fakes = {
  loadScreenshot: async () => ({ domToBlob: async () => makePng(320, 200, "#8ec5ff") }),
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
    user: () => ({ id: "demo", name: "Dana", email: "dana@example.com", role: "admin" }),
    section: () => "Rendering",
    sections: ["Rendering", "Mockups", "Catalog (SKU)", "General"],
    types: ["Bug", "Efficiency suggestion", "Question", "Other"],
    button: "#open-feedback",
    theme: () => document.documentElement.dataset.theme,
    onSummary: ({ attention }) => {
      document.getElementById("dot").textContent = String(attention);
    },
    capture: { replay: true, screenshot: true, console: true, network: true, maskAllInputs: false, blank: [".secret"] },
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

window.feedback = feedback;
console.log("demo ready");
```

- [ ] 4. Create `playwright.config.js`:

```js
import { defineConfig } from "@playwright/test";

// One chromium project against the stub hub (spec §5.9). The page is served from localhost and
// the hub addressed as 127.0.0.1 — the same process, two origins, so every call is a real
// cross-origin request with a preflight.
const PORT = Number(process.env.STUB_PORT || 8787);

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/stub-hub.mjs",
    url: `http://localhost:${PORT}/livez`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
```

- [ ] 5. Create `e2e/panel.spec.js`:

```js
import { expect, test } from "@playwright/test";

const PORT = Number(process.env.STUB_PORT || 8787);
const HUB = `http://127.0.0.1:${PORT}`;
const demo = (theme) => `/demo/index.html?hub=${encodeURIComponent(HUB)}&theme=${theme}`;

function watchConsole(page) {
  const noise = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") noise.push(message.text());
  });
  page.on("pageerror", (error) => noise.push(String(error)));
  return noise;
}

for (const theme of ["light", "dark"]) {
  test(`submits a report and shows it as received (${theme})`, async ({ page }) => {
    const noise = watchConsole(page);
    await page.goto(demo(theme));
    await page.click("#open-feedback");

    await expect(page.locator(".fbh-panel")).toBeVisible();
    await expect(page.locator(".fbh-thumb figcaption").first()).toHaveText("Screenshot");
    await page.selectOption("#fbh-type", "Question");
    await page.fill("#fbh-text", "e2e smoke report");
    await page.click("#fbh-submit");

    await expect(page.locator(".fbh-row").first()).toContainText("e2e smoke report");
    await expect(page.locator(".fbh-row").first().locator(".fbh-pill")).toHaveText(
      "Received, being looked at",
    );

    const bundle = await page.evaluate(async (hub) => (await fetch(`${hub}/_stub/last`)).json(), HUB);
    expect(bundle.parts.sort()).toEqual(["dom", "replay", "report", "screenshot"]);
    expect(bundle.report.client).toMatch(/^feedback-client\//);
    expect(bundle.report.app).toBe("cad");
    expect(bundle.report.type).toBe("Question");
    expect(bundle.report.page.theme).toBe(theme);
    expect(bundle.report.capture).toEqual({ replay: true, screenshot: true, maskAllInputs: false });
    expect(bundle.report.breadcrumbs.some((one) => one.kind === "click")).toBe(true);
    expect(JSON.stringify(bundle.report)).not.toContain("hunter2");

    expect(noise).toEqual([]);
  });
}

test("leaves the recording out when asked", async ({ page }) => {
  await page.goto(demo("light"));
  await page.click("#open-feedback");
  await page.check("#fbh-no-replay");
  await page.fill("#fbh-text", "no recording please");
  await page.click("#fbh-submit");
  await expect(page.locator(".fbh-row").first()).toContainText("no recording please");
  const bundle = await page.evaluate(async (hub) => (await fetch(`${hub}/_stub/last`)).json(), HUB);
  expect(bundle.parts).not.toContain("replay");
  expect(bundle.report.capture.replay).toBe(false);
});

test("shows every status the hub can send", async ({ page }) => {
  const noise = watchConsole(page);
  await page.goto(demo("light"));
  await page.click("#open-feedback");
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
    "Needs your reply",
    "Not filed",
    "Could not triage",
  ]) {
    await expect(page.locator(".fbh-pill", { hasText: label }).first()).toBeVisible();
  }
  await expect(page.locator("[data-reply]")).toHaveCount(1);
  await expect(page.locator("[data-retry]")).toHaveCount(5); // two `waiting` and three `error` cases
  expect(noise).toEqual([]);
});

test("closes on Escape and hides the panel", async ({ page }) => {
  await page.goto(demo("light"));
  await page.click("#open-feedback");
  await expect(page.locator(".fbh-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".fbh-panel")).toBeHidden();
});

test("says to sign in when there is no session", async ({ page }) => {
  await page.goto(demo("light"));
  await page.click("#toggle-signin");
  await page.click("#open-feedback");
  await page.fill("#fbh-text", "signed out");
  await page.click("#fbh-submit");
  await expect(page.locator(".fbh-message")).toHaveText("Sign in to report");
});
```

- [ ] 6. Run `pnpm install` (Playwright is already a devDependency), then `npx playwright install --with-deps chromium`, then `pnpm test:e2e`. Fix what the run finds — the three likely differences from the unit tests are the panel's visibility assertions (the overlay is `hidden`, which Playwright reports as hidden for every descendant), the count of `[data-retry]` (one per `waiting` or `error` case in the fixture: two `waiting` and three `error`, so five), and the exact `.fbh-row` count (the fixture's case count). Read the fixture, fix the numbers in the spec, and run again until green.

- [ ] 7. Add the `e2e` job to `.github/workflows/ci.yml`, after `checks`:

```yaml
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: npx playwright install --with-deps chromium
      - run: pnpm test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

- [ ] 8. Add the size budget. Run `pnpm add -D esbuild`, then create `tools/size.mjs`:

```js
// The spec's budget is "the library's own code under 15 KB gzipped" (§5.1), which is a bundled,
// minified number — what an app's Vite build actually ships — with the two lazy dependencies
// left out, because they are loaded on their own chunks at run time.
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const BUDGET = 15 * 1024;

export async function measure() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    bundle: true,
    minify: true,
    format: "esm",
    write: false,
    external: ["@rrweb/record", "modern-screenshot"],
  });
  const code = result.outputFiles[0].contents;
  return { raw: code.length, gzipped: gzipSync(code).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { raw, gzipped } = await measure();
  console.log(`minified ${raw} bytes, gzipped ${gzipped} bytes, budget ${BUDGET}`);
}
```

and `tests/size.test.js`:

```js
import { describe, expect, it } from "vitest";
import { BUDGET, measure } from "../tools/size.mjs";

describe("the size budget", () => {
  it("keeps the library under 15 KB gzipped, the two lazy dependencies excluded", async () => {
    const { gzipped } = await measure();
    expect(gzipped).toBeLessThan(BUDGET);
  }, 30_000);
});
```

Add `"size": "node tools/size.mjs"` to the scripts in `package.json`.

- [ ] 9. Run `pnpm test`. If the budget test fails, print the number with `pnpm size` and cut in this order until it passes, re-running `pnpm test` after each: collapse the comment blocks in `src/panel/styles.js` (the CSS string ships verbatim, comments and all); shorten the CSS by removing the `@media` block's duplicated properties and merging the `.fbh-pill-*` rules; move the rarely used `src/panel/annotate.js` behind a dynamic `import()` in `src/panel/form.js`'s `annotate()` (it is only needed once someone clicks the pen). Record the final number in the pull request description.

- [ ] 10. Create `types/index.d.ts`:

```ts
// Hand-written: the package ships no build step and no generated types.
export type Status =
  | "waiting"
  | "triaging"
  | "filed"
  | "needs_reply"
  | "answered"
  | "duplicate"
  | "not_filed"
  | "in_progress"
  | "fixed"
  | "closed"
  | "error";

export interface CaptureOptions {
  replay?: boolean;
  screenshot?: boolean;
  console?: boolean;
  network?: boolean;
  maskAllInputs?: boolean;
  blank?: string[];
}

export interface Reporter {
  id: string;
  name?: string;
  email?: string;
  role?: string;
}

export interface MountOptions {
  /** The hub's base URL. Empty or absent: the feature is off and the button is hidden. */
  hubUrl?: string;
  /** The app id in the hub's apps.yaml, for example "cad". Required. */
  app: string;
  env?: string;
  version?: string;
  getToken: () => Promise<string | null>;
  user?: () => Reporter | null;
  section?: () => string;
  sections?: string[];
  types?: string[];
  button?: string | Element | null;
  theme?: () => "light" | "dark" | string;
  onSummary?: (summary: { attention: number }) => void;
  capture?: CaptureOptions;
}

/** A seam for tests and for an app that brings its own panel. Not part of the options object. */
export interface MountDeps {
  doc?: Document;
  win?: Window;
  fetch?: typeof fetch;
  transport?: unknown;
  storage?: Storage | null;
  schedule?: (fn: () => void) => void;
  loadRecorder?: () => Promise<unknown>;
  loadScreenshot?: () => Promise<unknown>;
  createPanel?: (context: { api: unknown; options: unknown; doc: Document }) => {
    open(): void;
    close(): void;
    destroy(): void;
  };
}

export interface ReportFields {
  section?: string;
  type?: string;
  text: string;
  images?: Blob[];
  includeReplay?: boolean;
  screenshot?: Blob | null;
}

export interface ReportSummary {
  id: string;
  at: string;
  section: string;
  type: string;
  text: string;
  reporter: { id: string; name: string };
  status: Status;
  label: string;
  verdict: {
    verdict: string;
    summary: string;
    issueNumber: number | null;
    issueUrl: string | null;
    duplicateOf: number | null;
    answer: string | null;
    questions: string[];
    reason: string | null;
    candidate: boolean;
    receivedAt: string;
  } | null;
  issue?: { number: number; url: string; state: "open" | "closed" };
  pullRequest?: { number: number; url: string; state: "open" | "closed"; merged: boolean };
  duplicateOf?: { number: number; url: string; state: "open" | "closed" };
  progress?: string;
  degraded?: boolean;
  replies: { at: string; by: string; text: string }[];
}

export interface FeedbackHandle {
  open(): void;
  close(): void;
  submit(fields: ReportFields): Promise<{ id: string; dropped: string[] } | null>;
  list(): Promise<{ items: ReportSummary[]; nextCursor: string | null }>;
  reply(id: string, text: string): Promise<unknown>;
  retry(id: string): Promise<unknown>;
  destroy(): void;
}

export declare class FeedbackError extends Error {
  status: number;
  code: string;
  part: string | null;
}

export declare function mountFeedback(options: MountOptions, deps?: MountDeps): FeedbackHandle;
export declare function statusLabel(
  status: Status,
  ctx?: { issue?: number; duplicateOf?: number; originalState?: "open" | "closed" | "fixed" },
): string;
export declare const STATUSES: Status[];
export declare const CLIENT_ID: string;
export declare const CLIENT_VERSION: string;
```

and point `package.json`'s export at it:

```json
  "exports": {
    ".": { "types": "./types/index.d.ts", "default": "./src/index.js" },
    "./fixtures/status-cases.json": "./fixtures/status-cases.json",
    "./package.json": "./package.json"
  },
```

- [ ] 11. Replace `README.md` with the recipe a consumer needs:

````markdown
# feedback-client

The in-app "report an issue or suggestion" panel for the amikob dashboards. It captures what
happened in the page — console, errors, network, a click trail, a session replay, a screenshot and
a snapshot of the DOM — and posts it to [`feedback-hub`](https://github.com/amikob-inc/feedback-hub),
which files it, answers it, or turns it into a pull request. Framework-free, no build step, MIT.

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
  capture: { replay: true, screenshot: true, console: true, network: true, maskAllInputs: false, blank: [] },
});
```

Every function is called lazily, at open or at submit, so mounting reads no app state and the
module can be imported in any order. An unknown option throws at mount, so a typo is found in
development. `getToken` returning `null` disables submit with "Sign in to report".

`mountFeedback` returns `{ open, close, submit(fields), list(), reply(id, text), retry(id), destroy }`.
An app that wants its own UI can use those and never open the built-in panel.

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

## Privacy

Passwords are always masked in the replay, the DOM snapshot and the click trail. `maskAllInputs:
true` masks every typed value in all three. `blank: [".sku-price"]` blanks matching elements in the
replay and the snapshot. Request headers, cookies and query strings are never captured. The
reporter sees what is attached before sending and can leave the recording out. The only network
destination is `hubUrl`.

## Develop

```sh
pnpm install
pnpm test          # vitest, node and jsdom
pnpm lint
pnpm format:check
pnpm size          # the minified, gzipped size against the 15 KB budget
node tests/stub-hub.mjs      # then open http://localhost:8787/demo/index.html
pnpm test:e2e      # Playwright against that stub
```

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
````

- [ ] 12. Create `CHANGELOG.md`:

```markdown
# Changelog

All notable changes to this package. Consumers install a git tag
(`pnpm add github:amikob-inc/feedback-client#vX.Y.Z`), so every release is a tag and an entry here.

## 0.1.0 — 2026-09-21

First release, Mission 16 piece C1.

- `mountFeedback(options, deps?)`: the headless API (`open`, `close`, `submit`, `list`, `reply`,
  `retry`, `destroy`) and the built-in Shadow-DOM panel that uses it.
- Capture: console (200 entries, 1 KB each), errors (20), network (50 failed or slow, query
  strings stripped), breadcrumbs (100), rrweb replay (two 60-second segments), a screenshot and a
  masked DOM snapshot.
- One multipart bundle to `POST /v1/reports` with every cap the hub enforces, and a friendly
  message for each way it can be refused.
- "My reports": every status the hub can produce, the AI's answers and questions, replies, Retry,
  issue and pull-request links, 30-second polling and `onSummary` for the app's own dot.
- Privacy: passwords always masked, `maskAllInputs`, `blank` selectors, no third-party calls.
```

- [ ] 13. Run the lot: `pnpm lint`, `pnpm format`, `pnpm format:check`, `pnpm test`, `pnpm test:e2e`. All green.

- [ ] 14. Commit:

```
git add -A && git commit -m "feat(demo): the demo page, the stub hub, the browser test and the v0.1.0 release notes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] 15. Open the pull request, and say in its description: the commands run and their results, the gzipped size from `pnpm size`, that both themes were walked in the demo with a clean console, and that `amikob-inc/feedback-hub` needs the companion pull request adding `service/tests/fixtures/status-cases.json` (a byte-identical copy of `fixtures/status-cases.json`) and the loop over it in `service/tests/status.test.ts` with the same digest.

- [ ] 16. Once it is merged and CI is green on `main`, tag the release and push the tag:

```
git checkout main && git pull
git tag -a v0.1.0 -m "feedback-client v0.1.0"
git push origin v0.1.0
```

Then check the tag installs as a consumer would, from a scratch directory:

```
pnpm add github:amikob-inc/feedback-client#v0.1.0
node -e "import('@amikob/feedback-client').then((m) => console.log(m.CLIENT_ID))"
```

It must print `feedback-client/0.1.0` with no build step in between (spec §15, check 6).
