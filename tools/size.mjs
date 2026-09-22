// What a dashboard actually pays for this library on a page load: `src/index.js` bundled and
// minified the way an app's own build would do it, split into chunks the way an app's build does
// it, then gzipped. The two lazy dependencies are left out because they are fetched at run time
// on chunks of their own, and the panel is measured as a chunk of its own because that is what
// `open()`'s `import()` makes it.
//
// The number this prints is the number to quote. It is measured, not estimated: the entry chunk
// plus every chunk it imports *statically*, which is what the browser downloads before the app
// has done anything. A chunk that is only ever reached through `import()` — the panel — is
// downloaded when somebody opens it and counted separately, so a static import creeping into the
// entry (the one way the panel could sneak back onto every page load) shows up in the number.
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The promise made to the two dashboards (spec §5.1).
export const BUDGET = 15 * 1024;

// The ratchet: what the library measures today, rounded up to the next half kilobyte so a
// different zlib on a different machine cannot fail the build on its own, and lowered every time
// the real number drops. It sits under the budget; the budget is the line that may never be
// crossed, this is the line that stops the gap to it quietly closing.
export const CEILING = 11_776;

const ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));

// Both of these are `import()`ed, never imported: the recorder on the first idle callback and the
// screenshot module when a screenshot is actually taken.
export const LAZY_DEPENDENCIES = ["@rrweb/record", "modern-screenshot"];

// The panel is `import()`ed too, by open(). Anything under this directory belongs on the panel's
// chunk and must not be reachable from the entry by a static import.
export const PANEL_DIR = "src/panel/";

function gz(contents) {
  return gzipSync(contents).length;
}

export async function measure() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: "esm",
    splitting: true,
    outdir: "out",
    write: false,
    metafile: true,
    external: LAZY_DEPENDENCIES,
  });
  const outputs = result.metafile.outputs;
  const bytesOf = Object.fromEntries(
    result.outputFiles.map((file) => {
      // esbuild reports outputs relative to the working directory and names files absolutely.
      const key = Object.keys(outputs).find((one) => file.path.endsWith(`/${one}`));
      return [key, { raw: file.contents.length, gzipped: gz(file.contents) }];
    }),
  );
  const entryKey = Object.keys(outputs).find((one) => outputs[one].entryPoint);

  // The page-load set: the entry and, transitively, everything it imports with a static
  // `import`. Read from the built output rather than from the source, so that what is counted is
  // what the bundle really does.
  const pageLoad = new Set();
  const dynamic = new Map();
  const walk = (key) => {
    if (pageLoad.has(key)) return;
    pageLoad.add(key);
    for (const one of outputs[key].imports || []) {
      if (one.kind === "import-statement") walk(one.path);
      else dynamic.set(one.path, one.kind);
    }
  };
  walk(entryKey);

  const sum = (keys, field) => [...keys].reduce((total, key) => total + bytesOf[key][field], 0);
  const chunks = Object.keys(outputs).map((key) => ({
    file: key,
    ...bytesOf[key],
    onPageLoad: pageLoad.has(key),
    inputs: Object.keys(outputs[key].inputs),
  }));
  return {
    raw: sum(pageLoad, "raw"),
    gzipped: sum(pageLoad, "gzipped"),
    // Every import the page-load set still makes at run time, and how it makes it: the two
    // dependencies and the panel's chunk, all as `dynamic-import`.
    imports: [...dynamic].map(([path, kind]) => ({ path, kind })),
    // What the page load contains, by source file: the panel's files must not be in here.
    pageLoadInputs: [...pageLoad].flatMap((key) => Object.keys(outputs[key].inputs)),
    chunks,
  };
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { raw, gzipped, imports, chunks } = await measure();
  console.log(
    `on page load: minified ${raw} bytes (${kb(raw)}), gzipped ${gzipped} bytes (${kb(gzipped)})`,
  );
  console.log(`budget   ${BUDGET} bytes (${kb(BUDGET)}) — ${kb(BUDGET - gzipped)} under`);
  console.log(`ceiling  ${CEILING} bytes (${kb(CEILING)})`);
  for (const chunk of chunks) {
    const when = chunk.onPageLoad ? "page load" : "on demand";
    console.log(`  ${chunk.gzipped.toString().padStart(6)} gzipped  ${when}  ${chunk.file}`);
  }
  console.log(
    `fetched at run time: ${imports.map((one) => `${one.path} (${one.kind})`).join(", ")}`,
  );
  if (gzipped > CEILING) {
    console.error(`over the ceiling by ${gzipped - CEILING} bytes`);
    process.exit(1);
  }
}
