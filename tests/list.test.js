/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_MS, createList, renderRow } from "../src/panel/list.js";
import { normalizeOptions } from "../src/options.js";
import { labelContext, statusLabel } from "../src/status.js";
import { resetWarnings } from "../src/warn.js";

// Not `new URL("../fixtures/...", import.meta.url)`: under the jsdom environment Vite recognises
// that literal pattern as its own build-time "asset URL" syntax and rewrites it to
// `http://localhost:3000/fixtures/...` instead of leaving it as a runtime file:// resolution —
// confirmed by hand (the literal form throws `TypeError: The URL must be of scheme file` the
// instant it reaches readFileSync; splitting the two calls, as here, does not trigger the
// rewrite and resolves to the real path on disk). The plain-Node tests (e.g. tests/status.test.js)
// never hit this because they do not opt into the jsdom environment.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../fixtures/status-cases.json"), "utf8"));
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
    reply: vi.fn(async () => ({
      replies: [{ at: "t", by: "me", text: "more" }],
      status: "triaging",
      label: "Received, being looked at",
    })),
    retry: vi.fn(async () => ({
      id: "r1",
      status: "triaging",
      label: "Received, being looked at",
    })),
    markRead: vi.fn(),
    ...apiOverrides,
  };
  const list = createList({ api, options, doc: document, now });
  document.body.appendChild(list.element);
  return { api, list };
}

