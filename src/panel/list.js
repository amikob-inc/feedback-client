// "My reports" (spec §5.4): everyone's for an admin, the reporter's own otherwise — the hub
// decides which, from the token. Each row shows the hub's own label, never one computed here: the
// hub already ran the status rules against GitHub (service/src/listing.ts). The local statusLabel
// is the fallback for the row added the moment a report is sent, when all the hub has said is an
// id.
//
// This is the screen a colleague reads to find out what happened to their report, so two rules
// bind harder here than almost anywhere else in this library: nothing the hub or a reporter wrote
// may become markup (no innerHTML, ever — see `el()` in dom.js), and one bad row may not cost the
// whole list. `renderRow` below wraps its own body in a try/catch and falls back to a one-line
// placeholder row (`errorRow`) so a malformed item — missing fields, a field of the wrong type,
// even a value that is not an object at all — costs exactly the one row it belongs to.
import { CAPS } from "../bundle.js";
import { isRetryable, labelContext, needsReply, statusLabel, statusTone } from "../status.js";
import { warnOnce } from "../warn.js";
import { clear, el, firstLine, relativeTime } from "./dom.js";

export const POLL_MS = 30000;

// A hook the host app controls (`options.user`) can throw for reasons outside this module — the
// same standing rule mount.js already applies to every other app-supplied callback (its own
// `safeCall`). `me()` runs on every render, so an unguarded throw here would not cost one row, it
// would take the whole list down.
function safeCall(fn, fallback, label) {
  try {
    return fn();
  } catch (err) {
    warnOnce(label, err);
    return fallback;
  }
}

function labelFor(item) {
  if (item.label) return item.label;
  return statusLabel(item.status, labelContext({ verdict: item.verdict }));
}

function errorRow(doc, item) {
  return el(doc, "li", {
    class: "fbh-row fbh-row-error",
    "data-id": item && typeof item === "object" ? item.id : undefined,
    text: "This report couldn't be shown.",
  });
}

// A link is only rendered when it has both an href and a number to name — a hub response missing
// either would otherwise become "Issue #undefined" or an anchor with no destination at all.
function linkFor(doc, entry, attr, label) {
  if (!entry || typeof entry.number !== "number" || !entry.url) return null;
  return el(doc, "a", {
    class: "fbh-link",
    [attr]: true,
    href: entry.url,
    target: "_blank",
    rel: "noreferrer noopener",
    text: `${label} #${entry.number}`,
  });
}

