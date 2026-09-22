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

// The hub's 413 message starts with the part it refused (service/src/intake.ts's checkSize). The
// hub also has a `dom` limit, for a page copy this library stopped sending on 2026-09-21: a part
// that is never sent can never be refused, and telling a reporter to "leave the page copy out"
// would name an attachment the panel does not have. An unknown part name falls through to the
// generic "remove an attachment" message, which is the right answer for one.
export const PART_NAMES = {
  report: "the report itself",
  screenshot: "the screenshot",
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
    let token;
    try {
      token = await getToken();
    } catch (err) {
      throw new FeedbackError("Sign in to report", { status: 401, code: "no_token", cause: err });
    }
    if (!token) throw new FeedbackError("Sign in to report", { status: 401, code: "no_token" });
    return { Authorization: `Bearer ${token}` };
  }

  async function call(path, { method = "GET", headers = {}, body } = {}) {
    // Offline first: an app whose getToken() refreshes over the network fails offline too, and
    // "sign in" would be the wrong thing to tell someone whose connection is what is missing.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new FeedbackError(messageFor(0, "offline", ""), { status: 0, code: "offline" });
    }
    const auth = await authorization();
    let res;
    try {
      res = await doFetch(`${base}${path}`, { method, headers: { ...auth, ...headers }, body });
    } catch (err) {
      throw new FeedbackError(messageFor(0, "network", ""), {
        status: 0,
        code: "network",
        cause: err,
      });
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
