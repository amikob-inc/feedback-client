import { defineConfig } from "@playwright/test";

// One chromium project against the stub hub. The page is served from localhost and the hub is
// addressed as 127.0.0.1 — the same process, two origins — so every call the panel makes is a real
// cross-origin request with a preflight, the way it will be in production.
//
// `deviceScaleFactor: 2` is not decoration. The annotator maps pointer positions into image
// pixels, and at a device pixel ratio of 1 a mapping that multiplied or divided by it would pass
// anyway; every run here happens at 2 so that class of bug cannot hide. The default viewport is
// deliberately small for the same reason: it is what a 200% zoom looks like to the page.
const PORT = Number(process.env.STUB_PORT || 8787);

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  expect: { timeout: 7_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One worker: the stub hub keeps the last submission and the list of submitted reports in
  // memory, and each test resets both. Two workers would read each other's.
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    viewport: { width: 900, height: 700 },
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
  },
  webServer: {
    // The bundle has to exist before the first `?real=1` page is opened, and it is built from the
    // library's own sources, so it is rebuilt on every run rather than trusted from last time.
    // That only holds while this command always runs: with `reuseExistingServer` (which used to
    // be on outside CI) a `pnpm demo` left up, or a previous run's server still dying, was
    // adopted, the build skipped, and the suite passed locally against last time's bundle — a
    // false green on the four claims only this suite can make. CI never reused a server; a
    // developer's machine now does not either. The port has to be free, and the run says so if
    // it is not.
    command: "node tools/build-demo.mjs && node tests/stub-hub.mjs",
    url: `http://localhost:${PORT}/livez`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
