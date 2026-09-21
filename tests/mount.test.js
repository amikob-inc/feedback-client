/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountFeedback, pageContext, resolveButton } from "../src/mount.js";
import { resetWarnings } from "../src/warn.js";

const run = (fn) => fn();

// vitest's jsdom environment gives `Blob`/`FormData`/`File` jsdom's own (incomplete) classes —
// deliberately: only `fetch`, `Response`, `Headers`, `URL` and friends are re-pointed at Node's
// real implementations (vitest's index.D4dXTzh9.js, `populateGlobal` + the jsdom environment's
// `setup()`). jsdom 27's Blob has no `.text()`, `.arrayBuffer()` or `.stream()` at all, so
// `buildBundle`'s real `new Blob(...)`/`new FormData()` (src/bundle.js, unmodified, correct, and
// exactly what a real browser's Blob supports) produce parts this test cannot read back, and
// `gzip()` (src/capture/gzip.js, also unmodified) cannot compress at all under this environment,
// silently degrading to `null` on every call. Neither is a defect in mount.js or in the modules it
// composes; both are this test's own reading tool being incomplete. The fix stays entirely in this
// test file: give jsdom's Blob the three missing methods, implemented through the one bridge
// vitest itself keeps working for exactly this purpose — `URL.createObjectURL` (patched to convert
// a jsdom Blob to a real one) plus the real `fetch`.
function polyfillJsdomBlob() {
  const proto = Blob.prototype;
  if (typeof proto.arrayBuffer === "function") return; // a future jsdom/vitest pairing may fix this
  proto.arrayBuffer = async function () {
    const url = URL.createObjectURL(this);
    try {
      return await (await fetch(url)).arrayBuffer();
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  proto.text = async function () {
    return new TextDecoder().decode(await this.arrayBuffer());
  };
  proto.stream = function () {
    const blob = this;
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
        controller.close();
      },
    });
  };
}
polyfillJsdomBlob();

function fakeTransport(overrides = {}) {
  return {
    submit: vi.fn(async () => ({ id: "report-1" })),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    reply: vi.fn(async () => ({
      replies: [],
      status: "triaging",
      label: "Received, being looked at",
    })),
    retry: vi.fn(async () => ({
      id: "report-1",
      status: "triaging",
      label: "Received, being looked at",
    })),
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
    expect(resolveButton(document.getElementById("b"), document)).toBe(
      document.getElementById("b"),
    );
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

  // Standing rule 5: "off" must not merely be inert, it must be free. Nothing that touches the
  // live page (a wrapped fetch, a wrapped console method) may happen at all.
  it("installs no buffers and starts no replay when the hub is off", () => {
    const originalFetch = window.fetch;
    const originalConsoleError = console.error;
    const handle = mountFeedback({ app: "cad" });
    expect(window.fetch).toBe(originalFetch);
    expect(console.error).toBe(originalConsoleError);
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
    document
      .getElementById("save")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    console.error("TypeError: nope");
    const result = await handle.submit({
      type: "Bug",
      text: "  the popup does not open  ",
      images: [],
    });
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
    // A submit that would once have carried a gzipped copy of the page carries none: the `dom`
    // part was removed on 2026-09-21, and what is left is still a report the hub accepts (its
    // only required part is `report`; every attachment is optional — service/src/intake.ts).
    expect(form.get("dom")).toBe(null);
    expect([...form.keys()]).toEqual(["report"]);
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
    const { handle, transport } = mount(
      { capture: { replay: false, screenshot: true } },
      { loadScreenshot },
    );
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
    // startReplay's own `load()` is itself async (mirroring `() => import("@rrweb/record")`), so
    // even with `schedule: run` making the *scheduling* synchronous, `record()` only runs once
    // that promise settles — at least one microtask tick after mount() returns. submit() calls
    // replayPart() synchronously into `serializeReplay(replay.segments)` with no await of its own
    // before that point, so calling submit() in the same synchronous turn as mount() always finds
    // an empty segments buffer (serializeReplay's own `count() === 0` short-circuit), whatever the
    // recorder eventually captures. A `setTimeout` tick (a full microtask drain, not a guess at
    // how many ticks `await load()` needs) is what makes "it already started recording" true
    // before submit is called — the same thing a real reporter waiting a moment to type a
    // description gets for free.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await handle.submit({ text: "with" });
    const withReplay = transport.submit.mock.calls[0][0].get("replay");
    expect(withReplay.type).toBe("application/gzip");
    await handle.submit({ text: "without", includeReplay: false });
    expect(transport.submit.mock.calls[1][0].get("replay")).toBe(null);
    handle.destroy();
  });

  // The library sends no copy of the reporter's page at all (removed 2026-09-21, see the plan's
  // note): this pins that, so a future change cannot quietly start attaching one again.
  it("sends no copy of the page", async () => {
    const { handle, transport } = mount();
    await expect(handle.submit({ text: "no page copy" })).resolves.toMatchObject({
      id: "report-1",
    });
    const sent = transport.submit.mock.calls[0][0];
    expect(sent.get("dom")).toBe(null);
    expect([...sent.keys()].some((k) => /dom|html|snapshot/i.test(k))).toBe(false);
    handle.destroy();
  });

  // A hook may return something that is not a string. Catching a throw is not enough: an object
  // that serialises badly would reach JSON.stringify inside the bundle builder and break the
  // caller's submit() rather than the library's own error contract.
  it("survives a section() that returns an unserialisable object", async () => {
    const circular = { name: "browse" };
    circular.self = circular;
    const { handle, transport } = mount({ section: () => circular });
    await expect(handle.submit({ text: "circular section" })).resolves.toMatchObject({
      id: "report-1",
    });
    const report = JSON.parse(await transport.submit.mock.calls[0][0].get("report").text());
    expect(typeof report.page.view).toBe("string");
    handle.destroy();
  });
});

