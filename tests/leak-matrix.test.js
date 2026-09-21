/** @vitest-environment jsdom */
// The marker matrix, run against the real capture path on every `pnpm test`.
//
// Every position in tests/lib/markers.js is planted into one page with a unique marker, the
// library is mounted and submitted for real with a stubbed transport, and every part of the
// outgoing FormData — the report JSON, the gzipped replay, the screenshot and the attached image
// — is searched for every marker. A marker that reaches a part it should not have is a leak and
// names its own position; a marker that should have reached one and did not means the capture, or
// this harness, has quietly stopped working. Both fail.
//
// Six settings combinations run here because the whole matrix costs about two and a half seconds;
// `pnpm test:leaks` runs the same thing and writes the full per-position table to leak-report.txt
// for a person to read.
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLANK_SELECTOR, buildPositions } from "./lib/markers.js";
import { DEFAULT_SETTINGS, formatScan, runCapture, scan } from "./lib/capture-harness.js";

const positions = buildPositions();

// The combinations, and what each one is here to decide.
const COMBINATIONS = {
  // What a dashboard holding cost prices and customer records should be mounted with.
  hardened: DEFAULT_SETTINGS,
  // What an app gets if it passes no `capture` options at all.
  defaults: { ...DEFAULT_SETTINGS, maskAllInputs: false, blank: [] },
  // The two halves on their own, so neither can be credited with the other's work.
  "mask-without-blank": { ...DEFAULT_SETTINGS, blank: [] },
  "blank-without-mask": { ...DEFAULT_SETTINGS, maskAllInputs: false },
  // The recording is the only part that carries page content: with it off, nothing from the page
  // may reach the bundle at all.
  "replay-off": { ...DEFAULT_SETTINGS, replay: false },
  // The two buffers an app can switch off (spec §5.5).
  "buffers-off": { ...DEFAULT_SETTINGS, console: false, network: false },
  // One typo in one dashboard's `capture.blank`, beside the selectors it got right. A selector
  // list is passed to an engine as one string, and an engine that cannot parse the string answers
  // "nothing matches" for every element — so this combination is the difference between a typo
  // that costs one selector and a typo that costs all of them.
  "typo-in-blank": { ...DEFAULT_SETTINGS, blank: [BLANK_SELECTOR, "div:has-bad((("] },
};

const runs = {};

beforeAll(async () => {
  for (const [name, settings] of Object.entries(COMBINATIONS)) {
    runs[name] = scan(await runCapture({ settings, positions }));
  }
}, 180000);

afterAll(() => {
  if (!process.env.FBH_LEAK_REPORT) return;
  const text = Object.entries(runs)
    .map(([name, run]) => formatScan(run, { title: name, verbose: true }))
    .join("\n\n==============================================================\n\n");
  writeFileSync("leak-report.txt", `${text}\n`);
});

describe("the harness itself", () => {
  it("plants one unique marker in every position", () => {
    const planted = runs.hardened.results.length;
    expect(planted).toBe(positions.length);
    expect(planted).toBeGreaterThan(250);
    expect(new Set(runs.hardened.results.map((one) => one.marker)).size).toBe(planted);
  });

  it("reads every part of the bundle back, including the compressed one", () => {
    const names = runs.hardened.parts.map((part) => part.name).sort();
    expect(names).toEqual(["image", "replay", "report", "screenshot"]);
    const replay = runs.hardened.parts.find((part) => part.name === "replay");
    expect(replay.encoding).toBe("gzip+json");
    expect(JSON.parse(replay.text).length).toBeGreaterThan(0);
  });

  it("is not vacuous: what it expects to find, it finds, and there is a lot of it", () => {
    // If the capture path silently stopped producing anything, every "withheld" assertion below
    // would pass for the wrong reason. This is the guard against that reading: the hardened run —
    // the strictest of the six — still publishes dozens of markers, in more than one part.
    const found = runs.hardened.results.filter((one) => one.hits.length);
    expect(found.length).toBeGreaterThan(50);
    const parts = new Set(found.flatMap((one) => one.hits.map((hit) => hit.part)));
    expect([...parts].sort()).toEqual(["image", "replay", "report", "screenshot"]);
  });
});

