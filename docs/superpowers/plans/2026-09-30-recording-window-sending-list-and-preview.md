# Recording window, "What will be sent" list with preview, and status freshness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The report's recording is the minute or two *before the panel opened* however long the report takes to write; the panel says what will be sent as a list with counts, lets the reporter preview the recording in place, and no longer jumps when the recording is left out; a report's status follows its issue within two minutes even after a reopen.

**Architecture:** `mount.js` takes a copy of the recording's two segments the moment `open()` is called and sends that copy; the same module answers `pending()` (what the next report carries, with counts) and `replayEvents()` for the panel. The form renders `pending()` as a `<ul>` whose recording line is one persistent node with a Preview button and the "leave it out" switch on it, so toggling changes a class, never the layout. `src/panel/preview.js` is the drawing dialog's sibling: a nested dialog that loads `rrweb-player` on demand and plays the frozen events, with the panel widened the way it is for drawing. The hub's closed-issue cache drops from ten minutes to two, and the list refreshes when the tab becomes visible again.

**Tech Stack:** plain ES modules, no framework (README "Develop"); vitest with jsdom for the panel, plain node for the pure modules; Playwright against `tests/stub-hub.mjs` and the demo page; `rrweb-player` (^2.1.5, the version the hub already uses) as the third lazily imported dependency beside `@rrweb/record` and `modern-screenshot`; the hub is TypeScript on Hono, vitest.

**Spec:** `docs/superpowers/specs/2026-09-16-mission-16-feedback-hub-design.md` §5.2 (buffers and the replay: "sixty to a hundred and twenty seconds of what the reporter did"), §5.4 (the panel, the "what will be sent" note), §6.7 (listing and status mapping, "cached per issue for thirty seconds"). The owner's requests of 2026-09-30 (this plan's brief): (1) the "what will be sent" note as a list, with how many screenshots, a preview of the recording on request, and a recording that covers the time *before* the panel was opened; (2) the "Leave the recording out" switch must not make anything jump; (3) a report's status must follow its issue's status.

## Global Constraints

- The library may never break the host application: every host hook and every dynamic import is guarded, failures degrade to a warning (`warnOnce`) and a fallback, never a throw into the host (spec §5.8; `src/mount.js` "Standing rule 1").
- Page load stays under **15 KB gzipped** and under the current ceiling `CEILING = 12_288` bytes in `tools/size.mjs`; everything new below is on the panel's chunk or loaded on demand. `rrweb-player` is `import()`ed only, never `import`ed.
- No `innerHTML` anywhere in `src/panel/` (`src/panel/dom.js`'s `el()` is the only way to build DOM); a report's text and everything from the hub is data.
- The report JSON's shape does not change (`buildReport` in `src/bundle.js`): the hub's intake and the contract fixture read it as is.
- Line endings LF, Prettier (`pnpm format`), `pnpm lint` clean, `pnpm test` green, `pnpm size` under the ceiling, `pnpm test:e2e` green before every commit that touches the panel.
- Copy is plain English sentences the reporter reads; every status change is announced by a live region, never only shown by colour (`src/panel/form.js` comments on `message`).
- Work on branch `feat/recording-window-and-preview` off `main` (`2693c14`), **not** on `feat/viewport-screenshot-and-delete` ([PR #5](https://github.com/amikob-inc/feedback-client/pull/5)); rebase onto `main` once #5 has merged (conflicts expected in `form.js`, `styles.js`, `CHANGELOG.md`, `README.md`; take both sides). Version after #5 is `0.2.0`; this branch becomes `0.3.0`.
- Commits end with the attribution lines the session was given (`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and the `Claude-Session:` line).

---

## File structure

| File | Responsibility after this plan |
|---|---|
| `src/capture/replay.js` | Segments now seedable (`createSegments({ previous, current })`), with `snapshot()` (a copy) and `replayWindow(segments)` (first/last timestamp, seconds). Everything else unchanged. |
| `src/mount.js` | Freezes the recording at `open()` (`frozen`), sends the frozen copy at `submit()`, clears it after a successful submit; answers `pending()` and `replayEvents()` on the panel's internal api; passes `deps.loadPlayer` through as `loadPlayer`. |
| `src/bundle.js` | `describeAttachments` is replaced by `attachmentLines(...)` (an array of lines, one per thing sent, with counts) and `formatDuration(seconds)`. |
| `src/panel/form.js` | Renders `attachmentLines` as `<ul class="fbh-sending">`; the recording line is one persistent `<li>` holding the text, the Preview button and the "Leave it out" switch; `preview()` opens `src/panel/preview.js` inside `previewMount` the way `annotate()` opens the annotator. |
| `src/panel/preview.js` | **New.** `openPreview({ doc, mount, events, load, onClose })`: the nested dialog that loads `rrweb-player`, plays the events without the player's own controller, and offers Play/Pause, the time, and Close; Escape closes it. |
| `src/panel/panel.js` | The nested-dialog hook covers `.fbh-preview` as well as `.fbh-annotator` (Escape ownership and the Tab scope). |
| `src/panel/styles.js` | `.fbh-sending` list, the `is-off` look of the recording line, `.fbh-link`, the preview dialog and stage, the wide-panel rule extended to `.fbh-form-previewing`, and the replayer's own cursor and wrapper rules (rrweb's class names, hand-copied). |
| `src/panel/list.js` | Refreshes when the document becomes visible again while the list is started. |
| `package.json`, `src/version.js`, `CHANGELOG.md`, `README.md`, `types/index.d.ts` | `rrweb-player` dependency; version `0.3.0`; the new API (`pending`, `replayEvents`, `loadPlayer`); the README's "Mount it", "Privacy" and "Size" sections. |
| `tools/size.mjs`, `tools/build-demo.mjs`, `demo/demo.js` | The third lazy dependency, its chunk in the demo manifest, and a fake player for the default demo mode. |
| `tests/stub-hub.mjs` | `/_stub/last` also reports the recording's first and last timestamps. |
| `tests/replay.test.js`, `tests/mount.test.js`, `tests/bundle.test.js`, `tests/form.test.js`, `tests/preview.test.js` (new), `tests/panel.test.js`, `tests/list.test.js`, `tests/size.test.js`, `e2e/panel.spec.js` | The tests named in each task. |
| feedback-hub `service/src/listing.ts`, `service/tests/listing.test.ts`, `README.md`, `CLAUDE.md`, the spec | The closed-issue cache default: 120 s, exported, documented. Its own pull request in the hub repository. |

---

### Task 1: Segments that can be copied, and the window they cover

**Files:**
- Modify: `src/capture/replay.js:113-170` (`createSegments`, `serializeReplay` stays as is)
- Test: `tests/replay.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createSegments({ previous?: Event[], current?: Event[] })` (both optional, default empty); `segments.snapshot(): Segments` (a copy, itself a full segments object `serializeReplay` accepts); `replayWindow(segments): { from: number, to: number, seconds: number } | null` (`from`/`to` are rrweb `timestamp` values in ms; `seconds` is `round((to - from) / 1000)`; `null` when no event carries a numeric timestamp).

- [ ] **Step 1: Write the failing tests**

Add to `tests/replay.test.js`, inside `describe("createSegments", ...)` after the `clear` test, and a new describe after it (the file already imports from `../src/capture/replay.js`; add `replayWindow` to that import):

```js
  it("snapshot() is a copy: later events and a later checkout do not reach it", () => {
    const segments = createSegments();
    segments.push({ type: 4, timestamp: 1000 }, true);
    segments.push({ type: 3, timestamp: 2000 }, false);
    const copy = segments.snapshot();
    segments.push({ type: 3, timestamp: 3000 }, false);
    segments.push({ type: 2, timestamp: 4000 }, true);
    expect(copy.events().map((e) => e.timestamp)).toEqual([1000, 2000]);
    expect(copy.count()).toBe(2);
    expect(segments.count()).toBe(4);
    // And the copy is a segments object in its own right: serializeReplay can drop its previous
    // segment without touching the live one.
    copy.dropPrevious();
    expect(segments.previous().length + segments.current().length).toBe(4);
  });

  it("is seedable with both segments, which is what snapshot() is built from", () => {
    const seeded = createSegments({ previous: [{ timestamp: 1 }], current: [{ timestamp: 2 }] });
    expect(seeded.previous()).toEqual([{ timestamp: 1 }]);
    expect(seeded.current()).toEqual([{ timestamp: 2 }]);
    expect(seeded.events()).toEqual([{ timestamp: 1 }, { timestamp: 2 }]);
  });
});

describe("replayWindow", () => {
  it("is the span from the first to the last timestamp, in whole seconds", () => {
    const segments = createSegments({
      previous: [{ timestamp: 10_000 }, { timestamp: 40_000 }],
      current: [{ timestamp: 41_000 }, { timestamp: 113_400 }],
    });
    expect(replayWindow(segments)).toEqual({ from: 10_000, to: 113_400, seconds: 103 });
  });

  it("ignores events without a numeric timestamp, and is null with none at all", () => {
    expect(replayWindow(createSegments())).toBe(null);
    expect(replayWindow(createSegments({ current: [{ type: 3 }, { timestamp: "x" }] }))).toBe(null);
    expect(
      replayWindow(createSegments({ current: [{ type: 3 }, { timestamp: 5000 }, { timestamp: 5000 }] })),
    ).toEqual({ from: 5000, to: 5000, seconds: 0 });
  });

  it("does not spread a large event list onto the stack", () => {
    const current = Array.from({ length: 200_000 }, (_, i) => ({ timestamp: i }));
    expect(replayWindow(createSegments({ current })).seconds).toBe(200);
  });
});
```

(The `it("clear empties both segments"...)` test currently closes the `describe("createSegments")` block; insert the two new `it`s before that closing `});` and the new `describe` after it.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/replay.test.js`
Expected: FAIL — `segments.snapshot is not a function`, `replayWindow is not a function` (import error).

