// The hub decides a report's status and hands the panel the finished label with every listing
// (service/src/status.ts, listing.ts). This module is the same map on this side, for the row the
// panel adds optimistically after a submit — the hub's 202 carries only an id — and for the pill's
// colour. The strings are the hub's, character for character; fixtures/status-cases.json is
// checked by both repositories so they cannot drift apart quietly.
export const STATUSES = [
  "waiting",
  "triaging",
  "filed",
  "needs_reply",
  "answered",
  "duplicate",
  "not_filed",
  "in_progress",
  "fixed",
  "closed",
  "error",
];

export function statusLabel(status, ctx = {}) {
  switch (status) {
    case "triaging":
      return "Received, being looked at";
    case "waiting":
      return "Received, waiting";
    case "filed":
      return ctx.issue !== undefined ? `Filed as #${ctx.issue}` : "Filed";
    case "in_progress":
      return "Fix in progress";
    case "fixed":
      return "Fixed";
    case "closed":
      return "Closed";
    case "answered":
      return "Answered";
    case "duplicate":
      return `Already tracked as #${ctx.duplicateOf}${ctx.originalState ? ` (${ctx.originalState})` : ""}`;
    case "needs_reply":
      return "Needs your reply";
    case "not_filed":
      return "Not filed";
    case "error":
      return "Could not triage";
    default:
      return "";
  }
}

export function originalState(original) {
  if (!original) return undefined;
  if (original.state !== "closed") return "open";
  return original.stateReason === "completed" ? "fixed" : "closed";
}

export function labelContext({ verdict = null, original = null } = {}) {
  const ctx = {};
  if (verdict && typeof verdict.issueNumber === "number") ctx.issue = verdict.issueNumber;
  if (verdict && typeof verdict.duplicateOf === "number") ctx.duplicateOf = verdict.duplicateOf;
  const state = originalState(original);
  if (state !== undefined) ctx.originalState = state;
  return ctx;
}

// The hub accepts a retry for exactly these two (service/src/routes.ts: anything else is a 409).
export function isRetryable(status) {
  return status === "waiting" || status === "error";
}

export function needsReply(status) {
  return status === "needs_reply";
}

export function statusTone(status) {
  switch (status) {
    case "waiting":
    case "triaging":
      return "info";
    case "filed":
    case "in_progress":
      return "open";
    case "fixed":
      return "done";
    case "closed":
    case "not_filed":
    case "duplicate":
      return "muted";
    case "answered":
    case "needs_reply":
      return "attention";
    case "error":
      return "bad";
    default:
      return "info";
  }
}
