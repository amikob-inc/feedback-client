// What this library keeps of a URL, wherever one is written down: the page context, the route
// breadcrumb, the recorder's Meta event and every URL-carrying attribute in the recording.
//
// The query string always goes: cad-dashboard's router puts a magic-link token in one. The
// fragment is the route a dashboard navigates by (`#batch-12`) and is kept — unless it carries
// parameters. supabase-js's implicit flow lands a whole session in the fragment,
// `#access_token=…&refresh_token=…&type=recovery`, and cad-dashboard's own auth bootstrap reads it
// from exactly there; a report filed from that page would have sent a live access and refresh
// token to the hub and on into a GitHub issue. The rule is the shape rather than a list of names,
// so a parameter nobody has thought of cannot get through: a fragment with an `=` in it is
// parameters, and is dropped whole.
export function safeFragment(hash) {
  const text = typeof hash === "string" ? hash : "";
  return text.includes("=") ? "" : text;
}

// pathname plus the fragment the rule above allows: what a report says about where it was filed.
export function routePath(location) {
  const where = location || {};
  return `${typeof where.pathname === "string" ? where.pathname : ""}${safeFragment(where.hash)}`;
}

// The same rule applied to a whole href. Never throws: an href this cannot parse is cut by hand
// rather than passed through, because passing it through is the failure that matters.
export function scrubHref(href) {
  const text = typeof href === "string" ? href : "";
  try {
    const url = new URL(text);
    url.search = "";
    url.hash = safeFragment(url.hash);
    return url.toString();
  } catch {
    const query = text.indexOf("?");
    const hashAt = text.indexOf("#");
    const cuts = [query, hashAt].filter((at) => at !== -1);
    const base = cuts.length ? text.slice(0, Math.min(...cuts)) : text;
    return base + safeFragment(hashAt === -1 ? "" : text.slice(hashAt));
  }
}
