// The package's only entry (package.json "exports"). Everything else is an implementation detail,
// though nothing stops an app importing a leaf module directly.
export { mountFeedback } from "./mount.js";
export { FeedbackError } from "./transport.js";
export { STATUSES, statusLabel } from "./status.js";
export { CLIENT_ID, CLIENT_VERSION } from "./version.js";
