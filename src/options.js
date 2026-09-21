// Mount options (spec §5.5). Unknown keys throw so a typo is a development-time error rather than
// a feature that silently does nothing — `hubURL` instead of `hubUrl` would otherwise hide the
// whole panel. Every hook is stored as a function and called lazily, at open or submit, so
// nothing here reads app state at module-evaluation time (cad-dashboard's import-cycle rule, which
// this library is written to respect even though it does not live in that repository).
export class OptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "OptionError";
  }
}

export const OPTION_KEYS = [
  "hubUrl",
  "app",
  "env",
  "version",
  "getToken",
  "user",
  "section",
  "sections",
  "types",
  "button",
  "theme",
  "onSummary",
  "capture",
];

export const CAPTURE_KEYS = [
  "replay",
  "screenshot",
  "console",
  "network",
  "maskAllInputs",
  "blank",
];
export const DEFAULT_TYPES = ["Bug", "Efficiency suggestion", "Question", "Other"];
export const DEFAULT_SECTIONS = ["General"];
export const DEFAULT_CAPTURE = {
  replay: true,
  screenshot: true,
  console: true,
  network: true,
  maskAllInputs: false,
  blank: [],
};

// A known option with the wrong type is named and thrown on, not silently swapped for a default:
// `hubUrl: 12345` (a stray number where a URL was meant) must read as a mount-time mistake, not as
// "the feature is off". `undefined`/`null` are the only two spellings of "not given".
function optionalString(value, name) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new OptionError(`option "${name}" must be a string`);
  return value;
}

function hook(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "function") throw new OptionError(`option "${name}" must be a function`);
  return value;
}

function stringList(value, name, fallback) {
  if (value === undefined || value === null) return fallback.slice();
  if (!Array.isArray(value) || value.some((one) => typeof one !== "string" || !one.trim())) {
    throw new OptionError(`option "${name}" must be an array of non-empty strings`);
  }
  return value.slice();
}

function normalizeCapture(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_CAPTURE, blank: [] };
  if (typeof raw !== "object") throw new OptionError('option "capture" must be an object');
  for (const key of Object.keys(raw)) {
    if (!CAPTURE_KEYS.includes(key)) {
      throw new OptionError(
        `unknown capture option "${key}"; the capture options are ${CAPTURE_KEYS.join(", ")}`,
      );
    }
  }
  const capture = { ...DEFAULT_CAPTURE, blank: [] };
  for (const key of ["replay", "screenshot", "console", "network", "maskAllInputs"]) {
    if (raw[key] !== undefined) capture[key] = !!raw[key];
  }
  capture.blank = stringList(raw.blank, "blank", []);
  return capture;
}

export function defaultSection(sections, view) {
  const list = sections && sections.length ? sections : DEFAULT_SECTIONS;
  const wanted = String(view || "")
    .trim()
    .toLowerCase();
  return list.find((one) => one.toLowerCase() === wanted) || list[list.length - 1];
}

export function normalizeOptions(raw) {
  if (!raw || typeof raw !== "object") {
    throw new OptionError("mountFeedback needs an options object");
  }
  for (const key of Object.keys(raw)) {
    if (!OPTION_KEYS.includes(key)) {
      throw new OptionError(`unknown option "${key}"; the options are ${OPTION_KEYS.join(", ")}`);
    }
  }
  if (typeof raw.app !== "string" || !raw.app.trim()) {
    throw new OptionError('option "app" is required and must be a non-empty string');
  }
  // Empty (or absent) is the deliberate off switch (spec §5.5, standing rule 5): a redeploy that
  // drops the variable turns the whole feature off rather than crashing the app.
  const hubUrl = optionalString(raw.hubUrl, "hubUrl").replace(/\/+$/, "");
  if (hubUrl && typeof raw.getToken !== "function") {
    throw new OptionError('option "getToken" must be a function returning the access token');
  }
  if (raw.button !== undefined && raw.button !== null) {
    const ok = typeof raw.button === "string" || typeof raw.button.addEventListener === "function";
    if (!ok) throw new OptionError('option "button" must be a selector or an element');
  }

  return {
    hubUrl,
    app: raw.app.trim(),
    env: optionalString(raw.env, "env"),
    version: optionalString(raw.version, "version"),
    getToken: hook(raw.getToken, "getToken", async () => null),
    user: hook(raw.user, "user", () => null),
    section: hook(raw.section, "section", () => ""),
    sections: stringList(raw.sections, "sections", DEFAULT_SECTIONS),
    types: stringList(raw.types, "types", DEFAULT_TYPES),
    button: raw.button === undefined ? null : raw.button,
    theme: hook(raw.theme, "theme", () => "light"),
    onSummary: hook(raw.onSummary, "onSummary", () => {}),
    capture: normalizeCapture(raw.capture),
  };
}
