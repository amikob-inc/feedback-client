# preview/all-changes — merge report

Branch `preview/all-changes` = `origin/feat/viewport-screenshot-and-delete` (PR #5) + merge commit of
`origin/feat/recording-window-and-preview` (PR #6). Final commit: 44fbc9c87d2572d62a0f3c50876baf533bbf0011
(the merge commit; no fix-up commit was needed). Pushed to origin; no PR opened.

## Conflicts (git reported 9) and resolutions

- `CHANGELOG.md`: both entries kept, 0.3.0 above 0.2.0.
- `README.md` (Size section only): one paragraph combining both — v0.3.0, the viewport module
  (from #5) and the player as the fourth on-demand chunk (from #6); numbers re-quoted from this
  branch's `pnpm size`: page load 11.9 KB (12177 bytes), panel 12.4 KB (12731 bytes), viewport
  1.9 KB (1970 bytes). The API line with `remove(id)`, the Privacy/viewport text and Develop
  paragraphs auto-merged from both sides.
- `package.json`, `src/version.js`, `tests/version.test.js`: 0.3.0 (#6's side).
- `src/mount.js`: `remove(id)` (#5) and `pending()`/`replayEvents()` (#6) both kept; handle is
  `{ open, close, submit, list, reply, retry, remove, destroy }`; `internal` adds `markRead`,
  `captureScreenshot`, `replayReady`, `pending`, `replayEvents`, `loadPlayer: deps.loadPlayer`,
  `options`. Inert handle's `remove()` (#5) and #6's frozen copy / `close()`/`destroy()` clearing
  auto-merged.
- `src/panel/list.js`: `stop()` removes the `visibilitychange` listener AND clears `note.textContent`.
- `src/panel/styles.js`: kept #5's wide-panel block (stage and canvas sizing) but its selector
  replaced by #6's two-selector rule (`.fbh-panel:has(.fbh-form-annotating), .fbh-panel:has(.fbh-form-previewing)`),
  so there is exactly one wide-panel rule; comment extended by one sentence to mention the preview.
  All other rules from both sides present (`.fbh-danger`, `.fbh-confirm`, `.fbh-list-message`,
  `.fbh-sending*`, `.fbh-link`, `.fbh-preview*`, replayer rules); the inert rule names both
  `.fbh-form-annotating` and `.fbh-form-previewing` (auto-merged from #6).
- `tests/mount.test.js`: #5's `describe("remove")` and #6's `describe("the recording is frozen…")`
  both kept.

## Auto-merged (checked)

`src/panel/form.js`, `src/panel/panel.js` (`nestedDialog()` + `focusable()` skipping `[hidden]`
ancestors), `src/transport.js`, `e2e/panel.spec.js` (the `toBeLessThan(canvas.width)` assertion
appears once), `tests/stub-hub.mjs` (`canDelete`, DELETE route, `first`/`last`), `types/index.d.ts`
(`remove`, `canDelete`, `pending`, `replayEvents`, `loadPlayer`), `demo/demo.js` (far swatch,
`watchedRecorder`, `demoRecorded`, fake player), `tools/*`, fixtures (#5's), `pnpm-lock.yaml`
(#6's; `pnpm install` reported already up to date), other tests.

## Beyond conflict resolution

Nothing apart from the README size numbers and the one-sentence styles comment. `pnpm format`
changed nothing else. No test was adjusted.

## Checks

- `pnpm install`: already up to date.
- `pnpm lint`: exit 0, no warnings.
- `pnpm format:check`: all files use Prettier style.
- `pnpm test`: 34 files, 576 tests passed.
- `pnpm size`: page load 12177 bytes gzipped (ceiling 12288, budget 15360 — 111 bytes under the
  ceiling); index.js 9576, chunk 2601, panel 12731 on demand, viewport 1970 on demand; five
  dynamic imports (@rrweb/record, modern-screenshot, viewport, panel, rrweb-player).
- `pnpm test:e2e`: 21 passed (1.8 min).