beforeEach(() => {
  document.body.innerHTML = "";
  resetWarnings();
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
        item({
          id: one.name,
          status: one.status,
          label: statusLabel(one.status, ctx),
          verdict: one.input.verdict,
        }),
        {},
        { me: "me", now: now() },
      );
      expect(`${one.name}: ${row.querySelector(".fbh-pill").textContent}`).toBe(
        `${one.name}: ${one.label}`,
      );
    }
  });

  it("falls back to its own label when the hub sent none (an optimistic row)", () => {
    const row = renderRow(document, item({ label: undefined }), {}, { me: "me", now: now() });
    expect(row.querySelector(".fbh-pill").textContent).toBe("Received, being looked at");
  });

  it("shows the answer, the questions with a reply box, and the reason", () => {
    const answered = renderRow(
      document,
      item({
        status: "answered",
        label: "Answered",
        verdict: { verdict: "answered", answer: "Click Export images.", receivedAt: "t" },
      }),
      {},
      { me: "me", now: now() },
    );
    expect(answered.querySelector(".fbh-answer").textContent).toBe("Click Export images.");

    const asked = renderRow(
      document,
      item({
        status: "needs_reply",
        label: "Needs your reply",
        verdict: {
          verdict: "needs_info",
          questions: ["Which SKU?", "Which browser?"],
          receivedAt: "t",
        },
      }),
      {},
      { me: "me", now: now() },
    );
    expect([...asked.querySelectorAll(".fbh-questions li")].map((li) => li.textContent)).toEqual([
      "Which SKU?",
      "Which browser?",
    ]);
    expect(asked.querySelector("[data-reply]")).not.toBe(null);
    expect(asked.querySelector("[data-reply]").getAttribute("aria-label")).toBe("Your reply");

    const refused = renderRow(
      document,
      item({
        status: "not_filed",
        label: "Not filed",
        verdict: { verdict: "unusable", reason: "There is no description.", receivedAt: "t" },
      }),
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
        pullRequest: {
          number: 9,
          url: "https://github.com/a/b/pull/9",
          state: "open",
          merged: false,
        },
        progress: "Reproduced it; the id is null after the save.",
      }),
      {},
      { me: "me", now: now() },
    );
    expect(row.querySelector("a[data-issue]").href).toBe("https://github.com/a/b/issues/7");
    expect(row.querySelector("a[data-issue]").textContent).toBe("Issue #7");
    expect(row.querySelector("a[data-pr]").textContent).toBe("Pull request #9");
    expect(row.querySelector(".fbh-progress").textContent).toBe(
      "Reproduced it; the id is null after the save.",
    );
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
    const theirs = renderRow(
      document,
      item({ reporter: { id: "other", name: "Sam" } }),
      {},
      { me: "me", now: now() },
    );
    expect(theirs.querySelector(".fbh-who").textContent).toBe("Sam");
  });

  it("shows the replies already on the report", () => {
    const row = renderRow(
      document,
      item({
        replies: [{ at: "2026-09-21T11:50:00.000Z", by: "me", text: "It is the batch view." }],
      }),
      {},
      { me: "me", now: now() },
    );
    expect(row.querySelector(".fbh-replies li").textContent).toContain("It is the batch view.");
  });

  // --- states from the brief's list beyond the reference snippet ---

  it("handles an empty list of replies, a list of one report, and a very long list", () => {
    const oneRow = renderRow(document, item(), {}, { me: "me", now: now() });
    expect(oneRow.querySelectorAll(".fbh-replies").length).toBe(0);

    const many = Array.from({ length: 250 }, (_, i) =>
      item({ id: `r${i}`, at: "2026-09-21T11:45:00.000Z" }),
    );
    const ul = document.createElement("ul");
    for (const one of many) ul.appendChild(renderRow(document, one, {}, { me: "me", now: now() }));
    expect(ul.querySelectorAll(".fbh-row").length).toBe(250);
  });

  it("renders a one-character report and a 5000-character report without truncating oddly", () => {
    const short = renderRow(document, item({ text: "x" }), {}, { me: "me", now: now() });
    expect(short.querySelector(".fbh-row-text").textContent).toBe("x");

    const long = "y".repeat(5000);
    const bigRow = renderRow(document, item({ text: long }), {}, { me: "me", now: now() });
    // firstLine() truncates a single long line to 120 chars + an ellipsis (src/panel/dom.js).
    expect(bigRow.querySelector(".fbh-row-text").textContent.length).toBe(121);
    expect(bigRow.querySelector(".fbh-row-text").textContent.endsWith("…")).toBe(true);
  });

  it("never turns hostile text from the hub into markup (no innerHTML anywhere in the source)", () => {
    // Matches actual usage (`.innerHTML =`, `.innerHTML(`), not the word itself: dom.js's own
    // top comment (the house style this file follows) says "never with innerHTML" in prose, and
    // this file's own header does the same — a documentation mention is not a violation.
    const src = readFileSync(join(here, "../src/panel/list.js"), "utf8");
    expect(src).not.toMatch(/\.innerHTML\b/);

    const hostile = "<img src=x onerror=alert(1)><script>window.pwned = true;</script>";
    const row = renderRow(
      document,
      item({
        text: hostile,
        reporter: { id: "other", name: hostile },
        status: "answered",
        verdict: { verdict: "answered", answer: hostile, receivedAt: "t" },
        progress: hostile,
      }),
      {},
      { me: "me", now: now() },
    );
    expect(row.querySelector("img")).toBe(null);
    expect(row.querySelector("script")).toBe(null);
    expect(window.pwned).toBe(undefined);
    expect(row.querySelector(".fbh-answer").textContent).toBe(hostile);
    expect(row.querySelector(".fbh-progress").textContent).toBe(hostile);
    expect(row.querySelector(".fbh-who").textContent).toBe(hostile);
  });

  it("does not throw when replies is malformed (a string, not an array) — one bad field, not a crash", () => {
    expect(() =>
      renderRow(document, item({ replies: "oops" }), {}, { me: "me", now: now() }),
    ).not.toThrow();
    const row = renderRow(document, item({ replies: "oops" }), {}, { me: "me", now: now() });
    // A real, fully-rendered row (not the try/catch's placeholder — that path is tested on its
    // own above): the rest of the row is intact, only the replies list is left out.
    expect(row.classList.contains("fbh-row-error")).toBe(false);
    expect(row.querySelector(".fbh-pill").textContent).toBe("Received, being looked at");
    expect(row.querySelector(".fbh-replies")).toBe(null);
  });

  it("does not throw and skips the link when an issue/PR is missing its number or url", () => {
    const row = renderRow(
      document,
      item({
        status: "in_progress",
        label: "Fix in progress",
        issue: {},
        pullRequest: { number: 9 },
      }),
      {},
      { me: "me", now: now() },
    );
    expect(row.classList.contains("fbh-row-error")).toBe(false);
    expect(row.querySelector(".fbh-pill").textContent).toBe("Fix in progress");
    expect(row.querySelector("a[data-issue]")).toBe(null);
    expect(row.querySelector("a[data-pr]")).toBe(null);
  });

  it("does not throw and shows a placeholder when a whole row is unrenderable", () => {
    // A totally malformed item (not even an object) must cost only itself.
    const row = renderRow(document, null, {}, { me: "me", now: now() });
    expect(row).not.toBe(null);
    expect(row.classList.contains("fbh-row-error")).toBe(true);
  });

  it("falls back to a placeholder row instead of throwing when reading a field itself throws", () => {
    // A well-formed-looking item whose own property access is what fails — a shape none of the
    // field-by-field guards above can anticipate. This is what renderRow's own try/catch is for,
    // as opposed to the specific Array.isArray/linkFor guards, which are tested separately.
    const poison = item();
    Object.defineProperty(poison, "text", {
      get() {
        throw new Error("boom");
      },
    });
    const row = renderRow(document, poison, {}, { me: "me", now: now() });
    expect(row.classList.contains("fbh-row-error")).toBe(true);
  });

  it("does not throw when a date will not parse", () => {
    const row = renderRow(document, item({ at: "not-a-date" }), {}, { me: "me", now: now() });
    expect(row.querySelector(".fbh-when").textContent).toBe("");
  });

  it("shows an unknown status without throwing", () => {
    const row = renderRow(
      document,
      item({ status: "some_new_status", label: undefined }),
      {},
      { me: "me", now: now() },
    );
    expect(row.querySelector(".fbh-pill").textContent).toBe("");
    expect(row.querySelector("[data-retry]")).toBe(null);
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
    expect(document.querySelector(".fbh-empty").textContent).toBe(
      "Nothing yet. Your reports will show up here.",
    );
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
    list.addOptimistic({
      id: "new",
      section: "General",
      type: "Question",
      text: "just sent",
      at: "2026-09-21T11:59:50.000Z",
    });
    const first = document.querySelector(".fbh-row");
    expect(first.dataset.id).toBe("new");
    expect(first.querySelector(".fbh-pill").textContent).toBe("Received, being looked at");
    list.destroy();
  });

  it("sends a reply and takes the hub's new status", async () => {
    const { list, api } = setup({
      list: async () => ({
        items: [
          item({
            status: "needs_reply",
            label: "Needs your reply",
            verdict: { verdict: "needs_info", questions: ["Which SKU?"], receivedAt: "t" },
          }),
        ],
        nextCursor: null,
      }),
    });
    await list.refresh();
    document.querySelector("[data-reply]").value = "SKU 12";
    document.querySelector("[data-send]").click();
    await vi.waitFor(() => expect(api.reply).toHaveBeenCalledWith("r1", "SKU 12"));
    await vi.waitFor(() =>
      expect(document.querySelector(".fbh-pill").textContent).toBe("Received, being looked at"),
    );
    list.destroy();
  });

  it("retries a report the hub can still retry", async () => {
    const { list, api } = setup({
      list: async () => ({
        items: [item({ status: "error", label: "Could not triage" })],
        nextCursor: null,
      }),
    });
    await list.refresh();
    document.querySelector("[data-retry]").click();
    await vi.waitFor(() => expect(api.retry).toHaveBeenCalledWith("r1"));
    await vi.waitFor(() =>
      expect(document.querySelector(".fbh-pill").textContent).toBe("Received, being looked at"),
    );
    list.destroy();
  });

  it("shows what the hub said when a reply is refused", async () => {
    const { list } = setup({
      list: async () => ({
        items: [
          item({
            status: "needs_reply",
            label: "Needs your reply",
            verdict: { verdict: "needs_info", questions: ["?"], receivedAt: "t" },
          }),
        ],
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
      expect(document.querySelector(".fbh-row-message").textContent).toBe(
        "This report has all the replies it can take.",
      ),
    );
    list.destroy();
  });

  it("a retry that comes back 409 not_retryable shows the hub's message and does not crash the row", async () => {
    const { list } = setup({
      list: async () => ({
        items: [item({ status: "waiting", label: "Received, waiting" })],
        nextCursor: null,
      }),
      retry: async () => {
        const err = new Error("This report has already moved on.");
        err.status = 409;
        err.code = "not_retryable";
        throw err;
      },
    });
    await list.refresh();
    document.querySelector("[data-retry]").click();
    await vi.waitFor(() =>
      expect(document.querySelector(".fbh-row-message").textContent).toBe(
        "This report has already moved on.",
      ),
    );
    // The row is still there, still sensible, and Retry is still reachable for another attempt.
    expect(document.querySelectorAll(".fbh-row")).toHaveLength(1);
    expect(document.querySelector("[data-retry]")).not.toBe(null);
    list.destroy();
  });

  it("re-offers a fresh, empty reply box when the hub still needs another reply after one was sent", async () => {
    const { list } = setup({
      list: async () => ({
        items: [
          item({
            status: "needs_reply",
            label: "Needs your reply",
            verdict: { verdict: "needs_info", questions: ["Which SKU?"], receivedAt: "t" },
          }),
        ],
        nextCursor: null,
      }),
      reply: async () => ({
        status: "needs_reply",
        label: "Needs your reply",
        replies: [{ at: "t", by: "me", text: "SKU 12" }],
      }),
    });
    await list.refresh();
    document.querySelector("[data-reply]").value = "SKU 12";
    document.querySelector("[data-send]").click();
    await vi.waitFor(() => expect(document.querySelector(".fbh-replies li")).not.toBe(null));
    // A fresh box, not the old one still carrying the just-sent text.
    expect(document.querySelector("[data-reply]").value).toBe("");
    list.destroy();
  });

  it("does not send a second reply while the first is still in flight", async () => {
    let resolveReply;
    const { list, api } = setup({
      list: async () => ({
        items: [
          item({
            status: "needs_reply",
            label: "Needs your reply",
            verdict: { verdict: "needs_info", questions: ["?"], receivedAt: "t" },
          }),
        ],
        nextCursor: null,
      }),
      reply: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveReply = resolve;
          }),
      ),
    });
    await list.refresh();
    document.querySelector("[data-reply]").value = "SKU 12";
    const send = document.querySelector("[data-send]");
    send.click();
    send.click();
    send.click();
    expect(api.reply).toHaveBeenCalledTimes(1);
    resolveReply({ status: "triaging", label: "Received, being looked at", replies: [] });
    await vi.waitFor(() =>
      expect(document.querySelector(".fbh-pill").textContent).toBe("Received, being looked at"),
    );
    list.destroy();
  });

  it("keeps keyboard focus inside the row (not dropped to body) after a retry re-renders it", async () => {
    const { list } = setup({
      list: async () => ({
        items: [item({ status: "error", label: "Could not triage" })],
        nextCursor: null,
      }),
    });
    await list.refresh();
    const retryButton = document.querySelector("[data-retry]");
    retryButton.focus();
    retryButton.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".fbh-pill").textContent).toBe("Received, being looked at"),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.querySelector(".fbh-row").contains(document.activeElement)).toBe(true);
    list.destroy();
  });

  it("announces the new status in the row's live region after a successful retry, not only by recolouring the pill", async () => {
    const { list } = setup({
      list: async () => ({
        items: [item({ status: "error", label: "Could not triage" })],
        nextCursor: null,
      }),
    });
    await list.refresh();
    document.querySelector("[data-retry]").click();
    await vi.waitFor(() =>
      expect(document.querySelector(".fbh-row-message").textContent).not.toBe(""),
    );
    expect(document.querySelector(".fbh-row-message").textContent).toContain(
      "Received, being looked at",
    );
    list.destroy();
  });

  it("does not crash the whole list when one row is malformed — one bad row costs one row", async () => {
    const { list } = setup({
      list: async () => ({
        items: [
          item({ id: "good-1" }),
          { id: "bad", replies: "oops", issue: "not-an-object" },
          item({ id: "good-2" }),
        ],
        nextCursor: null,
      }),
    });
    await expect(list.refresh()).resolves.toBeUndefined();
    const rows = document.querySelectorAll(".fbh-row");
    expect(rows.length).toBe(3);
    expect(document.querySelector('[data-id="good-1"]')).not.toBe(null);
    expect(document.querySelector('[data-id="good-2"]')).not.toBe(null);
    list.destroy();
  });

  it("survives a throwing user() while rendering, instead of breaking the whole list", async () => {
    const throwingOptions = normalizeOptions({
      hubUrl: "https://hub.example",
      app: "cad",
      getToken: async () => "t",
      user: () => {
        throw new Error("boom");
      },
    });
    const api = {
      list: vi.fn(async () => ({ items: [item()], nextCursor: null })),
      reply: vi.fn(),
      retry: vi.fn(),
      markRead: vi.fn(),
    };
    const list = createList({ api, options: throwingOptions, doc: document, now });
    document.body.appendChild(list.element);
    await expect(list.refresh()).resolves.toBeUndefined();
    expect(document.querySelectorAll(".fbh-row")).toHaveLength(1);
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
