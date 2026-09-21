// Builds the demo page's `?real=1` entry. A browser with no bundler cannot resolve the bare
// specifiers `@rrweb/record` and `modern-screenshot`, so the sources loaded straight from disk can
// only ever run the panel with stand-ins in their place. This is the build that resolves them —
// the same thing a dashboard's Vite build does — and it is the only way to drive the real recorder
// and the real screenshot in a browser.
//
// `splitting` is what makes it worth building at all: each `import()` becomes a chunk of its own,
// so the network log of a page that never opens the panel is the evidence that the two
// dependencies really are loaded on demand, rather than a promise made by reading the imports.
import { rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const outdir = fileURLToPath(new URL("demo/dist/", root));

await rm(outdir, { recursive: true, force: true });

const result = await build({
  entryPoints: [fileURLToPath(new URL("demo/demo.js", root))],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir,
  target: "es2022",
  metafile: true,
});

// Which chunk is which, decided from what esbuild actually put in each one rather than from a
// file name it chose. The browser test watches for these two paths by name, so a rename or a new
// hash can never turn "the recorder was not downloaded" into a test that was watching for a URL
// nothing was ever going to request.
const manifest = {};
for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  console.log(`${String(meta.bytes).padStart(8)}  ${file}`);
  const inputs = Object.keys(meta.inputs);
  const url = `/${file}`;
  if (inputs.some((one) => one.includes("node_modules/@rrweb/record"))) manifest.recorder = url;
  else if (inputs.some((one) => one.includes("node_modules/modern-screenshot")))
    manifest.screenshot = url;
  else if (file.endsWith("/demo.js")) manifest.entry = url;
}
if (!manifest.recorder || !manifest.screenshot) {
  throw new Error(
    `the two lazy dependencies are not on chunks of their own: ${JSON.stringify(manifest)}`,
  );
}
await writeFile(new URL("demo/dist/chunks.json", root), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