export function renderRow(doc, item, handlers = {}, { me = null, now = new Date() } = {}) {
  if (!item || typeof item !== "object") return errorRow(doc, item);

  try {
    const verdict = item.verdict && typeof item.verdict === "object" ? item.verdict : {};
    // role="status": the row's one live region, reused for "Sending…"/"Retrying…" while an action
    // is in flight, for the hub's own refusal text on failure, and for a short confirmation once
    // an action succeeds — so a status change is announced, not only shown by a recoloured pill.
    // tabindex="-1": never in the tab order on its own, but a deliberate, announced landing spot
    // for focus that a reply/retry re-render would otherwise drop to <body> (see createList below,
    // and form.js's identical `message` for the same reason).
    const message = el(doc, "p", {
      class: "fbh-row-message",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
      tabindex: "-1",
    });
    const row = el(doc, "li", {
      class: "fbh-row",
      "data-id": item.id,
      "data-status": item.status,
    });

    const head = el(doc, "div", { class: "fbh-row-head" }, [
      el(doc, "span", { class: "fbh-tag", text: item.section || "General" }),
      el(doc, "span", { class: "fbh-tag fbh-tag-type", text: item.type || "Other" }),
      item.reporter && item.reporter.name && item.reporter.id !== me
        ? el(doc, "span", { class: "fbh-who", text: item.reporter.name })
        : null,
      el(doc, "time", { class: "fbh-when", datetime: item.at, text: relativeTime(item.at, now) }),
      el(doc, "span", {
        class: `fbh-pill fbh-pill-${statusTone(item.status)}`,
        text: labelFor(item),
      }),
    ]);
    row.appendChild(head);
    row.appendChild(el(doc, "p", { class: "fbh-row-text", text: firstLine(item.text) }));

    if (item.status === "answered" && verdict.answer) {
      row.appendChild(el(doc, "p", { class: "fbh-answer", text: verdict.answer }));
    }

    if (item.status === "not_filed" && verdict.reason) {
      row.appendChild(el(doc, "p", { class: "fbh-reason", text: verdict.reason }));
    }

    if (item.progress) {
      row.appendChild(el(doc, "p", { class: "fbh-progress", text: item.progress }));
    }

    const links = [
      linkFor(doc, item.issue, "data-issue", "Issue"),
      linkFor(doc, item.duplicateOf, "data-duplicate", "Issue"),
      linkFor(doc, item.pullRequest, "data-pr", "Pull request"),
    ].filter(Boolean);
    if (links.length) row.appendChild(el(doc, "p", { class: "fbh-links" }, links));

    if (Array.isArray(item.replies) && item.replies.length) {
      row.appendChild(
        el(
          doc,
          "ul",
          { class: "fbh-replies" },
          item.replies.map((reply) =>
            el(doc, "li", {
              text: `${reply && reply.text} · ${relativeTime(reply && reply.at, now)}`,
            }),
          ),
        ),
      );
    }

    if (needsReply(item.status)) {
      const questions = Array.isArray(verdict.questions) ? verdict.questions : [];
      if (questions.length) {
        row.appendChild(
          el(
            doc,
            "ul",
            { class: "fbh-questions" },
            questions.map((q) => el(doc, "li", { text: q })),
          ),
        );
      }
      const box = el(doc, "textarea", {
        class: "fbh-input fbh-reply",
        "data-reply": true,
        rows: "2",
        maxlength: String(CAPS.reply),
        placeholder: "Answer here",
        "aria-label": "Your reply",
      });
      const send = el(doc, "button", {
        type: "button",
        class: "fbh-primary fbh-inline",
        "data-send": true,
        text: "Send reply",
        onClick: () => {
          // Guards a double-send: the button and box are disabled the instant a reply goes out
          // (setBusy below) and re-enabled only on failure, so a second Enter/click while the
          // first request is in flight is a no-op instead of a second reply.
          if (!handlers.onReply || send.disabled) return;
          handlers.onReply(item.id, box.value, {
            message,
            setBusy: (busy) => {
              send.disabled = busy;
              box.disabled = busy;
            },
          });
        },
      });
      row.appendChild(el(doc, "div", { class: "fbh-reply-row" }, [box, send]));
    }

    if (isRetryable(item.status)) {
      const retryButton = el(doc, "button", {
        type: "button",
        class: "fbh-ghost fbh-inline",
        "data-retry": true,
        text: "Retry",
        onClick: () => {
          if (!handlers.onRetry || retryButton.disabled) return;
          handlers.onRetry(item.id, {
            message,
            setBusy: (busy) => {
              retryButton.disabled = busy;
            },
          });
        },
      });
      row.appendChild(retryButton);
    }

    row.appendChild(message);
    return row;
  } catch (err) {
    warnOnce("list row", err);
    return errorRow(doc, item);
  }
}

