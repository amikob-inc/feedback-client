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
// Seven settings combinations run here, plus a run of its own for the automatic screenshot;
// `pnpm test:leaks` runs the same thing and writes the full per-position table to leak-report.txt
// for a person to read.
//
// Two things are planted that the first version of this file did not have: a second copy of a
// subset of the positions, added *after* mount so rrweb's mutation path is exercised rather than
// assumed, and the screenshot, captured for real instead of substituted with a PNG the harness
// built itself.
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BLANK_SELECTOR,
  MUTATION_SUBSET,
  buildPositions,
  screenshotPositions,
} from "./lib/markers.js";
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

// The URL the recorder starts on, per combination. rrweb's Meta event carries that URL once, at
// record start, so a run can only ever test one shape of it: the session-in-the-fragment shape of
// a recovery landing page, or a token in the query string. Two combinations start on the query
// shape so a scrubber gated on `#` alone goes red as surely as one gated on `?` alone (the rest
// start on the fragment, the shape that escaped a `?`-only gate once).
const META_HREF = { defaults: "query", "blank-without-mask": "query" };

const runs = {};
// Runs with a position list of their own, kept out of `runs` so the rules below — which hold for
// every combination of the full catalogue — are not asked about a page that never had one.
const extraRuns = {};

beforeAll(async () => {
  for (const [name, settings] of Object.entries(COMBINATIONS)) {
    runs[name] = scan(await runCapture({ settings, positions, metaHref: META_HREF[name] }));
  }
}, 180000);

afterAll(() => {
  if (!process.env.FBH_LEAK_REPORT) return;
  const text = Object.entries({ ...runs, ...extraRuns })
    .map(([name, run]) => formatScan(run, { title: name, verbose: true }))
    .join("\n\n==============================================================\n\n");
  writeFileSync("leak-report.txt", `${text}\n`);
});

describe("the harness itself", () => {
  it("plants one unique marker in every position", () => {
    const planted = runs.hardened.results.length;
    // The catalogue, plus the subset planted a second time after mount so rrweb's mutation path
    // is exercised rather than assumed. An id in MUTATION_SUBSET that no longer names a real
    // position would otherwise drop out of the run in silence.
    expect(planted).toBe(positions.length + MUTATION_SUBSET.length);
    expect(planted).toBeGreaterThan(250);
    expect(new Set(runs.hardened.results.map((one) => one.marker)).size).toBe(planted);
  });

  it("exercises the mutation path as well as the snapshot path", () => {
    const afterMount = runs.hardened.results.filter((one) => one.position.phase === "after mount");
    expect(afterMount.length).toBe(MUTATION_SUBSET.length);
    // Both answers, or the withheld ones would be satisfied by a mutation path that had quietly
    // stopped recording altogether.
    expect(afterMount.filter((one) => one.fate.expect === "published").length).toBeGreaterThan(1);
    expect(afterMount.filter((one) => one.fate.expect === "withheld").length).toBeGreaterThan(5);
    expect(afterMount.filter((one) => one.hits.length).length).toBeGreaterThan(1);
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

  it("never sends the page's query string, or a fragment carrying parameters, however the page is reached", () => {
    const channels = [
      "location-query",
      "route-query",
      "network-query",
      "location-hash-params",
      "route-hash-params",
    ];
    for (const [name, run] of Object.entries(runs)) {
      const queries = run.results.filter((one) => channels.includes(one.position.channel));
      expect(queries.length).toBe(channels.length);
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

// The automatic screenshot: on by default, and until now switched off in every combination with a
// hand-made PNG substituted for it, so the one part that is a picture of the whole page had no
// position at all. This run captures for real — the real modern-screenshot, the real filter and
// clone hook this library passes it — and stops one step short of the raster, because jsdom
// cannot rasterise and a raster is not searchable text (see tests/lib/capture-harness.js).
describe("the automatic screenshot", () => {
  const settings = { ...DEFAULT_SETTINGS, screenshot: true };
  let captured;
  let run;

  beforeAll(async () => {
    captured = await runCapture({ settings, positions: screenshotPositions(), interact: false });
    run = scan(captured);
    extraRuns.screenshot = run;
  }, 120000);

  it("really took one, and it is what the harness is reading", () => {
    const part = run.parts.find((one) => one.name === "screenshot");
    expect(part, "no screenshot part: the capture path did not take one").toBeTruthy();
    expect(part.bytes).toBeGreaterThan(200);
    // Not the harness's own PNG: this run hands submit() no screenshot at all, so the part can
    // only be the one mount.js went and took.
    expect(captured.report.capture.screenshot).toBe(true);
  });

  it("shows what is on the page", () => {
    const shown = run.results.find((one) => one.position.id === "screenshot/text/ordinary");
    expect(shown.hits.map((hit) => hit.part)).toContain("screenshot");
  });

  it("shows nothing the app named in capture.blank", () => {
    expect(
      run.leaked.map((one) => one.position.id),
      `\n${formatScan(run, { title: "screenshot" })}`,
    ).toEqual([]);
    for (const id of [
      "screenshot/text/sensitive",
      "screenshot/text/blanked",
      "screenshot/field-value/sensitive",
    ]) {
      const one = run.results.find((position) => position.position.id === id);
      expect(one.fate.expect, id).toBe("withheld");
      expect(one.hits, id).toEqual([]);
    }
  });

  it("still sends everything a report needs", () => {
    expect(
      run.missing.map((one) => one.position.id),
      `\n${formatScan(run, { title: "screenshot" })}`,
    ).toEqual([]);
  });

  // The other half of the same claim: with masking off the picture shows the values, which is
  // what proves the masked run withheld them rather than a capture that had quietly lost every
  // field. A withheld position satisfied by a broken picture would look exactly like a clean one.
  describe("with maskAllInputs off", () => {
    let unmasked;
    beforeAll(async () => {
      unmasked = scan(
        await runCapture({
          settings: { ...settings, maskAllInputs: false },
          positions: screenshotPositions(),
          interact: false,
        }),
      );
      extraRuns["screenshot-unmasked"] = unmasked;
    }, 120000);

    it("shows every kind of field value, and still nothing the app blanked", () => {
      for (const id of [
        "screenshot/field-value/ordinary",
        "screenshot/textarea/ordinary",
        "screenshot/select/ordinary",
        "screenshot/editable/ordinary",
      ]) {
        const one = unmasked.results.find((position) => position.position.id === id);
        expect(one.fate.expect, id).toBe("published");
        expect(
          one.hits.map((hit) => hit.part),
          id,
        ).toContain("screenshot");
      }
      expect(unmasked.leaked.map((one) => one.position.id)).toEqual([]);
      expect(unmasked.missing.map((one) => one.position.id)).toEqual([]);
    });
  });

  it("masks every kind of field value under maskAllInputs, the same kinds the recording masks", () => {
    for (const id of [
      "screenshot/field-value/ordinary",
      "screenshot/textarea/ordinary",
      "screenshot/select/ordinary",
      "screenshot/editable/ordinary",
    ]) {
      const one = run.results.find((position) => position.position.id === id);
      expect(one.fate.expect, id).toBe("withheld");
      expect(one.hits, id).toEqual([]);
    }
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
