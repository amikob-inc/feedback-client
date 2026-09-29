/** @vitest-environment jsdom */
// The contract shared with amikob-inc/feedback-hub: the hub's caps, and one example answer per
// route, taken from the hub's own routes — fed through this library's transport and list here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CAPS } from "../src/bundle.js";
import { FeedbackError, createTransport } from "../src/transport.js";
import { renderRow } from "../src/panel/list.js";
import { attentionIds, markSeen } from "../src/seen.js";

// Read by path, not `new URL(..., import.meta.url)`: under jsdom Vite rewrites that literal
// pattern to an http:// asset URL (see tests/list.test.js).
const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "../fixtures/contract.json"), "utf8");
const contract = JSON.parse(raw);

function transportAnswering(exchange) {
  const fetchImpl = vi.fn(async () => ({
    ok: exchange.status >= 200 && exchange.status < 300,
    status: exchange.status,
    text: async () => JSON.stringify(exchange.body),
  }));
  return createTransport({
    hubUrl: "https://hub.example",
    app: "cad",
    getToken: async () => "tok",
    fetch: fetchImpl,
  });
}

const items = contract.list.body.items;
const byStatus = (status) => {
  const found = items.find((one) => one.status === status);
  if (!found) throw new Error(`the contract has no ${status} item`);
  return renderRow(document, found, {}, { me: found.reporter.id, now: new Date(found.at) });
};

describe("the contract shared with the hub", () => {
  it("has not drifted (the hub asserts the same digest)", () => {
    const canonical = JSON.stringify(JSON.parse(raw));
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(
      "535c6a5352da704666d7a6fe512692ab3ddf7214f75d624b80aac38d869c02c0",
    );
  });

  it("enforces exactly the hub's caps, no more and no fewer", () => {
    expect(CAPS).toEqual(contract.limits);
  });

  it("reads each route's answer the way the hub gives it", async () => {
    expect(await transportAnswering(contract.submit).submit(new FormData())).toEqual(
      contract.submit.body,
    );
    expect(await transportAnswering(contract.list).list()).toEqual(contract.list.body);
    const page = await transportAnswering(contract.listPage).list({ limit: 1 });
    expect(page).toEqual(contract.listPage.body);
    expect(typeof page.nextCursor).toBe("string");
    expect(await transportAnswering(contract.reply).reply("r1", "more")).toEqual(
      contract.reply.body,
    );
    expect(await transportAnswering(contract.retry).retry("r1")).toEqual(contract.retry.body);
    expect(await transportAnswering(contract.remove).remove("r1")).toEqual(contract.remove.body);
  });

  it("turns each of the hub's errors into its status and code", async () => {
    for (const [name, exchange] of Object.entries(contract.errors)) {
      const error = await transportAnswering(exchange)
        .list()
        .catch((err) => err);
      expect(error, name).toBeInstanceOf(FeedbackError);
      expect(`${name}: ${error.status} ${error.code}`).toBe(
        `${name}: ${exchange.status} ${exchange.body.error}`,
      );
    }
  });

  it("tells the reporter what each of the hub's errors means", async () => {
    const expected = {
      unauthorized: "Your session expired; sign in again.",
      anonymousSession: "That report is not yours to open.",
      origin: "This site is not allowed to send reports.",
      unknownApp: "This app is not set up in the feedback hub yet.",
      forbidden: "That report is not yours to open.",
      unknownReport: "That report is gone.",
      notRetryable: "This report has already moved on.",
      notDeletable: "This report can no longer be deleted.",
      githubError: "The hub had a problem. Retry.",
      rateLimited: "You have sent a lot of reports this hour. Try again later.",
      tooManyReplies: "This report has all the replies it can take.",
      invalidText: "Add a description before sending.",
      invalidReplyText: "Add a description before sending.",
      invalidImage: "Only PNG and JPEG images can be attached.",
      invalidReport: "The hub could not read that report.",
      tooLargeReport: "That is too big to send. Leave the report itself out and try again.",
      tooLargeScreenshot: "That is too big to send. Leave the screenshot out and try again.",
      tooLargeReplay: "That is too big to send. Leave the recording out and try again.",
      tooLargeImage: "That is too big to send. Leave an image out and try again.",
      tooManyImages: "That is too big to send. Leave an image out and try again.",
      tooLargeBundle: "That is too big to send. Leave some of the attachments out and try again.",
      tooLargeRequest: "That is too big to send. Leave some of the attachments out and try again.",
    };
    expect(Object.keys(contract.errors).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, exchange] of Object.entries(contract.errors)) {
      const error = await transportAnswering(exchange)
        .submit(new FormData())
        .catch((err) => err);
      expect(`${name}: ${error.message}`).toBe(`${name}: ${expected[name]}`);
      if (exchange.status === 413) {
        expect(`${name}: ${error.part}`).toBe(`${name}: ${exchange.body.message.split(" ")[0]}`);
      }
    }
  });

  it("draws every listed report, with the hub's label on its pill", () => {
    for (const item of items) {
      const row = renderRow(document, item, {}, { me: item.reporter.id, now: new Date(item.at) });
      expect(row.classList.contains("fbh-row-error"), item.status).toBe(false);
      expect(row.dataset.status).toBe(item.status);
      expect(row.querySelector(".fbh-pill").textContent).toBe(item.label);
    }
  });

  it("draws what each state carries", () => {
    const inProgress = byStatus("in_progress");
    expect(inProgress.querySelector("a[data-issue]").textContent).toMatch(/^Issue #\d+$/);
    expect(inProgress.querySelector("a[data-pr]").textContent).toMatch(/^Pull request #\d+$/);
    expect(inProgress.querySelector(".fbh-progress").textContent).not.toBe("");

    expect(byStatus("duplicate").querySelector("a[data-duplicate]").textContent).toMatch(
      /^Issue #\d+$/,
    );
    expect(byStatus("answered").querySelector(".fbh-answer").textContent).not.toBe("");
    expect(byStatus("needs_reply").querySelectorAll(".fbh-questions li").length).toBeGreaterThan(0);
    expect(byStatus("not_filed").querySelector(".fbh-reason").textContent).not.toBe("");
    const waiting = items.find((one) => one.status === "waiting");
    expect(byStatus("waiting").querySelector(".fbh-replies li").textContent).toContain(
      waiting.replies[0].text,
    );
    // Delete exactly where the hub said so.
    for (const item of items) {
      const row = renderRow(document, item, {}, { me: item.reporter.id, now: new Date(item.at) });
      expect(row.querySelector("[data-delete]") !== null, item.status).toBe(item.canDelete);
    }
    expect(inProgress.querySelector("[data-delete]")).toBe(null);
  });

  it("draws a degraded report from the hub's fallback", () => {
    const degraded = items.find((one) => one.degraded === true);
    expect(degraded).toBeDefined();
    const row = renderRow(document, degraded, {}, { me: degraded.reporter.id });
    expect(row.classList.contains("fbh-row-error")).toBe(false);
  });

  it("counts the reports that need the reporter, and forgets an answer once seen", () => {
    const needsReply = items.find((one) => one.status === "needs_reply");
    const answered = items.find((one) => one.status === "answered");
    expect(attentionIds(items, {}).sort()).toEqual([needsReply.id, answered.id].sort());
    const { seen } = markSeen({}, items);
    expect(attentionIds(items, seen)).toEqual([needsReply.id]);
  });
});
