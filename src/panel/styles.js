// The panel's whole stylesheet. It lives in the shadow root, so nothing here can reach the app
// and nothing in the app can reach the panel (spec §5.4). Colour comes from thirteen custom
// properties with light and dark defaults; an app maps its own tokens onto `#fbh-host` from its
// own stylesheet, and an id selector from outside beats `:host` from inside, which is what makes
// that mapping work (spec §5.6). That override channel is deliberately left as a normal
// (non-`!important`) declaration below: `!important` would also win against an app's own mapping,
// which is exactly backwards from what §5.6 asks for.
//
// The string below ships to every page that mounts the panel, verbatim: a minifier can shorten
// the code around it but never its contents, so the explanations that belong to individual rules
// are written here, as JavaScript, where they cost a reader nothing and the dashboards nothing.
//
// `:host` rules, in the order they appear:
//
// - `all: initial` is the reset. It is a normal declaration, so an app's own mapping of the
//   thirteen custom properties still wins, which is the point.
// - `display: block !important` is the one property on `:host` that is important, and the reason
//   is that a host application's own global reset (a bare `* { display: none }`, say) targets
//   this element too: it is a normal node in the app's light DOM, and Shadow DOM only protects
//   what is *inside* the boundary, never the host's own box. A shadow tree's important
//   declaration beats a light-DOM normal declaration for the same property on the same element
//   regardless of which was written last, so a page-wide reset cannot delete the panel (spec
//   §5.4, "may never break the host application"). It carries no colour or spacing, only the one
//   property standing between "hidden" and "there".
// - `:host([hidden])` is the way back out of that lock. A shadow tree's important also beats the
//   outer page's important, which would otherwise leave a dashboard no way to hide its own host
//   element even deliberately. The hidden attribute is the platform's own "not relevant right
//   now": an app sets it on purpose, and no page-wide reset sets it by accident.
// - `:host([data-theme="dark"])` is the dark set of the same thirteen properties, keyed off the
//   attribute the panel writes on every open from the app's `theme()` hook.
//
// `.fbh-overlay` then resets the inherited properties a second time, and that block is not
// decoration either. A shadow root keeps the page's *selectors* out, but every inherited property
// still flows in through the host element, and `:host { all: initial }` is a normal declaration
// that loses to an important one written in the page. A page-wide `visibility: hidden !important`
// on every div therefore reached the whole panel through inheritance and hid it as thoroughly as
// `display: none` would have — the same failure the important `display` above exists to prevent,
// through a door it does not cover. An inherited property can be taken back by declaring it on an
// element inside the shadow tree, which is what that block does, once, on the outermost one:
// everything else in the panel inherits from it rather than from the host. Measured in a real
// browser against a deliberately hostile page reset; jsdom computes none of this.
//
// What cannot be defended from inside, and is documented rather than fixed: `opacity`, `filter`,
// `transform` and friends apply to the host's own box and take the whole shadow tree with them.
// A page that dims or moves the host dims or moves the panel, and no declaration inside the
// shadow root can undo it.
export const THEME_PROPERTIES = [
  "--fbh-bg",
  "--fbh-panel",
  "--fbh-text",
  "--fbh-muted",
  "--fbh-hairline",
  "--fbh-border",
  "--fbh-accent",
  "--fbh-accent-on",
  "--fbh-danger",
  "--fbh-success",
  "--fbh-tag-bg",
  "--fbh-tag-text",
  "--fbh-font",
];

