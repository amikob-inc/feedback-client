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
    expect(messageFor(429, "rate_limited", "")).toBe(
      "You have sent a lot of reports this hour. Try again later.",
    );
    expect(messageFor(429, "too_many_replies", "")).toBe(
      "This report has all the replies it can take.",
    );
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
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { items: [{ id: "1" }], nextCursor: null }),
    );
    const page = await transportWith(fetchImpl).list();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://hub.example/v1/reports?app=cad");
    expect(page).toEqual({ items: [{ id: "1" }], nextCursor: null });
  });

  it("sends a reply and a retry to the right routes, both with ?app=", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: "triaging", label: "Received, being looked at", replies: [] }),
    );
    const transport = transportWith(fetchImpl);
    await transport.reply("id 1", "here is more");
    await transport.retry("id 1");
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://hub.example/v1/reports/id%201/replies?app=cad",
    );
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
    const fetchImpl = async () =>
      jsonResponse(413, { error: "too_large", message: "screenshot exceeds 5242880 bytes" });
    const error = await transportWith(fetchImpl)
      .submit(new FormData())
      .catch((err) => err);
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
    const error = await transportWith(fetchImpl)
      .list()
      .catch((err) => err);
    expect(error.status).toBe(0);
    expect(error.message).toBe("Couldn't send, retry.");
  });

  it("copes with a body that is not JSON", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 502,
      text: async () => "<html>bad gateway</html>",
    });
    const error = await transportWith(fetchImpl)
      .list()
      .catch((err) => err);
    expect(error.status).toBe(502);
    expect(error.message).toBe("The hub had a problem. Retry.");
  });
});