describe.each(Object.keys(COMBINATIONS))("%s", (name) => {
  it("sends nothing from a position that should have withheld it", () => {
    const run = runs[name];
    expect(
      run.leaked.map((one) => one.position.id),
      `\n${formatScan(run, { title: name })}`,
    ).toEqual([]);
  });

  it("still sends everything a report needs", () => {
    const run = runs[name];
    expect(
      run.missing.map((one) => one.position.id),
      `\n${formatScan(run, { title: name })}`,
    ).toEqual([]);
  });
});

describe("the rules that hold under every setting", () => {
  it("never sends a password", () => {
    for (const [name, run] of Object.entries(runs)) {
      const passwords = run.results.filter((one) => one.position.kind === "password");
      expect(passwords.length).toBeGreaterThan(10);
      expect(
        passwords.filter((one) => one.hits.length).map((one) => `${name}/${one.position.id}`),
      ).toEqual([]);
    }
  });

  it("never sends a hidden field's value or a file's path", () => {
    for (const [name, run] of Object.entries(runs)) {
      const always = run.results.filter(
        (one) => one.position.kind === "always-masked" && one.fate.expect === "withheld",
      );
      expect(always.length).toBeGreaterThan(5);
      expect(
        always.filter((one) => one.hits.length).map((one) => `${name}/${one.position.id}`),
      ).toEqual([]);
    }
  });

  it("never sends the page's query string, however the page is reached", () => {
    for (const [name, run] of Object.entries(runs)) {
      const queries = run.results.filter((one) =>
        ["location-query", "route-query", "network-query"].includes(one.position.channel),
      );
      expect(queries.length).toBe(3);
      expect(
        queries.filter((one) => one.hits.length).map((one) => `${name}/${one.position.id}`),
      ).toEqual([]);
    }
  });
});

describe("what capture.blank is worth", () => {
  it("withholds everything inside a blanked element that it publishes without one", () => {
    const withBlank = idsWithHits(runs.hardened, (one) => one.position.zone === "sensitive");
    const withoutBlank = idsWithHits(
      runs["mask-without-blank"],
      (one) => one.position.zone === "sensitive",
    );
    expect(withBlank).toEqual([]);
    expect(withoutBlank.length).toBeGreaterThan(20);
  });

  it("reaches the breadcrumb trail as well as the recording", () => {
    const clicks = (run) =>
      run.results.filter((one) => String(one.position.channel || "").startsWith("click-"));
    expect(clicks(runs.hardened).filter((one) => one.hits.length)).toEqual([]);
    expect(clicks(runs["mask-without-blank"]).filter((one) => one.hits.length).length).toBe(5);
  });
});

describe("what maskAllInputs is worth", () => {
  it("withholds field values it otherwise publishes", () => {
    // Gap positions are excluded: they are published either way and are listed in
    // tests/lib/fates.js with the reason no setting reaches them.
    const values = (run) =>
      idsWithHits(
        run,
        (one) =>
          one.position.kind === "input-value" && one.position.zone === "ordinary" && !one.fate.gap,
      );
    expect(values(runs.hardened)).toEqual([]);
    expect(values(runs["blank-without-mask"]).length).toBeGreaterThan(5);
  });
});

function idsWithHits(run, predicate) {
  return run.results
    .filter((one) => predicate(one) && one.hits.length)
    .map((one) => one.position.id);
}

it("mounts against the selector the harness plants with", () => {
  // A guard on the harness's own wiring: if this ever stopped matching, every `sensitive` result
  // above would be an ordinary one wearing a label.
  expect(DEFAULT_SETTINGS.blank).toEqual([BLANK_SELECTOR]);
});
