// Hand-written: the package ships no build step and no generated types. `tests/types.test.js`
// checks the value-level declarations here against what src/index.js really exports, so a rename
// on one side cannot go unnoticed on the other; the shapes themselves are the documentation and
// are checked by reading.
export type Status =
  | "waiting"
  | "triaging"
  | "filed"
  | "needs_reply"
  | "answered"
  | "duplicate"
  | "not_filed"
  | "in_progress"
  | "fixed"
  | "closed"
  | "error";

export interface CaptureOptions {
  /** The rolling session replay. On by default. */
  replay?: boolean;
  /** The automatic screenshot taken when the panel opens. On by default. */
  screenshot?: boolean;
  console?: boolean;
  network?: boolean;
  /** Mask every typed value, not only passwords, in the replay and the click trail. */
  maskAllInputs?: boolean;
  /** CSS selectors for what must never be captured, in any of the three. */
  blank?: string[];
}

export interface Reporter {
  id: string;
  name?: string;
  email?: string;
  role?: string;
}

export interface MountOptions {
  /** The hub's base URL. Empty or absent: the feature is off and the button is hidden. */
  hubUrl?: string;
  /** The app id in the hub's apps.yaml, for example "cad". Required. */
  app: string;
  env?: string;
  version?: string;
  getToken: () => Promise<string | null>;
  user?: () => Reporter | null;
  section?: () => string;
  sections?: string[];
  types?: string[];
  button?: string | Element | null;
  theme?: () => "light" | "dark" | string;
  onSummary?: (summary: { attention: number }) => void;
  capture?: CaptureOptions;
}

/** A seam for tests and for an app that brings its own panel. Not part of the options object. */
export interface MountDeps {
  doc?: Document;
  win?: Window;
  fetch?: typeof fetch;
  transport?: unknown;
  storage?: Storage | null;
  schedule?: (fn: () => void) => void;
  loadRecorder?: () => Promise<unknown>;
  loadScreenshot?: () => Promise<unknown>;
  /** Built the first time open() is called; may return a promise, as the built-in loader does. */
  createPanel?: (context: {
    api: unknown;
    options: unknown;
    doc: Document;
  }) => Panel | Promise<Panel>;
}

export interface Panel {
  open(): void;
  close(): void;
  destroy(): void;
}

export interface ReportFields {
  section?: string;
  type?: string;
  text: string;
  images?: Blob[];
  includeReplay?: boolean;
  screenshot?: Blob | null;
}

export interface Verdict {
  verdict: string;
  summary: string;
  issueNumber: number | null;
  issueUrl: string | null;
  duplicateOf: number | null;
  answer: string | null;
  questions: string[];
  reason: string | null;
  candidate: boolean;
  receivedAt: string;
}

export interface ReportSummary {
  id: string;
  at: string;
  section: string;
  type: string;
  text: string;
  reporter: { id: string; name: string };
  status: Status;
  /** The hub's own label for this status. The panel shows this, never one computed locally. */
  label: string;
  verdict: Verdict | null;
  issue?: { number: number; url: string; state: "open" | "closed" };
  pullRequest?: { number: number; url: string; state: "open" | "closed"; merged: boolean };
  duplicateOf?: { number: number; url: string; state: "open" | "closed" };
  progress?: string;
  degraded?: boolean;
  replies: { at: string; by: string; text: string }[];
}

export interface FeedbackHandle {
  /**
   * Shows the panel. It is loaded on demand, so this resolves once the panel is on the page — a
   * caller that inspects the DOM right after calling it sees nothing yet. It never rejects: if
   * the panel cannot be loaded the library warns once and resolves anyway.
   */
  open(): Promise<void>;
  close(): void;
  /** Resolves to null when the feature is off (no hubUrl). */
  submit(fields: ReportFields): Promise<{ id: string; dropped: string[] } | null>;
  list(): Promise<{ items: ReportSummary[]; nextCursor: string | null }>;
  reply(id: string, text: string): Promise<unknown>;
  retry(id: string): Promise<unknown>;
  destroy(): void;
}

export declare class FeedbackError extends Error {
  status: number;
  code: string;
  part: string | null;
}

export declare function mountFeedback(options: MountOptions, deps?: MountDeps): FeedbackHandle;
export declare function statusLabel(
  status: Status,
  ctx?: { issue?: number; duplicateOf?: number; originalState?: "open" | "closed" | "fixed" },
): string;
export declare const STATUSES: Status[];
export declare const CLIENT_ID: string;
export declare const CLIENT_VERSION: string;
