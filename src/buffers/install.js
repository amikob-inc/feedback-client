// The four buffers behind one handle, so mount.js has one thing to install and one thing to take
// down. `capture.console` and `capture.network` are the only two an app can switch off (spec
// §5.5); errors and breadcrumbs are always on — they are what makes a report readable at all.
import { installBreadcrumbBuffer } from "./breadcrumbs.js";
import { installConsoleBuffer } from "./console.js";
import { installErrorBuffer } from "./errors.js";
import { installNetworkBuffer } from "./network.js";
import { warnOnce } from "../warn.js";

const none = { entries: () => [], uninstall() {} };

// Each buffer's own uninstall already guards what *it* patched (the console/network/breadcrumb
// fix rounds), but that only protects one buffer's layer from another library's later patch — it
// says nothing about one buffer's uninstall failing outright. A bug in, say, the error buffer's
// uninstall must not cost the app the other three patches back, so every call gets its own
// try/catch: one throwing buffer is reported once and skipped, the rest still come off.
function detach(label, buffer) {
  try {
    buffer.uninstall();
  } catch (err) {
    // A label of its own, not the one the buffer uses for its runtime warnings: warnOnce fires
    // once per label ever, so sharing them would let an unrelated earlier warning swallow the
    // report that a buffer could not be taken off at all.
    warnOnce(`${label} uninstall`, err);
  }
}

// Installing has the same failure mode as uninstalling, and it is the worse one. Unguarded, a
// throw from the third of four buffers escapes, no handle is returned, and the two that did
// install stay patched into the page with nothing left holding a reference to undo them — the
// app keeps a wrapped console and a wrapped fetch for the life of the document. So each install
// is attempted on its own and a failure is reported and skipped rather than propagated: the
// handle still comes back, `installed` still names every buffer that really attached, and
// `uninstall()` can therefore take all of them off. A buffer that fails to install is simply
// absent — its entries are empty and the rest of the library carries on, because a report
// missing its network lines is worth far more than no report at all.
function attach(label, install, installed) {
  try {
    const buffer = install();
    installed.push([label, buffer]);
    return buffer;
  } catch (err) {
    warnOnce(`${label} install`, err);
    return none;
  }
}

export function installBuffers({ win = window, doc = win.document, capture = {} } = {}) {
  const installed = [];
  const consoleBuffer =
    capture.console === false
      ? none
      : attach(
          "console buffer",
          () => installConsoleBuffer({ console: win.console || console }),
          installed,
        );
  const errorBuffer = attach("error buffer", () => installErrorBuffer({ target: win }), installed);
  const networkBuffer =
    capture.network === false
      ? none
      : attach("network buffer", () => installNetworkBuffer({ target: win }), installed);
  const breadcrumbBuffer = attach(
    "breadcrumb buffer",
    () =>
      installBreadcrumbBuffer({
        target: win,
        doc,
        maskAllInputs: !!capture.maskAllInputs,
        // The same selectors the recorder blocks on: a describer that reads an element's text,
        // labels and data attributes has to honour them too.
        blank: Array.isArray(capture.blank) ? capture.blank : [],
      }),
    installed,
  );

  return {
    console: () => consoleBuffer.entries(),
    errors: () => errorBuffer.entries(),
    network: () => networkBuffer.entries(),
    breadcrumbs: () => breadcrumbBuffer.entries(),
    uninstall() {
      // Only what actually installed, and each on its own: a buffer that never attached has
      // nothing to take off, and one that throws on the way out does not keep the others on.
      while (installed.length) {
        const entry = installed.pop();
        if (entry) detach(entry[0], entry[1]);
      }
    },
  };
}