export const PANEL_CSS = `
:host {
--fbh-bg: #ffffff;
--fbh-panel: #ffffff;
--fbh-text: #1b1b1f;
--fbh-muted: #6b7280;
--fbh-hairline: #ececf1;
--fbh-border: #d7d7de;
--fbh-accent: #111827;
--fbh-accent-on: #ffffff;
--fbh-danger: #c0392b;
--fbh-success: #12805c;
--fbh-tag-bg: #f1f1f5;
--fbh-tag-text: #45454f;
--fbh-font: system-ui, -apple-system, "Segoe UI", sans-serif;
all: initial;
display: block !important;
}
:host([hidden]) { display: none !important; }
:host([data-theme="dark"]) {
--fbh-bg: #17171b;
--fbh-panel: #1f1f25;
--fbh-text: #f2f2f5;
--fbh-muted: #a0a0ab;
--fbh-hairline: #2b2b33;
--fbh-border: #3a3a44;
--fbh-accent: #e8e8ee;
--fbh-accent-on: #17171b;
--fbh-danger: #ff6b5e;
--fbh-success: #46c79a;
--fbh-tag-bg: #2b2b33;
--fbh-tag-text: #d7d7de;
}
.fbh-overlay {
position: fixed; inset: 0; z-index: 2147483000;
display: flex; align-items: flex-end; justify-content: flex-end;
background: rgba(0, 0, 0, 0.42);
font-family: var(--fbh-font); color: var(--fbh-text);
font-size: 13px; line-height: 1.45;
visibility: visible; font-style: normal; font-weight: 400; font-variant: normal;
letter-spacing: normal; word-spacing: normal; text-align: start; text-indent: 0;
text-shadow: none; text-transform: none; white-space: normal;
}
.fbh-overlay[hidden] { display: none; }
.fbh-panel {
width: min(460px, 100vw); max-height: 88vh; background: var(--fbh-panel);
border: 1px solid var(--fbh-border); border-radius: 14px 14px 0 0;
display: flex; flex-direction: column; overflow: hidden;
box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.25);
}
@media (min-width: 520px) {
.fbh-overlay { align-items: center; justify-content: center; }
.fbh-panel { border-radius: 14px; margin: 20px; }
}
.fbh-head {
display: flex; align-items: center; justify-content: space-between;
padding: 14px 16px; border-bottom: 1px solid var(--fbh-hairline);
}
.fbh-title { margin: 0; font-size: 15px; font-weight: 600; }
.fbh-close {
background: none; border: 0; font-size: 18px; line-height: 1; cursor: pointer; color: var(--fbh-muted);
}
.fbh-body { padding: 14px 16px; overflow-y: auto; }
.fbh-form { display: grid; gap: 9px; padding-bottom: 12px; border-bottom: 1px dashed var(--fbh-hairline); }
.fbh-fields { display: flex; gap: 9px; }
.fbh-fields > * { flex: 1; }
.fbh-field { display: block; }
.fbh-label { display: block; margin-bottom: 3px; font-size: 11px; font-weight: 600; color: var(--fbh-muted); }
.fbh-input {
width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit; font-size: 13px;
color: var(--fbh-text); background: var(--fbh-bg);
border: 1px solid var(--fbh-border); border-radius: 8px;
}
.fbh-textarea { min-height: 64px; resize: vertical; }
.fbh-strip { display: flex; flex-wrap: wrap; gap: 8px; }
.fbh-strip:empty { display: none; }
.fbh-thumb {
position: relative; margin: 0; width: 84px; font-size: 10.5px; color: var(--fbh-muted); text-align: center;
}
.fbh-thumb-img {
display: block; width: 84px; height: 56px; object-fit: cover;
border: 1px solid var(--fbh-border); border-radius: 6px; background: var(--fbh-tag-bg);
}
.fbh-thumb-remove, .fbh-thumb-draw {
position: absolute; top: 2px; border: 0; border-radius: 50%; width: 18px; height: 18px;
cursor: pointer; font-size: 10px; line-height: 1; color: var(--fbh-accent-on); background: var(--fbh-accent);
}
.fbh-thumb-remove { right: 2px; }
.fbh-thumb-draw { right: 24px; }
.fbh-annotator-mount[hidden] { display: none; }
.fbh-annotator {
display: flex; flex-direction: column; gap: 8px;
padding: 10px; border: 1px solid var(--fbh-border); border-radius: 10px; background: var(--fbh-bg);
}
.fbh-annotator-stage { max-height: 40vh; overflow: auto; }
.fbh-annotator-canvas { max-width: 100%; height: auto; cursor: crosshair; touch-action: none; }
.fbh-annotator-hint { margin: 6px 0 0; font-size: 11px; color: var(--fbh-muted); }
.fbh-annotator-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
.fbh-annotator-status { margin: 0; font-size: 11.5px; color: var(--fbh-danger); }
.fbh-annotator-status:empty { display: none; }
.fbh-form-annotating .fbh-strip, .fbh-form-annotating .fbh-submit-row { opacity: 0.4; pointer-events: none; }
.fbh-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.fbh-hidden-file { display: none; }
.fbh-note, .fbh-message, .fbh-row-message { margin: 0; font-size: 11.5px; color: var(--fbh-muted); }
.fbh-message:empty, .fbh-row-message:empty { display: none; }
.fbh-status-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.fbh-retry-slot:empty { display: none; }
.fbh-check { display: flex; gap: 6px; align-items: center; font-size: 11.5px; color: var(--fbh-muted); }
.fbh-submit-row { display: flex; justify-content: flex-end; }
.fbh-primary {
padding: 8px 16px; border: 0; border-radius: 8px; cursor: pointer; font: inherit; font-weight: 600;
background: var(--fbh-accent); color: var(--fbh-accent-on);
}
.fbh-primary[disabled] { opacity: 0.6; cursor: default; }
.fbh-ghost {
padding: 6px 10px; border: 1px solid var(--fbh-border); border-radius: 7px; cursor: pointer;
font: inherit; font-size: 11.5px; font-weight: 600; background: none; color: var(--fbh-text);
}
.fbh-inline { margin-left: 6px; }
.fbh-reports { padding-top: 12px; }
.fbh-subhead { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--fbh-muted); }
.fbh-empty { margin: 0; padding: 14px 0; text-align: center; font-size: 12.5px; color: var(--fbh-muted); }
.fbh-empty[hidden] { display: none; }
.fbh-list { list-style: none; margin: 0; padding: 0; }
.fbh-row { padding: 10px 0; border-bottom: 1px solid var(--fbh-hairline); }
.fbh-row:last-child { border-bottom: 0; }
.fbh-row-head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
.fbh-tag {
padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600;
background: var(--fbh-tag-bg); color: var(--fbh-tag-text);
}
.fbh-who, .fbh-when { font-size: 10.5px; color: var(--fbh-muted); }
.fbh-pill {
margin-left: auto; padding: 2px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 700;
background: var(--fbh-tag-bg); color: var(--fbh-tag-text);
}
.fbh-pill-open { background: var(--fbh-accent); color: var(--fbh-accent-on); }
.fbh-pill-done { background: var(--fbh-success); color: var(--fbh-accent-on); }
.fbh-pill-attention, .fbh-pill-bad { background: var(--fbh-danger); color: #ffffff; }
.fbh-pill-muted { color: var(--fbh-muted); }
.fbh-row-text { margin: 0; white-space: pre-wrap; word-break: break-word; }
.fbh-answer, .fbh-reason, .fbh-progress { margin: 6px 0 0; font-size: 12.5px; color: var(--fbh-muted); }
.fbh-answer { color: var(--fbh-text); }
.fbh-questions, .fbh-replies { margin: 6px 0 0; padding-left: 18px; font-size: 12.5px; color: var(--fbh-muted); }
.fbh-links { display: flex; gap: 10px; margin: 6px 0 0; }
.fbh-link { font-size: 11.5px; font-weight: 600; color: var(--fbh-accent); }
:host([data-theme="dark"]) .fbh-link { color: var(--fbh-text); }
.fbh-reply-row { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; }
.fbh-reply { min-height: 38px; }
`;
