# Changelog

All notable changes to this package. Consumers install a git tag
(`pnpm add github:amikob-inc/feedback-client#vX.Y.Z`), so every release is a tag and an entry here.

## Unreleased

- **Refresh** in the heading of "My reports" asks the hub at once instead of at the next poll
  (cad-dashboard #94: a reporter reloaded the whole page to see an answer land). While the
  listing is on its way the button reads "Refreshing…" and ignores another press; it is
  `aria-disabled`, never `disabled`, so keyboard focus stays on it inside the dialog. "Reports
  updated." confirms it in the list's live region; a failure keeps the rows already shown and says
  why there, or, with no rows, where the placeholder was. Panel chunk only; page load unchanged.
- A duplicate verdict stored without an issue number — hand-written, or from before the hub's
  schema refused one — reads "Already tracked" instead of "Already tracked as #undefined"
  (feedback-hub #9; owner's decision 2026-10-01). `fixtures/status-cases.json` gains the case and
  its digest changes; the hub asserts the same digest in its copy.

## 0.3.0 — 2026-09-30

- A click on the backdrop while the drawing or the preview dialog is open no longer closes the
  whole panel (owner's finding, 2026-09-30: with the screenshot retaken on the next open, a click
  beside the drawing dialog lost the drawing). The dialog owns the backdrop as it owns Escape.
- The panel is 600 px wide on desktop (was 460). The screenshot thumbnail is 144×96 with larger,
  clearer Draw and Remove buttons; "What will be sent" is a captioned block; the recording's
  "Don't send it" control is a switch at the right end of its line; "My reports" rows put their
  actions in one right-aligned row; the recording preview plays centred on a dark stage — and
  plays at all: the player centres its frame from the box's middle, and two of rrweb's wrapper
  rules that make that work had been left out, so the recording was drawn out of its box.
- The recording a report carries is the minute or two **before the panel opened**, however long
  the report takes to write: a copy of the recording is taken the moment the panel opens and that
  copy is sent (a failed submit keeps it for the retry; the next open takes a fresh one). Until
  now the window was cut at Send, so a report written slowly carried the minutes of writing and
  nothing of what it was about.
- "What will be sent" is a list, one line per thing that goes, with counts: the screenshot (and
  that it was taken when the panel opened), the recording and the window it covers, the images
  added, and the console and network log's line counts. The recording's line carries a
  **Preview** button and the "Leave it out" switch; leaving it out strikes the line through and
  moves nothing (the old one-line note re-wrapped and made the switch jump).
- **Preview** plays the recording the report will carry, inside the panel at almost full screen,
  with Play/Pause, the time and Close (Escape closes). The player is `rrweb-player`, the third
  dependency fetched only on demand — never on page load.
- "My reports" refreshes as soon as the tab becomes visible again, not at the next poll.
- The headless API's panel context gains `pending()`, `replayEvents()` and `loadPlayer`;
  `MountDeps.loadPlayer` is the seam for a stand-in player.
- Known gap: the line's duration and the preview cover both recording segments; a recording over
  the hub's 8 MB cap is sent with its older segment dropped, or not at all, so the line can
  promise more than is sent — to be fixed by applying the cut when the panel opens.

## 0.2.0 — 2026-09-29

- The automatic screenshot captures the **viewport**, not the page. Opening the panel used to
  freeze the host page for seconds: modern-screenshot clones every element under `body`, copies
  its computed style property by property (some six hundred, three times over for the two
  pseudo-elements) in one task that never yields, then rasterises the whole page — measured on
  cad-dashboard's Rings view as 17 s of clone and 7 s of raster for 60 cards on a slow machine,
  growing with the page, and ending in a blank picture because the SVG did not decode inside the
  library's five-second wait. Now every element outside the viewport keeps its box and loses its
  subtree, the picture is the window's size at the reporter's scroll position, a scrolled
  container inside the page is shifted the same way, and only the properties that shape and paint
  a box are copied (`src/capture/viewport.js`, loaded with the screenshot module, never on page
  load). Same page, both levers: a 13× shorter stall, and a cost that no longer grows with the
  page. Where there is no layout at all (jsdom) the whole page is captured as before.
- **Delete** in "My reports" (`remove(id)` on the headless API): a Delete button exactly where the
  hub's listing says `canDelete` — no issue yet, or an open issue with no fix under way — asks
  once in the row, naming the open issue that will be closed with it, then sends
  `DELETE /v1/reports/:id` and takes the row away; the confirmation and keyboard focus land on
  the list's own live region. A refusal (`409 not_deletable`, once a fix is in progress or the
  issue is fixed or closed) is shown in the row. A just-sent report is deletable at once, as the
  hub would list it. Needs feedback-hub with D17 (2026-09-29).
- Drawing on a screenshot gets almost the whole screen: while the drawing dialog is open the panel
  widens to 96% of the window and the picture is scaled to fit nearly all of it, proportions
  kept, instead of a 460 px column with the picture capped at 40% of the height (owner's request,
  2026-09-30). The panel is back to its ordinary size the moment the dialog closes.
- `fixtures/status-cases.json` carries `canDelete` per case; the digest changes here and in the
  hub.
- Page load: 11.7 KB gzipped; the panel 9.8 KB; the new viewport module 1.7 KB on demand.

## 0.1.1 — 2026-09-22

- `maskAllInputs: true` now masks the automatic screenshot as well: every typed value (any input
  kind but checkbox, radio, submit, button, reset and image — a deny-list, since a browser renders
  an unrecognised `type` as text), a textarea's text, a select's chosen option and editable text
  are replaced by asterisks of the same length in the clone the picture is drawn from, so the
  picture cannot show what the recording withholds; for a select it is stricter than the
  recording, which keeps the option list and masks only the value. It was the one part that showed typed values whatever
  the setting (the leak harness's one declared gap, now closed; three field kinds join its
  screenshot positions, and a second, unmasked run proves the picture still shows them when asked
  to). A checkbox's state is not a value and stays in both. Page load: 11.6 KB gzipped.

## 0.1.0 — 2026-09-21

First release, Mission 16 piece C1.

- `mountFeedback(options, deps?)`: the headless API (`open`, `close`, `submit`, `list`, `reply`,
  `retry`, `destroy`) and the built-in Shadow-DOM panel that uses it. The panel is loaded on
  demand, so `open()` returns a promise that resolves once it is showing.
- Capture: console (200 entries, 1 KB each), errors (20), network (50 failed or slow), breadcrumbs
  (100), rrweb replay (two 60-second segments) and a screenshot. Wherever a URL is written down
  — the page context, the route breadcrumb, a network entry, the replay's Meta href and every
  URL attribute in it — the query string goes, and so does a fragment that carries parameters
  (`#access_token=…`, where supabase-js's implicit flow lands a session); a route fragment
  (`#batch-12`) stays, a hash router's route with parameters (`#/orders?page=2`) goes.
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
- Size: 11.3 KB gzipped on page load against a 15 KB budget; the panel is another 9.5 KB fetched
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