- [ ] **Step 3: Implement**

In `src/capture/replay.js`, replace the `createSegments` function:

```js
// Two segments, the previous and the current, rotated at every checkout. Seedable so that
// snapshot() — a copy taken when the panel opens (mount.js), so that the report carries what
// happened *before* the reporter started writing rather than the minutes they spent writing —
// is itself a full segments object that serializeReplay can consume and prune.
export function createSegments({ previous: seedPrevious = [], current: seedCurrent = [] } = {}) {
  let previous = seedPrevious.slice();
  let current = seedCurrent.slice();
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
    snapshot: () => createSegments({ previous, current }),
  };
}

// What the recording covers: its first and last event's rrweb timestamp (ms since the epoch)
// and the seconds between them. Null when nothing recorded carries a timestamp. A loop, not
// Math.min(...stamps): two minutes of sampled mousemoves is thousands of events, and a spread
// that long is a stack overflow waiting for a busier page.
export function replayWindow(segments) {
  let from = Infinity;
  let to = -Infinity;
  for (const event of segments.events()) {
    const t = event && event.timestamp;
    if (typeof t !== "number" || Number.isNaN(t)) continue;
    if (t < from) from = t;
    if (t > to) to = t;
  }
  if (from === Infinity) return null;
  return { from, to, seconds: Math.round((to - from) / 1000) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/replay.test.js`
