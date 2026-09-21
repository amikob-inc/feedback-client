// What a dashboard actually pays for this library: `src/index.js` bundled and minified the way an
// app's own build would do it, then gzipped, with the two lazy dependencies left out because they
// are fetched at run time on chunks of their own.
//
// The number this prints is the number to quote. It is measured, not estimated, and the build it
// measures is the whole of `src/` — nothing is excluded for being rarely used, because a module
// that is statically imported is downloaded whether or not anyone reaches it.
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The promise made to the two dashboards (spec §5.1).
export const BUDGET = 15 * 1024;

// The ratchet. It is what the library measures today, rounded up to the next half kilobyte so a
// different zlib on a different machine cannot fail the build on its own, and it is lowered every
// time the real number drops. It is deliberately *not* the budget: the library is over the budget
// and the only way under it is to load the panel on demand (see `measureSplit` below and the
// README), which is a change to what `open()` promises and therefore not one to make quietly.
// Until that is done this is what stops the gap growing.
export const CEILING = 19_968;

const ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));

// Both of these are `import()`ed, never imported: the recorder on the first idle callback and the
// screenshot module when a screenshot is actually taken.
export const LAZY_DEPENDENCIES = ["@rrweb/record", "modern-screenshot"];

async function bundle(external) {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: "esm",
    write: false,
    metafile: true,
    external,
  });
  const code = result.outputFiles[0].contents;
  return { code, metafile: result.metafile };
}

export async function measure() {
  const { code, metafile } = await bundle(LAZY_DEPENDENCIES);
  const output = Object.values(metafile.outputs)[0];
  // Straight from the built output rather than from reading the source: every import the bundle
  // still has to make at run time, and how it makes it. A dependency that had crept into the
  // bundle would not be here at all, and one that had become a static import would say so.
  const imports = (output.imports || []).map((one) => ({ path: one.path, kind: one.kind }));
  return { raw: code.length, gzipped: gzipSync(code).length, imports };
}

// The same measurement with the panel treated as a run-time chunk as well, which is what it would
// cost a dashboard if `open()` loaded it on demand. Reported beside the real number so the
// argument for doing that is never a guess.
export async function measureSplit() {
  const { code } = await bundle([...LAZY_DEPENDENCIES, "./panel/panel.js"]);
  return { raw: code.length, gzipped: gzipSync(code).length };
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { raw, gzipped, imports } = await measure();
  const split = await measureSplit();
  console.log(`minified ${raw} bytes (${kb(raw)})`);
  console.log(`gzipped  ${gzipped} bytes (${kb(gzipped)})`);
  console.log(`budget   ${BUDGET} bytes (${kb(BUDGET)}) — ${kb(gzipped - BUDGET)} over`);
  console.log(`ceiling  ${CEILING} bytes (${kb(CEILING)})`);
  console.log(
    `left out of the bundle: ${imports.map((one) => `${one.path} (${one.kind})`).join(", ")}`,
  );
  console.log(
    `with the panel loaded on demand it would be ${split.gzipped} bytes (${kb(split.gzipped)})`,
  );
  if (gzipped > CEILING) {
    console.error(`over the ceiling by ${gzipped - CEILING} bytes`);
    process.exit(1);
  }
}