export function createList({ api, options, doc, now = () => new Date() }) {
  const heading = el(doc, "h3", {
    class: "fbh-subhead",
    id: "fbh-reports-heading",
    text: "My reports",
  });
  const listEl = el(doc, "ul", { class: "fbh-list", "aria-labelledby": "fbh-reports-heading" });
  const empty = el(doc, "p", {
    class: "fbh-empty",
    role: "status",
    "aria-live": "polite",
    text: "Nothing yet. Your reports will show up here.",
  });
  const element = el(
    doc,
    "section",
    { class: "fbh-reports", "aria-labelledby": "fbh-reports-heading" },
    [heading, empty, listEl],
  );

  let items = [];
  let timer = null;

  function me() {
    const user = safeCall(options.user, null, "user()");
    return user && user.id ? user.id : null;
  }

  function context() {
    return { me: me(), now: now() };
  }

  function handlers() {
    return { onReply, onRetry };
  }

  function render() {
    clear(listEl);
    empty.hidden = items.length > 0;
    const ctx = context();
    const h = handlers();
    for (const item of items) listEl.appendChild(renderRow(doc, item, h, ctx));
  }

  function rowNode(id) {
    for (const node of listEl.children) {
      if (node.dataset && node.dataset.id === id) return node;
    }
    return null;
  }

  // Rebuilds exactly the one row that changed, in place, instead of clearing and rebuilding the
  // whole list the way `render()` does for a fetch or an optimistic add. A full rebuild after
  // every reply or retry is exactly the focus-loss bug tasks 10 and 11 both had to fix in the
  // form and the annotator (a focused control is removed from the document and focus drops,
  // unannounced, to <body>) — here it would also cost every *other* row's scroll position and any
  // reply draft a colleague is mid-typing elsewhere in the list. `announce`, when given, becomes
  // the fresh row's status message, so a screen-reader user gets the new state read out — the
  // whole point of the row's own aria-live region — rather than only a recoloured pill.
  function updateRow(id, announce) {
    const item = items.find((one) => one.id === id);
    const old = rowNode(id);
    if (!item || !old) return;
    const hadFocus = old.contains(doc.activeElement);
    const fresh = renderRow(doc, item, handlers(), context());
    if (announce) {
      const msg = fresh.querySelector(".fbh-row-message");
      if (msg) msg.textContent = announce;
    }
    old.replaceWith(fresh);
    if (hadFocus) {
      const msg = fresh.querySelector(".fbh-row-message");
      if (msg) msg.focus();
    }
  }

  function applyUpdate(id, patch, announce) {
    items = items.map((one) => (one.id === id ? { ...one, ...patch } : one));
    updateRow(id, announce);
  }

  async function onReply(id, text, ctx) {
    ctx.setBusy(true);
    ctx.message.textContent = "Sending…";
    try {
      const answer = await api.reply(id, text);
      applyUpdate(
        id,
        {
          status: answer.status,
          label: answer.label,
          replies: Array.isArray(answer.replies) ? answer.replies : [],
        },
        `Sent. Now: ${answer.label}.`,
      );
    } catch (err) {
      ctx.message.textContent = err && err.message ? err.message : "Couldn't send, retry.";
      ctx.setBusy(false);
    }
  }

  async function onRetry(id, ctx) {
    ctx.setBusy(true);
    ctx.message.textContent = "Retrying…";
    try {
      const answer = await api.retry(id);
      applyUpdate(
        id,
        { status: answer.status, label: answer.label },
        `Retried. Now: ${answer.label}.`,
      );
    } catch (err) {
      ctx.message.textContent = err && err.message ? err.message : "Couldn't send, retry.";
      ctx.setBusy(false);
    }
  }

  async function refresh() {
    try {
      const page = await api.list();
      items = Array.isArray(page && page.items) ? page.items : [];
      render();
      try {
        api.markRead(items);
      } catch (err) {
        warnOnce("markRead", err);
      }
    } catch (err) {
      if (!items.length) {
        empty.hidden = false;
        empty.textContent = err && err.message ? err.message : "Couldn't send, retry.";
      }
    }
  }

  // The row the reporter sees the instant a report is sent: the hub's 202 carries only an id, and
  // the next poll replaces this with the real thing.
  function addOptimistic(seed) {
    items = [
      {
        id: seed.id,
        at: seed.at || new Date().toISOString(),
        section: seed.section,
        type: seed.type,
        text: seed.text,
        reporter: { id: me(), name: "" },
        status: "triaging",
        label: statusLabel("triaging", {}),
        verdict: null,
        replies: [],
      },
      ...items,
    ];
    render();
  }

  function start() {
    stop();
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }

  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function destroy() {
    stop();
    element.remove();
  }

  return { element, refresh, addOptimistic, start, stop, destroy };
}