Expected: PASS, every test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/capture/replay.js tests/replay.test.js
git commit -m "feat(replay): seedable segments with snapshot(), and replayWindow()"
```

---

### Task 2: Freeze the recording when the panel opens; `pending()` and `replayEvents()` for the panel

**Files:**
- Modify: `src/mount.js` (imports at top; `replayPart()` at ~201; `submit()` after `transport.submit`; `open()` at ~318; the `internal` object at ~352; `inertHandle()` unchanged)
- Test: `tests/mount.test.js`

**Interfaces:**
- Consumes: `segments.snapshot()`, `replayWindow(segments)` from Task 1; `buffers.console()/errors()/network()/breadcrumbs()` from `src/buffers/install.js` (each returns an array).
- Produces, on the panel's internal api (the object handed to `createPanel` and to the built-in panel): `pending(): { screenshot: boolean, replay: { from, to, seconds } | null, console: number, errors: number, network: number, breadcrumbs: number }`; `replayEvents(): Event[]` (the frozen copy's events, or the live ones when the panel was never opened, or `[]` with no recorder); `loadPlayer: (() => Promise<unknown>) | undefined` (straight from `deps.loadPlayer`). Behaviour: `open()` replaces the frozen copy every time; `submit()` sends the frozen copy when there is one and clears it once the hub has accepted the report.

- [ ] **Step 1: Write the failing tests**

Add to `tests/mount.test.js` a new `describe` at the end of the file. It uses the file's existing `mount()` and `polyfillJsdomBlob()` helpers and `vi`:

```js
// The recording a report carries is the one from *before* the panel opened (owner's request,
// 2026-09-30): a copy is taken at open(), and what the recorder adds while the reporter writes
// never reaches the report. Without this, a report written slowly carried the minutes of writing
// and nothing of what it was about.
describe("the recording is frozen when the panel opens", () => {
  function recorderEmitting(emitted) {
    // A recorder whose emit handle the test keeps, so events can be added at chosen moments.
    return async () => ({
      record(options) {
        emitted.push(options.emit);
        options.emit({ type: 2, timestamp: 1000, data: {} }, true);
        return () => {};
      },
    });
  }

  async function mountRecording() {
    const emitted = [];
    let api = null;
    const { handle, transport } = mount(
      { capture: { replay: true, screenshot: false } },
      {
        loadRecorder: recorderEmitting(emitted),
        schedule: (fn) => fn(),
        createPanel: ({ api: given }) => {
          api = given;
          return { open() {}, close() {}, destroy() {} };
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const emit = emitted[0];
    return { handle, transport, emit, api: () => api };
  }

  async function replayEventsSent(transport, call = 0) {
    const part = transport.submit.mock.calls[call][0].get("replay");
    const bytes = new Uint8Array(await part.arrayBuffer());
    const text = new TextDecoder().decode(new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()));
    return JSON.parse(text).map((event) => event.timestamp);
  }

  it("sends what was recorded before open(), not what came after", async () => {
    const { handle, transport, emit } = await mountRecording();
    emit({ type: 3, timestamp: 2000, data: {} }, false);
    await handle.open();
    emit({ type: 3, timestamp: 9000, data: {} }, false);
    emit({ type: 2, timestamp: 9500, data: {} }, true);
    await handle.submit({ text: "written slowly" });
    expect(await replayEventsSent(transport)).toEqual([1000, 2000]);
    handle.destroy();
  });

  it("takes a fresh copy on every open(), and forgets it after a successful submit", async () => {
    const { handle, transport, emit } = await mountRecording();
    await handle.open();
    emit({ type: 3, timestamp: 2000, data: {} }, false);
    await handle.open();
    await handle.submit({ text: "second open" });
    expect(await replayEventsSent(transport, 0)).toEqual([1000, 2000]);
    // Headless, with no open() in between: the live recording again.
    emit({ type: 3, timestamp: 3000, data: {} }, false);
    await handle.submit({ text: "headless" });
    expect(await replayEventsSent(transport, 1)).toEqual([1000, 2000, 3000]);
    handle.destroy();
  });

  it("keeps the copy when the submit fails, so a retry sends the same recording", async () => {
    const { handle, transport, emit } = await mountRecording();
    await handle.open();
    emit({ type: 3, timestamp: 5000, data: {} }, false);
    transport.submit.mockRejectedValueOnce(new Error("hub down"));
    await expect(handle.submit({ text: "first try" })).rejects.toThrow("hub down");
    await handle.submit({ text: "second try" });
    expect(await replayEventsSent(transport, 1)).toEqual([1000]);
    handle.destroy();
  });

  it("pending() says what the next report carries, with counts, from the frozen copy", async () => {
    const { handle, emit, api } = await mountRecording();
    emit({ type: 3, timestamp: 61_000, data: {} }, false);
    await handle.open();
    emit({ type: 3, timestamp: 200_000, data: {} }, false);
    const pending = api().pending();
    expect(pending.replay).toEqual({ from: 1000, to: 61_000, seconds: 60 });
    expect(pending.screenshot).toBe(false);
    expect(pending).toMatchObject({ console: 0, errors: 0, network: 0, breadcrumbs: 0 });
    expect(api().replayEvents().map((e) => e.timestamp)).toEqual([1000, 61_000]);
    handle.destroy();
  });

  it("pending() has no recording and no events without a recorder", async () => {
    let api = null;
    const { handle } = mount(
      { capture: { replay: false, screenshot: true } },
      {
        createPanel: ({ api: given }) => {
          api = given;
          return { open() {}, close() {}, destroy() {} };
        },
      },
    );
    await handle.open();
    expect(api.pending()).toEqual({
      screenshot: true,
      replay: null,
      console: 0,
      errors: 0,
      network: 0,
      breadcrumbs: 0,
    });
    expect(api.replayEvents()).toEqual([]);
    expect(api.loadPlayer).toBe(undefined);
    handle.destroy();
  });

  it("hands deps.loadPlayer to the panel as api.loadPlayer", async () => {
    const loadPlayer = async () => ({});
    let api = null;
    const { handle } = mount(
      { capture: { replay: false, screenshot: false } },
      {
        loadPlayer,
        createPanel: ({ api: given }) => {
          api = given;
          return { open() {}, close() {}, destroy() {} };
        },
      },
    );
    await handle.open();
    expect(api.loadPlayer).toBe(loadPlayer);
    handle.destroy();
  });
});
```

If `DecompressionStream` is not available in the test environment (Node 20+ has it globally; jsdom's window does not shadow it), replace the body of `replayEventsSent` with node's `gunzipSync`: `import { gunzipSync } from "node:zlib";` at the top of the file and `return JSON.parse(gunzipSync(Buffer.from(await part.arrayBuffer())).toString("utf8")).map((e) => e.timestamp);`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/mount.test.js -t "frozen"`
Expected: FAIL — the first test sends `[1000, 2000, 9000, 9500]`; `api().pending is not a function`.

- [ ] **Step 3: Implement**

In `src/mount.js`:

1. Extend the replay import: `import { idle, replayWindow, serializeReplay, startReplay } from "./capture/replay.js";`
2. After `const schedule = deps.schedule || idle;` add:

```js
  // The recording a report carries is the minute or two before the panel opened, not before
  // the reporter pressed Send (owner's request, 2026-09-30): open() takes a copy of both
  // segments as they are at that moment, submit() sends the copy, and a successful submit lets
  // it go. A failed submit keeps it, so a retry sends the same recording; a headless submit()
  // with no open() before it sends the live recording, as before.
  let frozen = null;

  function freezeReplay() {
    frozen = replay ? replay.segments.snapshot() : null;
  }

  function recordingSource() {
    if (frozen) return frozen;
    return replay ? replay.segments : null;
  }
```

3. Replace `replayPart()`:

```js
  async function replayPart() {
    const source = recordingSource();
    if (!source) return null;
    const serialized = serializeReplay(source);
    if (!serialized || !serialized.json) return null;
    return gzip(serialized.json);
  }
```

4. In `submit()`, right after `const answer = await transport.submit(bundle.form);` add `frozen = null;`.
5. Add, after `retry(id)`:

```js
  // What the next report will carry, for the panel's "What will be sent" list: whether a
  // screenshot is taken, the recording's window (from the frozen copy once the panel is open),
  // and how many entries each buffer holds right now.
  function pending() {
    const source = recordingSource();
    return {
      screenshot: !!options.capture.screenshot,
      replay: source ? replayWindow(source) : null,
      console: buffers.console().length,
      errors: buffers.errors().length,
      network: buffers.network().length,
      breadcrumbs: buffers.breadcrumbs().length,
    };
  }

  // The events the preview plays: the same ones the report would carry.
  function replayEvents() {
    const source = recordingSource();
    return source ? source.events() : [];
  }
```

6. In `open()`, add `freezeReplay();` as the first line after `wantOpen = true;` (before `ensurePanel()`, so the copy is from the click, not from after the panel's chunk has loaded).
7. Replace the `internal` line:

```js
  const internal = {
    ...handle,
    markRead,
    captureScreenshot: captureNow,
    replayReady,
    pending,
    replayEvents,
    loadPlayer: deps.loadPlayer,
    options,
  };
```

and its comment: `// What the panel gets: the same seven functions plus the six it alone needs.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/mount.test.js`
Expected: PASS, the whole file (the pre-existing "sends the replay" tests still pass: with no `open()` the live segments are sent).

- [ ] **Step 5: Commit**

```bash
git add src/mount.js tests/mount.test.js
git commit -m "feat(mount): freeze the recording at open(); pending() and replayEvents() for the panel"
```

---

### Task 3: `attachmentLines` and `formatDuration` replace `describeAttachments`

**Files:**
- Modify: `src/bundle.js:129-137` (`describeAttachments` is deleted), `src/panel/form.js` import of it (Task 4 rewrites that import; here only `bundle.js` and its test change, and the form keeps importing the old name until Task 4 — so run only the bundle test in this task)
- Test: `tests/bundle.test.js:206-238`

**Interfaces:**
- Produces: `formatDuration(seconds: number): string` — `"47 s"`, `"1 min"`, `"1 min 43 s"`, `"0 s"` for anything not positive. `attachmentLines({ screenshot: boolean, replay: { ready: boolean, seconds: number | null }, images: number, counts: { console, errors, network, breadcrumbs } }): { key: "screenshot" | "replay" | "images" | "logs", text: string }[]`, in that order, a line present only when there is something to say (the `logs` line always).

- [ ] **Step 1: Write the failing tests**

Replace `describe("describeAttachments", ...)` in `tests/bundle.test.js` (and `describeAttachments` in the import at line 3 with `attachmentLines, formatDuration`):

```js
describe("formatDuration", () => {
  it("says seconds under a minute, minutes and seconds above, whole minutes plainly", () => {
    expect(formatDuration(47)).toBe("47 s");
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(103)).toBe("1 min 43 s");
    expect(formatDuration(120.4)).toBe("2 min");
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(-3)).toBe("0 s");
    expect(formatDuration(undefined)).toBe("0 s");
  });
});

describe("attachmentLines", () => {
  const counts = { console: 12, errors: 1, network: 3, breadcrumbs: 40 };

  it("lists everything that goes, one line each, in order, with counts", () => {
    expect(
      attachmentLines({
        screenshot: true,
        replay: { ready: true, seconds: 103 },
        images: 2,
        counts,
      }),
    ).toEqual([
      { key: "screenshot", text: "1 screenshot of this page, taken when you opened the panel" },
      { key: "replay", text: "The recording of the 1 min 43 s before you opened the panel" },
      { key: "images", text: "2 images you added" },
      {
        key: "logs",
        text: "The console and network log: 12 console lines, 1 error, 3 failed or slow requests, 40 clicks",
      },
    ]);
  });

  it("says one image in the singular, and leaves out what is not going", () => {
    expect(attachmentLines({ screenshot: false, replay: { ready: false }, images: 1, counts })).toEqual([
      { key: "images", text: "1 image you added" },
      {
        key: "logs",
        text: "The console and network log: 12 console lines, 1 error, 3 failed or slow requests, 40 clicks",
      },
    ]);
  });

  it("names a recording that has not captured anything yet", () => {
    expect(attachmentLines({ replay: { ready: true, seconds: null }, counts })).toEqual([
      { key: "replay", text: "The recording (nothing recorded yet)" },
      {
        key: "logs",
        text: "The console and network log: 12 console lines, 1 error, 3 failed or slow requests, 40 clicks",
      },
    ]);
  });

  it("counts in the plural and the singular, and copes with nothing at all", () => {
    expect(attachmentLines({})).toEqual([
      {
        key: "logs",
        text: "The console and network log: 0 console lines, 0 errors, 0 failed or slow requests, 0 clicks",
      },
    ]);
    expect(
      attachmentLines({ counts: { console: 1, errors: 2, network: 1, breadcrumbs: 1 } })[0].text,
    ).toBe("The console and network log: 1 console line, 2 errors, 1 failed or slow request, 1 click");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/bundle.test.js`
Expected: FAIL — `attachmentLines`/`formatDuration` are not exported.

- [ ] **Step 3: Implement**

In `src/bundle.js`, delete `describeAttachments` (lines 129–137) and put in its place:

```js
// "1 min 43 s", "47 s", "2 min": the length of the recording as the reporter reads it.
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest} s`;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The "What will be sent" list (spec §5.4, owner's request 2026-09-30: a list, with counts): one
// line per thing that goes, in the order it is worth reading, and nothing for what does not go —
// except the log line, which is always there. The recording's line names the window it covers
// (the minute or two *before* the panel opened, mount.js) so the reporter knows what it shows;
// leaving it out is the form's business (the line stays put and is struck through), not this
// function's, which is why there is no "left out" wording here.
export function attachmentLines({
  screenshot = false,
  replay = null,
  images = 0,
  counts = {},
} = {}) {
  const lines = [];
  if (screenshot) {
    lines.push({
      key: "screenshot",
      text: "1 screenshot of this page, taken when you opened the panel",
    });
  }
  if (replay && replay.ready) {
    lines.push({
      key: "replay",
      text:
        typeof replay.seconds === "number"
          ? `The recording of the ${formatDuration(replay.seconds)} before you opened the panel`
          : "The recording (nothing recorded yet)",
    });
  }
  if (images > 0) lines.push({ key: "images", text: `${plural(images, "image")} you added` });
  const c = counts || {};
  lines.push({
    key: "logs",
    text:
      `The console and network log: ${plural(c.console || 0, "console line")}, ` +
      `${plural(c.errors || 0, "error")}, ${plural(c.network || 0, "failed or slow request")}, ` +
      `${plural(c.breadcrumbs || 0, "click")}`,
  });
  return lines;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/bundle.test.js`
Expected: PASS. (`tests/form.test.js` and `pnpm test` as a whole fail until Task 4, because the form still imports `describeAttachments`; that is expected between these two commits.)

- [ ] **Step 5: Commit**

```bash
git add src/bundle.js tests/bundle.test.js
git commit -m "feat(bundle): attachmentLines with counts and formatDuration replace describeAttachments"
```

---

### Task 4: The "What will be sent" list in the form, with a recording line that never moves

**Files:**
- Modify: `src/panel/form.js` (import at ~line 10; state at 63–100; the `note` and the `replayToggle` at 103, 140–146; the layout at 160–183; `renderNote` at 221–235 and its callers at 246, 332; `prepare()` at 538–590)
- Modify: `src/panel/styles.js:176-181` (beside `.fbh-note` and `.fbh-check`)
- Test: `tests/form.test.js` (the six `fbh-note` assertions at 93, 573–615 and the "What will be sent" describe)

**Interfaces:**
- Consumes: `api.pending()` (Task 2), `attachmentLines` (Task 3).
- Produces: DOM the tests and Task 6's preview rely on: `ul.fbh-sending[aria-label="What will be sent"]`; `li.fbh-sending-item[data-key=screenshot|images|logs]`; the persistent `li.fbh-sending-replay` holding `span.fbh-sending-text`, `button[data-preview]` (Task 6 wires it; here it exists and is `hidden` when nothing is recorded), and `label.fbh-check > input#fbh-no-replay`; the class `is-off` on `li.fbh-sending-replay` while the recording is left out. The form's `renderSending()` replaces `renderNote()`.

- [ ] **Step 1: Write the failing tests**

In `tests/form.test.js`: in `setup()`'s `api` add, after `replayReady: Promise.resolve(true),`:

```js
    pending: vi.fn(() => ({
      screenshot: true,
      replay: { from: 1000, to: 104_000, seconds: 103 },
      console: 12,
      errors: 1,
      network: 3,
      breadcrumbs: 40,
    })),
    replayEvents: vi.fn(() => [{ type: 2, timestamp: 1000, data: {} }]),
```

Then replace every `$(".fbh-note").textContent` assertion. The one at line 93 (inside the first render/prepare test) becomes:

```js
    expect([...$$(".fbh-sending li")].map((li) => li.dataset.key)).toEqual([
      "screenshot",
      "replay",
      "images",
      "logs",
    ]);
```

(only if that test adds images; otherwise `["screenshot", "replay", "logs"]` — read the test and match what it set up; `$$` is `document.querySelectorAll` bound the way `$` is in that file, add it beside `$` if missing).

Replace the `describe` that holds the tests at 568–615 (the "What will be sent" describe) with:

```js
describe("What will be sent", () => {
  const lines = () => [...document.querySelectorAll(".fbh-sending li")].map((li) => li.textContent.trim());

  it("is a list: the screenshot, the recording's window, the images, the log with counts", async () => {
    const { form } = setup();
    await form.prepare();
    expect(document.querySelector(".fbh-sending").getAttribute("aria-label")).toBe("What will be sent");
    expect(lines()[0]).toBe("1 screenshot of this page, taken when you opened the panel");
    expect(lines()[1]).toContain("The recording of the 1 min 43 s before you opened the panel");
    expect(lines()[lines().length - 1]).toBe(
      "The console and network log: 12 console lines, 1 error, 3 failed or slow requests, 40 clicks",
    );
    form.destroy();
  });

  it("adds the images line as images are added, and drops it when they go", async () => {
    const { form } = setup();
    await form.prepare();
    form.addImage(png(), "a.png");
    form.addImage(png(), "b.png");
    expect(lines()).toContain("2 images you added");
    document.querySelector(".fbh-thumb-remove").click();
    expect(lines()).toContain("1 image you added");
    form.destroy();
  });

  it("says nothing about a recording until the recorder has really started", async () => {
    let settle;
    const replayReady = new Promise((resolve) => {
      settle = resolve;
    });
    const { form } = setup({ api: { replayReady } });
    await form.prepare();
    expect(document.querySelector(".fbh-sending-replay").hidden).toBe(true);
    settle(true);
    await vi.waitFor(() =>
      expect(document.querySelector(".fbh-sending-replay").hidden).toBe(false),
    );
    form.destroy();
  });

  it("keeps the recording line hidden when the recorder failed to start", async () => {
    const { form } = setup({ api: { replayReady: Promise.resolve(false) } });
    await form.prepare();
    expect(document.querySelector(".fbh-sending-replay").hidden).toBe(true);
    expect(lines().some((line) => line.includes("recording"))).toBe(false);
    form.destroy();
  });

  it("leaving the recording out strikes the line through and changes nothing else in the list", async () => {
    const { form } = setup();
    await form.prepare();
    const before = lines();
    const row = document.querySelector(".fbh-sending-replay");
    const text = row.querySelector(".fbh-sending-text");
    document.getElementById("fbh-no-replay").click();
    expect(row.classList.contains("is-off")).toBe(true);
    expect(document.querySelector(".fbh-sending-replay .fbh-sending-text")).toBe(text); // same node
    expect(lines()).toEqual(before); // same words, same lines: nothing to re-wrap, nothing moves
    document.getElementById("fbh-no-replay").click();
    expect(row.classList.contains("is-off")).toBe(false);
    form.destroy();
  });

  it("offers Preview only when something has been recorded", async () => {
    const { form } = setup({
      api: { pending: () => ({ screenshot: true, replay: null, console: 0, errors: 0, network: 0, breadcrumbs: 0 }) },
    });
    await form.prepare();
    expect(document.querySelector(".fbh-sending-replay").hidden).toBe(false);
    expect(document.querySelector("[data-preview]").hidden).toBe(true);
    expect(lines()).toContain("The recording (nothing recorded yet)");
    form.destroy();
  });

  it("survives a pending() that throws: the list still says what it can", async () => {
    const { form } = setup({
      api: {
        pending: () => {
          throw new Error("host broke");
        },
      },
    });
    await form.prepare();
    expect(lines().length).toBeGreaterThan(0);
    form.destroy();
  });

  it("re-reads the counts on every prepare(), so a reopened panel is current", async () => {
    const { form, api } = setup();
    await form.prepare();
    await form.prepare();
    expect(api.pending).toHaveBeenCalledTimes(2);
    form.destroy();
  });
});
```

The existing test "sends the recording unless the box is ticked" (search `includeReplay` in the file) still applies unchanged: `fields.includeReplay` is what `submit()` reads.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/form.test.js`
Expected: FAIL — `describeAttachments` import error, then the new selectors find nothing.

- [ ] **Step 3: Implement the form**

In `src/panel/form.js`:

1. Import: replace `describeAttachments` in the `../bundle.js` import with `attachmentLines`.
2. Replace the `note` declaration (line 103) with the list and the persistent recording line. The `replayToggle` moves into it, so delete its later declaration (140–146) and the `el(doc, "label", { class: "fbh-check" }, [replayToggle, ...])` line in the layout (177–180):

```js
  // "What will be sent" (spec §5.4), as a list with counts (owner's request, 2026-09-30). The
  // recording's line is one node that lives for the life of the form — its text, its Preview
  // button and its "Leave it out" switch — and is never rebuilt: leaving the recording out only
  // adds a class that strikes the text through, so the words, the wrapping and the position of
  // everything below stay exactly as they were. Rebuilding the line, or changing its words, made
  // the switch itself jump under the pointer (owner's finding, 2026-09-30).
  const sending = el(doc, "ul", { class: "fbh-sending", "aria-label": "What will be sent" });
  const replayText = el(doc, "span", { class: "fbh-sending-text" });
  const previewButton = el(doc, "button", {
    type: "button",
    class: "fbh-link",
    "data-preview": true,
    hidden: true,
    text: "Preview",
    onClick: () => preview(),
  });
  const replayToggle = el(doc, "input", {
    id: "fbh-no-replay",
    type: "checkbox",
    onChange: () => {
      includeReplay = !replayToggle.checked;
      replayLine.classList.toggle("is-off", !includeReplay);
    },
  });
  const replayLine = el(
    doc,
    "li",
    { class: "fbh-sending-item fbh-sending-replay", "data-key": "replay", hidden: true },
    [
      replayText,
      previewButton,
      el(doc, "label", { class: "fbh-check fbh-inline" }, [
        replayToggle,
        el(doc, "span", { text: "Leave it out" }),
      ]),
    ],
  );
```

3. In the layout, replace `note,` with `sending,` and delete the `fbh-check` label block (the recording line owns the switch now).
4. Replace `renderNote()` with:

```js
  // Reads what the next report will carry (api.pending(): a host-side answer, so guarded like
  // every other hook) and rebuilds the list — every line but the recording's, which is the same
  // node every time and only has its words and its Preview button updated in place.
  function renderSending() {
    let pending = { screenshot: false, replay: null, console: 0, errors: 0, network: 0, breadcrumbs: 0 };
    if (api.pending) {
      pending = safeCall(api.pending, pending, "pending()") || pending;
    }
    const lines = attachmentLines({
      screenshot: !!screenshot,
      replay: { ready: replayAttached, seconds: pending.replay ? pending.replay.seconds : null },
      images: images.length,
      counts: pending,
    });
    const replay = lines.find((line) => line.key === "replay");
    replayLine.hidden = !replay;
    if (replay) replayText.textContent = replay.text;
    previewButton.hidden = !(replay && pending.replay);
    clear(sending);
    for (const line of lines) {
      if (line.key === "replay") {
        sending.appendChild(replayLine);
        continue;
      }
      sending.appendChild(
        el(doc, "li", { class: "fbh-sending-item", "data-key": line.key, text: line.text }),
      );
    }
  }
```

(`clear` comes from `./dom.js`; add it to that import. `safeCall` already exists in the file.) `renderStrip()`'s call to `renderNote()` (line ~332) and the `replayReady.then` at ~246 become `renderSending()`. In `prepare()`, `replayToggle.checked = false;` stays and add `replayLine.classList.remove("is-off");` after it; `renderSending()` is called by `renderStrip()` already, and once more after the screenshot arrives (the existing `renderStrip()` there covers it).

5. `preview()` is Task 6; for now add a stub so the button's handler is defined:

```js
  // Task 6 replaces this with the real preview dialog.
  function preview() {}
```

6. In `src/panel/styles.js`, after the `.fbh-check` rule add:

```css
.fbh-sending { margin: 0; padding: 0 0 0 16px; font-size: 11.5px; color: var(--fbh-muted); }
.fbh-sending-item { margin: 2px 0; }
.fbh-sending-item[hidden] { display: none; }
.fbh-sending-replay .fbh-check { display: inline-flex; vertical-align: baseline; }
.fbh-sending-replay.is-off .fbh-sending-text { text-decoration: line-through; opacity: 0.7; }
.fbh-link {
padding: 0 4px; border: 0; background: none; cursor: pointer; font: inherit; font-size: 11.5px;
color: var(--fbh-accent); text-decoration: underline;
}
.fbh-link[hidden] { display: none; }
```

and delete `.fbh-note` from the `.fbh-note, .fbh-message, .fbh-row-message` rule (keep the other two).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/form.test.js tests/panel.test.js tests/leak-matrix.test.js`
Expected: PASS. Then `pnpm test` — everything green again (`describeAttachments` has no importer left; grep to be sure: `grep -rn describeAttachments src tests e2e` returns nothing).

- [ ] **Step 5: Lint, format, size, commit**

Run: `pnpm lint && pnpm format:check && pnpm size`
Expected: clean; page load unchanged (the form is on the panel chunk).

```bash
git add src/panel/form.js src/panel/styles.js tests/form.test.js
git commit -m "feat(panel): what will be sent as a list with counts; the recording line never moves"
```

---

### Task 5: The stub hub reports the recording's timestamps; the browser test proves the frozen window and the list

**Files:**
- Modify: `tests/stub-hub.mjs:176-200` (`/_stub/last`)
- Modify: `e2e/panel.spec.js` (the "leaves the recording out" test at ~195; a new test after it; the list assertion in the first submit test)

**Interfaces:**
- Produces: `/_stub/last` answers `replay: { bytes, events, first, last }` where `first`/`last` are the smallest and largest `timestamp` among the parsed events, or `null`.

- [ ] **Step 1: Extend the stub**

In `tests/stub-hub.mjs`, in the `/_stub/last` handler, replace the `events` computation and the `replay:` line:

```js
    let events;
    let first = null;
    let last_ = null;
    try {
      const parsed = JSON.parse(last.replayText || "[]");
      events = parsed.length;
      for (const one of parsed) {
        if (typeof one.timestamp !== "number") continue;
        if (first === null || one.timestamp < first) first = one.timestamp;
        if (last_ === null || one.timestamp > last_) last_ = one.timestamp;
      }
    } catch {
      events = -1;
    }
```

and `replay: { bytes: last.replayText.length, events, first, last: last_ },`.

- [ ] **Step 2: Write the browser tests**

In `e2e/panel.spec.js`, replace the "leaves the recording out when asked" test and add one after it:

```js
test("leaves the recording out when asked, without moving the line", async ({ page, request }) => {
  await ready(page);
  await openWithRecording(page);
  const line = page.locator(".fbh-sending-replay");
  const before = await line.boundingBox();
  const submitBefore = await page.locator("#fbh-submit").boundingBox();
  await page.check("#fbh-no-replay");
  await expect(line).toHaveClass(/is-off/);
  // The same words in the same place: nothing under the switch moved.
  expect(await line.boundingBox()).toEqual(before);
  expect(await page.locator("#fbh-submit").boundingBox()).toEqual(submitBefore);
  await page.fill("#fbh-text", "no recording please");
  await page.click("#fbh-submit");
  await expect(page.locator(".fbh-row").first()).toContainText("no recording please");

  const bundle = await lastBundle(request);
  expect(bundle.parts).not.toContain("replay");
  expect(bundle.report.capture.replay).toBe(false);
});

test("sends the recording from before the panel opened, however long the report takes", async ({
  page,
  request,
}) => {
  await ready(page, { real: "1" });
  // Something to record before the panel opens, then a moment for it to be recorded.
  for (let i = 0; i < 3; i += 1) await page.click("#host-click");
  await page.waitForTimeout(600);
  const openedAt = await page.evaluate(() => Date.now());
  await openWithRecording(page);
  // Writing takes a while, and the page keeps changing meanwhile: none of this may be in the
  // report's recording.
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i += 1) await page.click("#host-click");
  await page.fill("#fbh-text", "written slowly");
  await page.click("#fbh-submit");
  await expect(page.locator(".fbh-row").first()).toContainText("written slowly");

  const bundle = await lastBundle(request);
  expect(bundle.parts).toContain("replay");
  expect(bundle.replay.events).toBeGreaterThan(1);
  expect(bundle.replay.first).toBeLessThan(openedAt);
  // A little slack for the recorder's own emit timing; three seconds later than the click is
  // exactly what must not be there.
  expect(bundle.replay.last).toBeLessThanOrEqual(openedAt + 500);
});
```

Note: `openWithRecording` waits for `.fbh-note` text today; update that helper to wait for the recording line instead: `await expect(page.locator(".fbh-sending-replay")).toBeVisible();`.

In the first submit test (`submits a report and shows it as received (${theme})`), after the panel opens add:

```js
    const sent = page.locator(".fbh-sending li");
    await expect(sent.first()).toHaveText("1 screenshot of this page, taken when you opened the panel");
    await expect(sent.last()).toContainText("The console and network log:");
    await expect(page.locator(".fbh-sending-replay")).toContainText("before you opened the panel");
```

- [ ] **Step 3: Run the browser suite**

Run: `pnpm test:e2e`
Expected: PASS (the old `.fbh-note` locators are gone; if one is left, the failure names it).

- [ ] **Step 4: Commit**

```bash
git add tests/stub-hub.mjs e2e/panel.spec.js
git commit -m "test(e2e): the recording sent is the one from before the panel opened; the list"
```

---

### Task 6: The preview dialog — `src/panel/preview.js`, the player as the third lazy dependency

**Files:**
- Create: `src/panel/preview.js`
- Modify: `src/panel/form.js` (the `preview()` stub from Task 4; `previewMount`; `openPreview` option; `destroy()`), `src/panel/panel.js:97-99` (`annotatorDialog`), `src/panel/styles.js` (preview and replayer rules, the wide-panel rule), `package.json` (dependency), `tools/size.mjs:29`, `tools/build-demo.mjs:39-47`, `demo/demo.js:112-120` (fake player), `types/index.d.ts`
- Test: `tests/preview.test.js` (new), `tests/form.test.js`, `tests/panel.test.js`, `tests/size.test.js` (no change if it iterates `LAZY_DEPENDENCIES`), `e2e/panel.spec.js`

**Interfaces:**
- Consumes: `api.replayEvents()`, `api.loadPlayer` (Task 2).
- Produces: `openPreview({ doc, mount, events, load = () => import("rrweb-player"), onClose = () => {} }): { element, close }`. The dialog is `div.fbh-preview[role=dialog]` with `div.fbh-preview-stage`, `p.fbh-preview-status[role=status]`, `button[data-play]`, `span.fbh-preview-time`, `button[data-preview-close]`. Escape closes it. The form adds `fbh-form-previewing` to its element while it is open (the panel widens, exactly as for `fbh-form-annotating`).

- [ ] **Step 1: Add the dependency**

Run: `pnpm add rrweb-player@^2.1.5`
Expected: `package.json` gains `"rrweb-player": "^2.1.5"` under `dependencies`; the lockfile updates. (The hub already uses 2.1.5; keep the versions aligned.)

- [ ] **Step 2: Write the failing unit tests for the dialog**

Create `tests/preview.test.js`:

```js
/** @vitest-environment jsdom */
// The preview dialog (owner's request, 2026-09-30): plays the recording the report will carry,
// inside the panel, loading the player only when asked. jsdom cannot run rrweb-player, so the
// player here is a stand-in with the same public surface; the real one runs in e2e/panel.spec.js.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPreview } from "../src/panel/preview.js";
import { resetWarnings } from "../src/warn.js";

function fakePlayerModule(calls) {
  class Player {
    constructor({ target, props }) {
      calls.push(["construct", props]);
      target.appendChild(document.createElement("iframe"));
      this.handlers = {};
    }
    addEventListener(name, handler) {
      this.handlers[name] = handler;
    }
    getMetaData() {
      return { startTime: 0, endTime: 103_000, totalTime: 103_000 };
    }
    toggle() {
      calls.push(["toggle"]);
    }
    pause() {
      calls.push(["pause"]);
    }
    $destroy() {
      calls.push(["destroy"]);
    }
  }
  return { Player, calls };
}

const events = [
  { type: 4, timestamp: 1000, data: { href: "http://x/" } },
  { type: 2, timestamp: 1001, data: {} },
];

afterEach(() => {
  document.body.innerHTML = "";
  resetWarnings();
});

describe("openPreview", () => {
  it("mounts the dialog at once, then loads the player and plays the events it was given", async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const calls = [];
    const module = fakePlayerModule(calls);
    const handle = openPreview({ doc: document, mount, events, load: async () => module });
    expect(mount.querySelector(".fbh-preview")).toBe(handle.element);
    expect(mount.querySelector(".fbh-preview-status").textContent).toBe("Loading the player…");
    await vi.waitFor(() => expect(calls[0]?.[0]).toBe("construct"));
    const props = calls[0][1];
    expect(props.events).toEqual(events);
    expect(props.showController).toBe(false);
    expect(props.autoPlay).toBe(true);
    expect(mount.querySelector(".fbh-preview-status").textContent).toBe("");
    expect(mount.querySelector(".fbh-preview-stage iframe")).not.toBe(null);
    handle.close();
  });

  it("Play/Pause toggles the player and follows its state; the time follows the player's clock", async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const calls = [];
    const module = fakePlayerModule(calls);
    let player;
    const OriginalPlayer = module.Player;
    module.Player = class extends OriginalPlayer {
      constructor(opts) {
        super(opts);
        player = this;
      }
    };
    const handle = openPreview({ doc: document, mount, events, load: async () => module });
    await vi.waitFor(() => expect(player).toBeDefined());
    mount.querySelector("[data-play]").click();
    expect(calls.some((c) => c[0] === "toggle")).toBe(true);
    player.handlers["ui-update-player-state"]({ payload: "paused" });
    expect(mount.querySelector("[data-play]").textContent).toBe("Play");
    player.handlers["ui-update-player-state"]({ payload: "playing" });
    expect(mount.querySelector("[data-play]").textContent).toBe("Pause");
    player.handlers["ui-update-current-time"]({ payload: 61_500 });
    expect(mount.querySelector(".fbh-preview-time").textContent).toBe("1:01 / 1:43");
    handle.close();
  });

  it("closes on the button and on Escape, destroying the player and telling the form", async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const calls = [];
    const onClose = vi.fn();
    const handle = openPreview({
      doc: document,
      mount,
      events,
      load: async () => fakePlayerModule(calls),
      onClose,
    });
    await vi.waitFor(() => expect(calls[0]?.[0]).toBe("construct"));
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mount.querySelector(".fbh-preview")).toBe(null);
    expect(calls.map((c) => c[0])).toEqual(["construct", "pause", "destroy"]);
    expect(onClose).toHaveBeenCalledTimes(1);
    // A second close is a no-op.
    handle.close();
    expect(onClose).toHaveBeenCalledTimes(1);

    const again = openPreview({ doc: document, mount, events, load: async () => fakePlayerModule([]) });
    mount.querySelector("[data-preview-close]").click();
    expect(mount.querySelector(".fbh-preview")).toBe(null);
    void again;
  });

  it("says so, and stays open, when the player cannot be loaded", async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const handle = openPreview({
      doc: document,
      mount,
      events,
      load: async () => {
        throw new Error("offline");
      },
    });
    await vi.waitFor(() =>
      expect(mount.querySelector(".fbh-preview-status").textContent).toBe(
        "The player could not be loaded. Close this and try again.",
      ),
    );
    expect(mount.querySelector(".fbh-preview")).not.toBe(null);
    handle.close();
  });

  it("does not attach a player that arrives after the dialog was closed", async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const calls = [];
    let release;
    const handle = openPreview({
      doc: document,
      mount,
      events,
      load: () => new Promise((resolve) => (release = () => resolve(fakePlayerModule(calls)))),
    });
    handle.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/preview.test.js`
Expected: FAIL — cannot find `../src/panel/preview.js`.

- [ ] **Step 4: Write `src/panel/preview.js`**

```js
// The recording's preview (owner's request, 2026-09-30): the drawing dialog's sibling. A nested
// dialog inside the form that loads rrweb-player only now — the third lazily imported dependency,
// beside the recorder and the screenshot module — and plays exactly the events the report would
// carry (mount.js's frozen copy). The player's own controller is switched off: its stylesheet is
// Svelte-scoped and cannot be reproduced inside the shadow root, so the controls here are ours,
// styled like the rest of the panel: Play/Pause, the time, Close. Escape closes, like the
// annotator, and the panel's trap scopes Tab to this dialog while it is open (panel.js).
import { warnOnce } from "../warn.js";
import { el } from "./dom.js";

// "1:01 / 1:43"
export function clock(currentMs, totalMs) {
  const stamp = (ms) => {
    const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return `${stamp(currentMs)} / ${stamp(totalMs)}`;
}

export function openPreview({
  doc,
  mount,
  events,
  load = () => import("rrweb-player"),
  onClose = () => {},
}) {
  let player = null;
  let closed = false;

  const stage = el(doc, "div", { class: "fbh-preview-stage" });
  const status = el(doc, "p", {
    class: "fbh-preview-status",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
    text: "Loading the player…",
  });
  const time = el(doc, "span", { class: "fbh-preview-time", "aria-live": "off" });
  const playButton = el(doc, "button", {
    type: "button",
    class: "fbh-ghost",
    "data-play": true,
    text: "Pause",
    onClick: () => {
      if (player) player.toggle();
    },
  });
  const closeButton = el(doc, "button", {
    type: "button",
    class: "fbh-ghost",
    "data-preview-close": true,
    text: "Close",
    onClick: () => close(),
  });
  const element = el(
    doc,
    "div",
    { class: "fbh-preview", role: "dialog", "aria-label": "Preview of the recording", tabindex: "-1" },
    [stage, status, el(doc, "div", { class: "fbh-preview-actions" }, [playButton, time, closeButton])],
  );

  function onKeydown(event) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    doc.removeEventListener("keydown", onKeydown);
    if (player) {
      try {
        player.pause();
        player.$destroy();
      } catch (err) {
        warnOnce("preview close", err);
      }
      player = null;
    }
    element.remove();
    onClose();
  }

  doc.addEventListener("keydown", onKeydown);
  mount.appendChild(element);
  element.focus();

  (async () => {
    try {
      const module = await load();
      const Player = module.Player || module.default;
      if (typeof Player !== "function") throw new Error("rrweb-player exports no Player");
      if (closed) return;
      // The stage's box decides the player's size; the player scales the recorded viewport to
      // fit it. Fallbacks for an environment with no layout.
      const rect = stage.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width) || 800);
      const height = Math.max(240, Math.floor(rect.height) || Math.round(width * 0.62));
      player = new Player({
        target: stage,
        props: {
          events,
          width,
          height,
          autoPlay: true,
          showController: false,
          skipInactive: true,
        },
      });
      const total = () => {
        try {
          return player.getMetaData().totalTime;
        } catch {
          return 0;
        }
      };
      player.addEventListener("ui-update-current-time", (event) => {
        time.textContent = clock(event && event.payload, total());
      });
      player.addEventListener("ui-update-player-state", (event) => {
        playButton.textContent = event && event.payload === "playing" ? "Pause" : "Play";
      });
      time.textContent = clock(0, total());
      status.textContent = "";
    } catch (err) {
      warnOnce("preview", err);
      if (!closed) status.textContent = "The player could not be loaded. Close this and try again.";
    }
  })();

  return { element, close };
}
```

- [ ] **Step 5: Run the preview tests**

Run: `pnpm exec vitest run tests/preview.test.js`
Expected: PASS.

- [ ] **Step 6: Wire the form, the panel's nested-dialog hook, the styles**

In `src/panel/form.js`:

1. Import: `import { openPreview as defaultOpenPreview } from "./preview.js";`
2. `createForm` options: add `openPreview = defaultOpenPreview,` after `openAnnotator = defaultOpenAnnotator,`.
3. State: after `let activeAnnotator = null;` add `let activePreview = null;`.
4. After `const annotatorMount = ...` add `const previewMount = el(doc, "div", { class: "fbh-preview-mount", hidden: true });` and put `previewMount,` in the layout right after `annotatorMount,`.
5. Replace the Task 4 stub:

```js
  // Opens the recording's preview in the form, the panel widened as for drawing; while it is
  // open the strip and Send are dimmed and inert like the annotator does it. The player gets the
  // frozen events the report would carry (api.replayEvents()), never the live recording.
  function preview() {
    if (activePreview || busy) return;
    const events = api.replayEvents ? safeCall(api.replayEvents, [], "replayEvents()") : [];
    if (!Array.isArray(events) || !events.length) {
      say("Nothing has been recorded yet.");
      return;
    }
    element.classList.add("fbh-form-previewing");
    previewMount.hidden = false;
    activePreview = openPreview({
      doc,
      mount: previewMount,
      events,
      ...(api.loadPlayer ? { load: api.loadPlayer } : {}),
      onClose: () => {
        activePreview = null;
        previewMount.hidden = true;
        element.classList.remove("fbh-form-previewing");
        if (!destroyed) previewButton.focus();
      },
    });
  }
```

6. In `destroy()`, after `if (activeAnnotator) activeAnnotator.close();` add `if (activePreview) activePreview.close();`.

In `src/panel/panel.js`, rename `annotatorDialog()` to `nestedDialog()` (three call sites) and make it `return shadow.querySelector(".fbh-annotator, .fbh-preview");`, updating its comment to name both dialogs.

In `src/panel/styles.js`:

1. The wide-panel rule becomes `.fbh-panel:has(.fbh-form-annotating), .fbh-panel:has(.fbh-form-previewing) { width: min(96vw, 1800px); max-height: 96vh; }` (if PR #5 has not merged yet, add the rule as written in that PR's `styles.js` together with this selector).
2. Extend `.fbh-form-annotating .fbh-strip, .fbh-form-annotating .fbh-submit-row { … }` with `.fbh-form-previewing .fbh-strip, .fbh-form-previewing .fbh-submit-row`.
3. Add:

```css
.fbh-preview-mount[hidden] { display: none; }
.fbh-preview {
display: flex; flex-direction: column; gap: 8px;
padding: 10px; border: 1px solid var(--fbh-border); border-radius: 10px; background: var(--fbh-bg);
}
.fbh-preview-stage {
height: calc(96vh - 230px); min-height: 240px; overflow: hidden;
display: flex; align-items: center; justify-content: center; background: var(--fbh-panel);
}
.fbh-preview-status { margin: 0; font-size: 11.5px; color: var(--fbh-muted); }
.fbh-preview-status:empty { display: none; }
.fbh-preview-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.fbh-preview-time { font-size: 11.5px; color: var(--fbh-muted); font-variant-numeric: tabular-nums; }
/* rrweb's replayer inside the shadow root: its own stylesheet is not loaded (the player's is
   Svelte-scoped), so the few rules the replayer needs — the wrapper, the frame, the cursor —
   are here, by rrweb's class names, from rrweb-player/dist/style.css. */
.rr-player { position: relative; background: #fff; border-radius: 5px; }
.rr-player__frame { overflow: hidden; }
.replayer-wrapper { position: relative; transform-origin: top left; }
.replayer-wrapper > iframe { border: none; }
.replayer-mouse {
position: absolute; width: 20px; height: 20px; transition: left 0.05s linear, top 0.05s linear;
background-size: contain; background-repeat: no-repeat; border-color: transparent;
background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'><path d='M3 2 L3 16 L7 12 L10 18 L12 17 L9 11 L15 11 Z' fill='%23000' stroke='%23fff' stroke-width='1.2'/></svg>");
}
.replayer-mouse::after {
content: ""; display: inline-block; width: 20px; height: 20px; background: rgb(73, 80, 246);
border-radius: 100%; transform: translate(-50%, -50%); opacity: 0.3;
}
.replayer-mouse.active::after { animation: fbh-click 0.2s ease-in-out 1; }
.replayer-mouse-tail { position: absolute; pointer-events: none; }
@keyframes fbh-click { 0% { opacity: 0.3; width: 20px; height: 20px; } 50% { opacity: 0.5; width: 10px; height: 10px; } }
```

- [ ] **Step 7: Form and panel unit tests for the wiring**

Add to `tests/form.test.js`, in the "What will be sent" describe:

```js
  it("Preview opens the dialog with the frozen events, widens the form, and hands focus back on close", async () => {
    let closeIt;
    const openPreview = vi.fn(({ mount, events, onClose }) => {
      const element = document.createElement("div");
      element.className = "fbh-preview";
      mount.appendChild(element);
      closeIt = () => {
        element.remove();
        onClose();
      };
      expect(events).toEqual([{ type: 2, timestamp: 1000, data: {} }]);
      return { element, close: closeIt };
    });
    const { form } = setup({ openPreview });
    await form.prepare();
    document.querySelector("[data-preview]").click();
    expect(openPreview).toHaveBeenCalledTimes(1);
    expect(form.element.classList.contains("fbh-form-previewing")).toBe(true);
    expect(document.querySelector(".fbh-preview-mount").hidden).toBe(false);
    // A second press while it is open does nothing.
    document.querySelector("[data-preview]").click();
    expect(openPreview).toHaveBeenCalledTimes(1);
    closeIt();
    expect(form.element.classList.contains("fbh-form-previewing")).toBe(false);
    expect(document.querySelector(".fbh-preview-mount").hidden).toBe(true);
    expect(document.activeElement).toBe(document.querySelector("[data-preview]"));
    form.destroy();
  });

  it("says so instead of opening a preview when nothing was recorded", async () => {
    const openPreview = vi.fn();
    const { form } = setup({ openPreview, api: { replayEvents: () => [] } });
    await form.prepare();
    document.querySelector("[data-preview]").hidden = false;
    document.querySelector("[data-preview]").click();
    expect(openPreview).not.toHaveBeenCalled();
    expect(document.querySelector(".fbh-message").textContent).toBe("Nothing has been recorded yet.");
    form.destroy();
  });
```

`setup()` in that file must pass `openPreview` through to `createForm` the way it passes `openAnnotator` (add it to its destructured options and to the `createForm` call).

Add to `tests/panel.test.js`, next to "scopes Tab to the nested dialog instead of the rest of the panel", a copy of that test for a `.fbh-preview` element (build a `div.fbh-preview` with two buttons inside the panel's body, focus the last, dispatch Tab on the overlay, expect the first of the two), and for Escape: dispatch Escape on the overlay while `.fbh-preview` is present, expect `panel.isOpen()` still true.

Run: `pnpm exec vitest run tests/form.test.js tests/panel.test.js tests/preview.test.js`
Expected: PASS.

- [ ] **Step 8: The size tool, the demo build, the demo fake**

`tools/size.mjs`: `export const LAZY_DEPENDENCIES = ["@rrweb/record", "modern-screenshot", "rrweb-player"];` and update the comment ("the player when a preview is asked for").

Run: `pnpm size`
Expected: page load unchanged (≈ 11.6–11.7 KB gzipped), a new on-demand chunk for the player. If the "keeps them lazy" test in `tests/size.test.js` fails because `measure()` collects imports only from the entry chunk, extend `measure()` in `tools/size.mjs` to gather `imports` from every output chunk (`Object.values(outputs).flatMap((o) => o.imports)`), de-duplicated by `path`; the panel chunk is the one that `import()`s the player.

`tools/build-demo.mjs`: after the `modern-screenshot` line add `else if (inputs.some((one) => one.includes("node_modules/rrweb-player"))) manifest.player = url;` (before the `src/panel/` line: the player's chunk contains no panel source, but keep the order explicit), and the guard becomes `if (!manifest.recorder || !manifest.screenshot || !manifest.player || !manifest.panel)` with the message naming "three lazy dependencies".

`demo/demo.js` fakes: add to `fakes`:

```js
  // The player, for the default mode: shows that the preview was asked for and how many events
  // it got, instead of playing them.
  loadPlayer: async () => ({
    Player: class {
      constructor({ target, props }) {
        const note = document.createElement("p");
        note.id = "fake-player";
        note.textContent = `fake player: ${props.events.length} events`;
        target.appendChild(note);
      }
      addEventListener() {}
      getMetaData() {
        return { startTime: 0, endTime: 0, totalTime: 0 };
      }
      toggle() {}
      pause() {}
      $destroy() {}
    },
  }),
```

(`mountFeedback`'s second argument already receives `useFakes ? fakes : {}`, so `loadPlayer` reaches `deps.loadPlayer`.)

`types/index.d.ts`: in `PanelApi` add

```ts
  /** What the next report will carry, with counts; the panel's "What will be sent" list reads it. */
  pending(): {
    screenshot: boolean;
    replay: { from: number; to: number; seconds: number } | null;
    console: number;
    errors: number;
    network: number;
    breadcrumbs: number;
  };
  /** The recording's events as the report would carry them: frozen at open(), the live ones headless. */
  replayEvents(): unknown[];
  /** `MountDeps.loadPlayer`, passed through for the preview. */
  loadPlayer?: () => Promise<unknown>;
```

and in `MountDeps` add `loadPlayer?: () => Promise<unknown>;` after `loadScreenshot`.

Run: `pnpm test && pnpm lint && pnpm format:check && pnpm size`
Expected: all clean.

- [ ] **Step 9: Browser tests**

In `e2e/panel.spec.js`:

1. The test "fetches each of the three only when it is needed" becomes "…each of the four…": destructure `player` from `chunks()` too, add `player` to the `[recorder, screenshot, panel]` lists, and after the screenshot assertions add:

```js
    // The player only when a preview is asked for.
    expect(seen.has(player)).toBe(false);
    await page.click("[data-preview]");
    await expect(page.locator(".fbh-preview")).toBeVisible();
    await expect(page.locator(".fbh-preview-stage iframe")).toBeVisible({ timeout: 10_000 });
    expect(seen.has(player)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator(".fbh-preview")).toBeHidden();
```

(This part needs the recording on: it lives in the second half of that test, after `await ready(page, { real: "1" })`, after opening the panel there — add `await page.click("#open-feedback")` and `await expect(page.locator(".fbh-sending-replay")).toBeVisible()` before it.)

2. A new test after "deletes a report…" (default mode, fake player):

```js
test("previews the recording almost full screen, and puts everything back on Close", async ({ page }) => {
  await ready(page);
  await openWithRecording(page);
  const panelWidth = () =>
    page.evaluate(
      () =>
        document.getElementById("fbh-host").shadowRoot.querySelector(".fbh-panel")
          .getBoundingClientRect().width,
    );
  await page.click("[data-preview]");
  await expect(page.locator(".fbh-preview")).toBeVisible();
  await expect(page.locator("#fake-player")).toContainText("fake player:");
  expect(await panelWidth()).toBeGreaterThanOrEqual(page.viewportSize().width * 0.9);
  // Send is inert while the preview is open.
  expect(await page.locator("#fbh-submit").evaluate((n) => getComputedStyle(n).pointerEvents)).toBe("none");
  await page.click("[data-preview-close]");
  await expect(page.locator(".fbh-preview")).toBeHidden();
  expect(await panelWidth()).toBeLessThanOrEqual(480);
  expect(await focusSpot(page)).toEqual({ outer: "host", inner: "fbh-link" });
});
```

Run: `pnpm test:e2e`
Expected: PASS, every test.

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-lock.yaml src/panel/preview.js src/panel/form.js src/panel/panel.js src/panel/styles.js tools/size.mjs tools/build-demo.mjs demo/demo.js types/index.d.ts tests/preview.test.js tests/form.test.js tests/panel.test.js e2e/panel.spec.js
git commit -m "feat(panel): preview the recording in the panel, with rrweb-player loaded on demand"
```

---

### Task 7: The list refreshes when the tab comes back into view

**Files:**
- Modify: `src/panel/list.js` (`start()`/`stop()` at ~445–455)
- Test: `tests/list.test.js`

**Interfaces:**
- Produces: while `start()`ed, a `visibilitychange` on the document that leaves it `visible` triggers `refresh()`; `stop()` removes the listener.

- [ ] **Step 1: Write the failing test**

Add to `tests/list.test.js` inside `describe("createList")`:

```js
  it("refreshes when the tab becomes visible again, while started, and not after stop", async () => {
    const { list, api } = setup();
    list.start();
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new window.Event("visibilitychange"));
    expect(api.list).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new window.Event("visibilitychange"));
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    list.stop();
    document.dispatchEvent(new window.Event("visibilitychange"));
    expect(api.list).toHaveBeenCalledTimes(2);
    list.destroy();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tests/list.test.js -t "visible"`
Expected: FAIL — `api.list` called once, not twice.

- [ ] **Step 3: Implement**

In `src/panel/list.js`, replace `start()` and `stop()`:

```js
  // A tab that was in the background comes back: ask at once rather than at the next poll, so
  // a status that changed meanwhile (the issue closed, an answer posted) is what the reporter
  // sees on return, not up to thirty seconds later.
  function onVisibility() {
    if (timer !== null && doc.visibilityState === "visible") refresh();
  }

  function start() {
    stop();
    refresh();
    timer = setInterval(refresh, POLL_MS);
    doc.addEventListener("visibilitychange", onVisibility);
  }

  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    doc.removeEventListener("visibilitychange", onVisibility);
    note.textContent = "";
  }
```

(`note.textContent = "";` exists only once PR #5 is merged; leave the line out if `note` is not in this file.)

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/list.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel/list.js tests/list.test.js
git commit -m "feat(list): refresh when the tab becomes visible again"
```

---

### Task 8: Version, changelog, README, and the branch's checks

**Files:**
- Modify: `package.json` (`"version": "0.3.0"`), `src/version.js` (`CLIENT_VERSION = "0.3.0"`), `tests/version.test.js` (the literal client string), `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Bump and write the changelog**

`CHANGELOG.md`, above the newest entry:

```markdown
## 0.3.0 — 2026-09-30

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
```

`README.md`: in "Mount it", where `open()` is described, add a paragraph on the frozen recording; in "Privacy", replace "a recording of the last minute or two" wording with "the minute or two before the panel opened"; in "Size", name the third lazy dependency and re-quote the numbers `pnpm size` prints; in "Develop", say `?real=1` also runs the real player.

- [ ] **Step 2: Every check**

Run: `pnpm test && pnpm lint && pnpm format:check && pnpm size && pnpm test:e2e`
Expected: all green; note the page-load number for the pull request.

- [ ] **Step 3: Commit and push**

```bash
git add package.json src/version.js tests/version.test.js CHANGELOG.md README.md
git commit -m "chore: v0.3.0 — the recording window, the sending list with preview, the visibility refresh"
git push -u origin feat/recording-window-and-preview
```

Open the pull request with a "Verification" section listing the commands above and their counts, and the merge order: after [PR #5](https://github.com/amikob-inc/feedback-client/pull/5) (rebase first), then tag `v0.3.0`, then bump cad-dashboard.

---

### Task 9 (feedback-hub): a closed issue's state is re-read every two minutes

**Files (in `amikob-inc/feedback-hub`, branch `feat/closed-issue-ttl` off `main`, its own pull request):**
- Modify: `service/src/listing.ts:52-54` (`DEFAULT_CLOSED_ISSUE_TTL_MS`)
- Modify: `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-16-mission-16-feedback-hub-design.md` §6.7 (wherever "ten minutes" / "600 000" describes the closed-issue cache: `grep -rn "ten minutes\|10 minutes\|600_000\|600000" README.md CLAUDE.md docs service/src`)
- Test: `service/tests/listing.test.ts`

**Interfaces:**
- Produces: `export const DEFAULT_CLOSED_ISSUE_TTL_MS = 120_000;` (was a module-private `600_000`). `GitHubStateCache`'s constructor default uses it; the two explicit `600_000` arguments in the existing tests stay as they are (they test the mechanism with a chosen value).

- [ ] **Step 1: Write the failing test**

In `service/tests/listing.test.ts`, import `DEFAULT_CLOSED_ISSUE_TTL_MS` from `../src/listing.js` and add inside `describe("listReports")`:

```ts
  it("re-reads a closed issue after two minutes by default, so a reopened issue is not 'Fixed' for ten", async () => {
    expect(DEFAULT_CLOSED_ISSUE_TTL_MS).toBe(120_000);
    const reports = new Reports(new MemoryStore());
    const github = new FakeGitHub();
    let clock = now.getTime();
    const cache = new GitHubStateCache(github, 30_000, undefined, () => clock);
    await seed(reports, "1".repeat(32));
    await reports.writeVerdict("cad", "1".repeat(32), { verdict: "filed", issueNumber: 42 }, now.toISOString(), "r");
    github.issues.set(`${REPO}#42`, issue({ number: 42, state: "closed", stateReason: "completed" }));
    const first = await listReports({ reports, cache }, "cad", reporter(), { now: new Date(clock) });
    expect(first.items[0]?.status).toBe("fixed");

    github.issues.set(`${REPO}#42`, issue({ number: 42, state: "open", stateReason: "reopened" }));
    clock += 119_000;
    const stillCached = await listReports({ reports, cache }, "cad", reporter(), { now: new Date(clock) });
    expect(stillCached.items[0]?.status).toBe("fixed");
    clock += 2_000;
    const reread = await listReports({ reports, cache }, "cad", reporter(), { now: new Date(clock) });
    expect(reread.items[0]?.status).toBe("filed");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `service/`): `pnpm exec vitest run tests/listing.test.ts -t "two minutes"`
Expected: FAIL — `DEFAULT_CLOSED_ISSUE_TTL_MS` is not exported / is `600000`.

- [ ] **Step 3: Implement**

In `service/src/listing.ts` replace the constant and its comment:

```ts
// A closed issue rarely changes again, so it is cached longer than an open one — but not so long
// that a reopened issue shows "Fixed" for ten minutes (owner, 2026-09-30): two minutes, against
// thirty seconds for an open one. This is the default when a caller doesn't pass its own.
export const DEFAULT_CLOSED_ISSUE_TTL_MS = 120_000;
```

Update every prose mention found by the grep in Step 0's file list ("ten minutes" → "two minutes").

- [ ] **Step 4: Run every check**

Run (from `service/`): `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`
Expected: clean; 14 files, one more test.

- [ ] **Step 5: Commit, push, open the pull request**

```bash
git add service/src/listing.ts service/tests/listing.test.ts README.md CLAUDE.md docs
git commit -m "feat(listing): a closed issue's state is re-read every two minutes, not ten"
git push -u origin feat/closed-issue-ttl
```

The pull request's description says why (a reopened issue showed "Fixed" for up to ten minutes) and that merging deploys it.

---

## Self-review

**Spec coverage.** (1a) list with counts — Tasks 3, 4; how many screenshots — the "1 screenshot" line and the images line, Task 3; preview on request — Task 6; the recording covers the time before the panel opened — Tasks 1, 2, proven in Task 5. (2) no jump — Task 4 (one persistent node, a class, same words) and the e2e bounding-box assertion in Task 5. (3) status follows the issue — Task 9 (the two-minute closed cache) and Task 7 (refresh on return); the thirty-second open-issue cache and the thirty-second poll already exist.

**Placeholders.** None: every step has its code. The two "if it fails" notes (the `DecompressionStream` alternative in Task 2, the `measure()` extension in Task 6) each give the exact replacement.

**Type consistency.** `snapshot()`/`replayWindow` (Task 1) are what `recordingSource()`/`pending()` (Task 2) call; `pending()`'s shape `{ screenshot, replay: { from, to, seconds } | null, console, errors, network, breadcrumbs }` is what Task 4's `renderSending` reads (`pending.replay.seconds`, `counts: pending`) and what `types/index.d.ts` declares in Task 6; `attachmentLines`' `replay: { ready, seconds }` (Task 3) is what Task 4 passes; `openPreview`'s `{ doc, mount, events, load, onClose }` and its `{ element, close }` (Task 6) are what the form's `preview()` and the form test's fake use; `nestedDialog()` in `panel.js` matches the `.fbh-preview` class the dialog carries; `DEFAULT_CLOSED_ISSUE_TTL_MS` is exported and imported by the same name.
