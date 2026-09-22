# Changelog

All notable changes to this package. Consumers install a git tag
(`pnpm add github:amikob-inc/feedback-client#vX.Y.Z`), so every release is a tag and an entry here.

## 0.1.0 — 2026-09-21

First release, Mission 16 piece C1.

- `mountFeedback(options, deps?)`: the headless API (`open`, `close`, `submit`, `list`, `reply`,
  `retry`, `destroy`) and the built-in Shadow-DOM panel that uses it. The panel is loaded on
  demand, so `open()` returns a promise that resolves once it is showing.
- Capture: console (200 entries, 1 KB each), errors (20), network (50 failed or slow, query
  strings stripped), breadcrumbs (100), rrweb replay (two 60-second segments) and a screenshot.
  No bespoke copy of the page: one was built and withdrawn before release (2026-09-21), because
  three adversarial reviews got sensitive data past its sanitiser.
- One multipart bundle to `POST /v1/reports` with every cap the hub enforces, and a friendly
  message for each way it can be refused.
- "My reports": every status the hub can produce, the AI's answers and questions, replies, Retry,
  issue and pull-request links, 30-second polling and `onSummary` for the app's own dot.
- Privacy: passwords always masked, `maskAllInputs`, `blank` selectors, no third-party calls. The
  `blank` selectors now apply to the screenshot as pixels and inside same-origin child frames,
  both confirmed in a real browser.
- Hand-written TypeScript declarations (`types/index.d.ts`), checked against the real exports.
- Size: 11.2 KB gzipped on page load against a 15 KB budget; the panel is another 9.5 KB fetched
  on the first open. See the README's "Size".

Fixed before release, by the browser run that the jsdom tests could not do (`e2e/panel.spec.js`):

- A page-wide `visibility: hidden` on every element hid the whole panel. Inherited properties
  reach a shadow tree through the host whatever the selectors do, and `:host { all: initial }`
  loses to an important declaration in the page; the panel now declares them on its own outermost
  element instead.
- Focus was dropped to `<body>` — outside the shadow root, and so outside the dialog's focus trap
  and its Escape — whenever a control was disabled underneath it: Send, Send reply and Retry.
  Focus now moves to the status line that is about to be read out, and the words are put there
  first, because a `:empty` status line is `display: none` and cannot take focus.
- Every "is focus inside this element?" test in the panel asked `document.activeElement`, which
  answers with the _host_ element for anything inside the shadow root. So the mid-edit row a poll
  must not rebuild, the focus put back after a reply, and the control an annotator returns focus
  to were all inoperative in the real panel while passing in jsdom, where the same components are
  mounted straight into the document.
