// The strings the demo page plants in the places a capture could carry them out of the page, and
// the one string that is ordinary public text. The browser test asks the stub hub which of these
// it can find in what arrived, so each marker is a claim: the private ones must be absent, and
// PUBLIC must be present — a search that finds nothing at all looks exactly like a clean report,
// which is why the control marker is part of the same list.
//
// Deliberately one unbroken token each: a value split across nodes, encoded or re-escaped on the
// way would slip past a plain substring search and read as "not leaked".
export const MARKERS = {
  // Ordinary visible page text. Present in the recording, and its absence means the search is
  // looking in the wrong place rather than that the page kept its secrets.
  PUBLIC: "FBHPUBLICMARKER",
  // A password field's value. Never leaves, under any setting.
  PASSWORD: "FBHPASSWORDMARKER",
  // Text inside an element the app named in `capture.blank`.
  BLANKED: "FBHBLANKEDMARKER",
  // A token in a link's query string, the shape cad-dashboard's magic-link redirect really has.
  TOKEN: "FBHTOKENMARKER",
  // Ordinary text inside a same-origin iframe: present, and the proof that the recorder's own
  // iframe path ran at all.
  IFRAME_PUBLIC: "FBHIFRAMEPUBLICMARKER",
  // A password field's value inside that same iframe.
  IFRAME_PASSWORD: "FBHIFRAMEPASSWORDMARKER",
  // Text inside an element that matches the app's `capture.blank` selector, but in the child
  // document rather than the main one: the selector is configured once, on the main page, and
  // whether it reaches a second document is a question only a real browser can answer.
  IFRAME_BLANKED: "FBHIFRAMEBLANKEDMARKER",
  // Text rendered inside an `<iframe srcdoc>`: on screen, so the recording is expected to carry
  // it the way it carries any other visible text.
  SRCDOC: "FBHSRCDOCMARKER",
  // The other half of the same frame, in an HTML comment: never rendered, and reachable only by
  // reading the srcdoc attribute itself, which is the reason that attribute is withheld. Present
  // in the recording would mean the attribute travelled after all.
  SRCDOC_HIDDEN: "FBHSRCDOCHIDDENMARKER",
};

// Two solid colours the page paints as images of the same size, one inside the blanked region and
// one outside it. PNG is lossless, so the sent screenshot can be read back pixel for pixel and
// asked a question with only one right answer: OPEN must be in the raster (or the reader is
// looking at the wrong picture) and BLANKED must not be anywhere in it.
export const SWATCHES = {
  OPEN: [0, 170, 255],
  BLANKED: [255, 0, 170],
};
