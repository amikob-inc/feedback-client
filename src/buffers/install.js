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
    warnOnce(label, err);
  }
}

export function installBuffers({ win = window, doc = win.document, capture = {} } = {}) {
  const consoleBuffer =
    capture.console === false ? none : installConsoleBuffer({ console: win.console || console });
  const errorBuffer = installErrorBuffer({ target: win });
  const networkBuffer = capture.network === false ? none : installNetworkBuffer({ target: win });
  const breadcrumbBuffer = installBreadcrumbBuffer({
    target: win,
    doc,
    maskAllInputs: !!capture.maskAllInputs,
  });

  return {
    console: () => consoleBuffer.entries(),
    errors: () => errorBuffer.entries(),
    network: () => networkBuffer.entries(),
    breadcrumbs: () => breadcrumbBuffer.entries(),
    uninstall() {
      detach("console buffer", consoleBuffer);
      detach("error buffer", errorBuffer);
      detach("network buffer", networkBuffer);
      detach("breadcrumb buffer", breadcrumbBuffer);
    },
  };
}