// The panel's "what will be sent" note (src/panel/form.js) needs a real answer to "will a
// recording actually be attached", not the static capture.replay flag it used to read — that flag
// stays true even where rrweb never starts. `replayReady` on the internal api handed to a panel
// factory is that answer, settled once (see src/capture/replay.js's own `ready`), never before.
describe("replayReady (the panel's honest answer about the recording)", () => {
  function mountWithPanel(options, deps) {
    let capturedApi = null;
    const { handle, transport } = mount(options, {
      ...deps,
      createPanel: ({ api }) => {
        capturedApi = api;
        return { open() {}, close() {}, destroy() {} };
      },
    });
    handle.open(); // ensurePanel() only builds the panel, and its api, once open() is called
    return { handle, transport, api: () => capturedApi };
  }

  it("resolves false with no recorder at all when capture.replay is off", async () => {
    const { handle, api } = mountWithPanel({ capture: { replay: false, screenshot: false } });
    await expect(api().replayReady).resolves.toBe(false);
    handle.destroy();
  });

  it("resolves true once the recorder actually starts, not merely because the flag is on", async () => {
    const loadRecorder = async () => ({
      record(options) {
        options.emit({ type: 2, data: { x: 1 } }, true);
        return () => {};
      },
    });
    const { handle, api } = mountWithPanel(
      { capture: { replay: true, screenshot: false } },
      { loadRecorder, schedule: run },
    );
    await expect(api().replayReady).resolves.toBe(true);
    handle.destroy();
  });

  it("resolves false when the recorder fails to load, so the note never promises one", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loadRecorder = async () => {
      throw new Error("blocked");
    };
    const { handle, api } = mountWithPanel(
      { capture: { replay: true, screenshot: false } },
      { loadRecorder, schedule: run },
    );
    await expect(api().replayReady).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
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

  // Standing rule 1: onSummary is the app's own callback and can throw; list() must still
  // resolve with the page it fetched. Removing the safeCall wrapper in publishSummary makes this
  // reject instead of resolve.
  it("does not let a throwing onSummary stop list() from resolving", async () => {
    const onSummary = () => {
      throw new Error("boom");
    };
    const items = [{ id: "q", status: "needs_reply", verdict: { receivedAt: "t1" } }];
    const transport = fakeTransport({ list: vi.fn(async () => ({ items, nextCursor: null })) });
    const { handle } = mount({ onSummary }, { transport });
    await expect(handle.list()).resolves.toEqual({ items, nextCursor: null });
    handle.destroy();
  });
});

describe("standing rule 1: app hooks can never take submit down", () => {
  it("survives a throwing user(), section() and theme()", async () => {
    const { handle, transport } = mount({
      user: () => {
        throw new Error("boom");
      },
      section: () => {
        throw new Error("boom");
      },
      theme: () => {
        throw new Error("boom");
      },
    });
    const result = await handle.submit({ text: "still works" });
    expect(result.id).toBe("report-1");
    const report = JSON.parse(await transport.submit.mock.calls[0][0].get("report").text());
    expect(report.reporter).toBe(null);
    // section() throws, so defaultSection falls back to the app's own view lookup with "" and
    // lands on the catch-all last entry.
    expect(report.section).toBe("General");
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

  // Standing rule 3, in so many words: safe to call twice, safe before open() was ever used.
  it("is safe to call twice and safe to call before open() was ever used", () => {
    const { handle } = mount();
    expect(() => {
      handle.destroy();
      handle.destroy();
    }).not.toThrow();
  });
});
