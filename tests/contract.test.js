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
      "0aa4da351dde25ee3c4590bc301e044a467610f04d002a1caae61ba399956fc5",
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
    expect(await transportAnswering(contract.reply).reply("r1", "more")).toEqual(
      contract.reply.body,
    );
    expect(await transportAnswering(contract.retry).retry("r1")).toEqual(contract.retry.body);
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

  it("names the part a 413 refused, so the reporter knows what to leave out", async () => {
    const error = await transportAnswering(contract.errors.tooLarge)
      .submit(new FormData())
      .catch((err) => err);
    expect(error.part).toBe("screenshot");
    expect(error.message).toBe("That is too big to send. Leave the screenshot out and try again.");
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
    expect(byStatus("waiting").querySelectorAll(".fbh-replies li").length).toBeGreaterThan(0);
  });

  it("draws a degraded report from the hub's fallback", () => {
    const degraded = items.find((one) => one.degraded === true);
    expect(degraded).toBeDefined();
    const row = renderRow(document, degraded, {}, { me: degraded.reporter.id });
    expect(row.classList.contains("fbh-row-error")).toBe(false);
  });
});
