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
import { activeWithin, el, firstLine, relativeTime } from "./dom.js";

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
//
// `entry.url` comes from the hub, another origin this client does not control. The hub itself
// anchors it to `https://` before a verdict is ever filed and overwrites it with GitHub's own
// address (service/src/verdict.ts), so a `javascript:` or `data:` scheme is not reachable today —
// but this client must not depend on the server's manners. Only `http:`/`https:` become a real,
// clickable `href`; anything else renders the same text with nothing to click, rather than either
// a dead link or a link that runs on click.
const LINK_SCHEMES = new Set(["http:", "https:"]);

function isSafeLinkUrl(url) {
  try {
    return LINK_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function linkFor(doc, entry, attr, label) {
  if (!entry || typeof entry.number !== "number" || !entry.url) return null;
  const text = `${label} #${entry.number}`;
  if (!isSafeLinkUrl(entry.url)) return el(doc, "span", { class: "fbh-link", [attr]: true, text });
  return el(doc, "a", {
    class: "fbh-link",
    [attr]: true,
    href: entry.url,
    target: "_blank",
    rel: "noreferrer noopener",
    text,
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
              // Disabling the control the reporter's own focus is on drops that focus to <body>,
              // outside the panel's shadow root and so outside the dialog's focus trap and its
              // Escape. The row's status line has just been given the words to say, so it is
              // both displayed and the right place to land.
              if (busy && activeWithin(row)) message.focus();
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
              if (busy && activeWithin(row)) message.focus();
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
  const EMPTY_TEXT = "Nothing yet. Your reports will show up here.";
  const empty = el(doc, "p", {
    class: "fbh-empty",
    role: "status",
    "aria-live": "polite",
    text: EMPTY_TEXT,
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

  // A row a colleague is in the middle of using must survive a rebuild untouched: their own
  // keyboard focus (anywhere in the row, not only the reply box), or reply text they have started
  // typing but not yet sent. Checked against the *live* DOM node, not the data, because the data
  // for that row may not have changed at all — a poll rebuilding it for no reason is exactly the
  // bug this guards against.
  function isMidEdit(row) {
    if (activeWithin(row)) return true;
    const draft = row.querySelector("[data-reply]");
    return !!draft && draft.value.trim() !== "";
  }

  // Rebuilds the list to match `items`, the way a fetch or an optimistic add always has, but a
  // mid-edit row (see isMidEdit) is left exactly as it is — the same node, untouched — instead of
  // being torn down and replaced. A full clear()-and-rebuild here is the rebuild-loses-focus bug
  // tasks 10 and 11 already had to fix once each, in the form's Remove and its Draw-and-Save; this
  // is its third and worst home, because render() also runs on the unattended 30-second poll (see
  // start() below) — the one path where nothing the reporter did triggers the rebuild, so losing
  // their place here happens without them doing anything at all.
  function render() {
    empty.hidden = items.length > 0;
    // A failed fetch writes its message here (see refresh()); the next listing that succeeds,
    // the poll's included, must put the placeholder back rather than leave "session expired"
    // standing over an empty list.
    empty.textContent = EMPTY_TEXT;
    const ctx = context();
    const h = handlers();

    const existingById = new Map();
    for (const node of listEl.children) {
      if (node.dataset && node.dataset.id) existingById.set(node.dataset.id, node);
    }
    const claimed = new Set();
    const preserved = new Set();
    const next = items.map((item) => {
      const id = item && typeof item === "object" ? item.id : undefined;
      const old = id !== undefined && !claimed.has(id) ? existingById.get(id) : undefined;
      if (old) claimed.add(id);
      if (old && isMidEdit(old)) {
        preserved.add(old);
        return old;
      }
      return renderRow(doc, item, h, ctx);
    });

    for (const node of [...listEl.children]) {
      if (!preserved.has(node) && !next.includes(node)) node.remove();
    }
    // Reorders to match `next`, but a preserved row is never relocated even if its position
    // changed: moving an already-attached, currently-focused node — even within the very same
    // list, even via insertBefore rather than remove-then-append — still drops its focus to
    // <body> (confirmed by hand against this project's jsdom). A mid-edit row simply keeps its
    // current position until the edit is done and the next render is free to move it.
    let ref = listEl.firstChild;
    for (const node of next) {
      if (preserved.has(node)) {
        if (ref === node) ref = ref.nextSibling;
        continue;
      }
      if (ref === node) ref = ref.nextSibling;
      else listEl.insertBefore(node, ref);
    }
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
    const hadFocus = !!activeWithin(old);
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
    // The words before the busy state: the row's status line is `display: none` while it is
    // empty, and setBusy moves focus onto it as it disables the button underneath.
    ctx.message.textContent = "Sending…";
    ctx.setBusy(true);
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
    ctx.message.textContent = "Retrying…";
    ctx.setBusy(true);
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
