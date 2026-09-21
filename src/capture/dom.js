// The DOM snapshot (spec §5.3): a clone of the live document with what the user typed stamped
// into attributes — `cloneNode` copies the markup, not the values, so a form in the snapshot
// would otherwise look empty. Passwords are always blanked, every field is blanked under
// maskAllInputs, and the app's `blank` selectors are emptied (spec §5.7).
//
// Everything this file keeps, it publishes: the snapshot is uploaded, attached to a GitHub issue
// and read by people and by an AI, an audience the reporter did not choose. Two rules follow, and
// both are allowlists rather than lists of special cases, because a list of special cases is only
// ever as long as the last person's imagination:
//
//   1. A blanked element keeps its tag name, its `class` and its `id` and NOTHING else — every
//      other attribute removed, every child removed, its whole subtree gone. The valuable things
//      on a dashboard live in attributes (`title="Cost GBP 1,240"`, `data-margin`, an `img alt`
//      naming a customer, an `href` carrying a token, an `iframe srcdoc` holding an invoice), so
//      clearing children and the odd `value` is not blanking. `class` and `id` stay because the
//      app's own developers chose them and they are what makes the blanked shape recognisable in
//      the snapshot; an `id` built out of a record id is the residual risk of that choice, and
//      the app can always name such an element in `blank` — its ancestor is removed whole.
//   2. Everything the serializer publishes must be reachable by the sanitizing walk AND by the
//      app's `blank` selectors. Where it cannot be — a comment (no selector matches one), raw
//      text in an element whose children the parser never made (`<noscript>`, `<iframe>`), a
//      whole document inside an attribute (`srcdoc`) — the snapshot drops it instead. Content
//      that a selector CAN reach (a hidden `<div>`, a `<details>` that is closed, an attribute on
//      an element that was not blanked) is kept: that is the app's call to make, not this file's.
//
// The snapshot is also inert by construction, not by enumeration: `<script>` elements are
// removed (matched on local name, since `querySelectorAll("script")` misses a `SCRIPT` built with
// createElementNS that the HTML parser will happily run when the snapshot is opened), every `on*`
// attribute is removed everywhere, every `javascript:`/`vbscript:` URL and every document-making
// `data:` URL is dropped whatever attribute carries it, `srcdoc` is removed, and a meta refresh
// loses its `content` so the snapshot cannot navigate itself away.
//
// `<style>` elements are kept: the snapshot is meant to look like the page, and CSS cannot run
// script in any browser this library supports. That means the snapshot keeps whatever its CSS
// refers to — `@import url(…)` and `url(…)` backgrounds included — so opening it fetches those
// from the viewer's machine, exactly as `<img src>` and `<link rel=stylesheet>` do. Rewriting CSS
// would mean parsing it (a second sanitizer, with its own escapes) and would strip the page of
// the look the snapshot exists to show, so the decision is deliberate: keep the styles, and treat
// the snapshot as a document that reaches the network when opened.
//
// The live page is never modified: only the detached clone is ever written to, and the clone is
// never attached to any document, so an `<iframe>`'s `src` is never (re)loaded by cloning it.
// Neither `cloneNode` nor `.outerHTML` ever reaches into an `<iframe>`'s content document (same-
// or cross-origin) or into a shadow root's content — both are simply absent from the clone, which
// is what "never reach into either" comes down to in practice: nothing here ever touches
// `contentDocument`/`contentWindow` or a shadow root at all.
//
// snapshotDom must never throw into a host app that is still running on the live page it just
// cloned: any failure — a hostile cloneNode, a detached documentElement, anything else this file
// didn't anticipate — is caught, warned once, and answered with undefined instead of an
// exception. A snapshot that is lost is a report with no DOM in it, so the passes themselves are
// written not to need that net: an element that is not the kind it looks like (a `<template>` in
// the SVG namespace has no `.content`) must not take the whole snapshot down with it.
import { warnOnce } from "../warn.js";

export const BLANKED_ATTR = "data-fbh-blanked";
const FIELDS = "input, textarea, select";

// The only attributes a blanked element keeps (rule 1 above), lower-cased local names.
const BLANK_KEEP_ATTRS = new Set(["class", "id"]);

// Elements whose content the HTML parser tokenizes as RAWTEXT: their children are a single Text
// node with no elements in it, which `querySelectorAll` cannot look inside and the serializer
// prints straight back out, unescaped. A `<script>`, a password value or a `blank`-matched price
// authored in one is published verbatim, and no `blank` selector the app writes can reach it.
// Listed here are the ones a browser never renders, so clearing them loses nothing a reporter
// could see: `<noscript>` (scripting is on, so it is never shown), `<iframe>`'s fallback content,
// `<noframes>` and `<noembed>`. `<xmp>`, `<listing>` and `<plaintext>` are raw text too but ARE
// rendered, so their text is visible page content like any other and is kept.
const HIDDEN_RAW_TEXT = new Set(["noscript", "iframe", "noframes", "noembed"]);

// Elements that turn a URL into a document the browser parses and runs, so a `data:` URL on one
// of them is an XSS route whatever media type it claims.
const DOCUMENT_LOADERS = new Set(["iframe", "frame", "object", "embed", "portal"]);

function tagOf(node) {
  // `localName`, not `tagName`: it is the name the HTML parser matches when the snapshot is read
  // back, and it is defined for foreign-namespace elements too. Lower-cased because case is only
  // normalized for HTML elements created by the parser — `createElementNS(svg, "SCRIPT")` keeps
  // the capitals, evades `querySelectorAll("script")` entirely, and still runs when re-parsed.
  return String(node.localName || "").toLowerCase();
}

// The local (prefix-free) part of an attribute name, lower-cased: `xlink:href` on an SVG element
// is as much an href as `href` is, and an attribute name only keeps its case outside HTML.
function attrLocalName(name) {
  const lower = String(name || "").toLowerCase();
  const colon = lower.indexOf(":");
  return colon === -1 ? lower : lower.slice(colon + 1);
}

// The URL parser strips leading C0 controls and spaces and removes every tab, LF and CR from
// anywhere in the URL before looking at the scheme, so `java&#9;script:` is a javascript: URL and
// a check that only compares a prefix misses it. The leading run is skipped by code point rather
// than by a regexp class, which would be a control character in a regular expression and a lint
// error, fairly enough.
function urlScheme(value) {
  const flat = String(value).replace(/[\t\n\r]/g, "");
  let start = 0;
  while (start < flat.length && flat.charCodeAt(start) <= 0x20) start += 1;
  const url = start === 0 ? flat : flat.slice(start);
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return { scheme: match ? match[1].toLowerCase() : "", url };
}

function isDangerousUrl(value, tag) {
  const { scheme, url } = urlScheme(value);
  if (scheme === "javascript" || scheme === "vbscript") return true;
  if (scheme !== "data") return false;
  // A `data:` image is ordinary page content and is kept; a `data:` document is script waiting to
  // be opened, whether it says so in its media type or is made into one by the element loading it.
  return DOCUMENT_LOADERS.has(tag) || /^data:[^,]*(text\/html|application\/xhtml)/i.test(url);
}

function sanitizeAttributes(el, tag) {
  const attrs = el.attributes;
  if (!attrs || attrs.length === 0) return;
  const isRefresh =
    tag === "meta" && /^[\s]*refresh[\s]*$/i.test(el.getAttribute("http-equiv") || "");
  for (const attr of [...attrs]) {
    const name = String(attr.name || "");
    const local = attrLocalName(name);
    // Deliberately every name that starts with "on", not a list of event names: the list is
    // open-ended, and losing some app's `only=""` attribute from a snapshot costs nothing next to
    // missing one handler that then runs in whatever origin the snapshot is opened in.
    if (local.startsWith("on")) el.removeAttribute(name);
    // A whole document inside an attribute. No pass can sanitize it in place — it would need a
    // parser, a second sanitizer and a re-serializer — so it goes, wherever it appears.
    else if (local === "srcdoc") el.removeAttribute(name);
    else if (isRefresh && local === "content") el.removeAttribute(name);
    // Checked by value, not by attribute name: `href`, `src`, `action`, `formaction`, `xlink:href`
    // and whatever else a framework invents all reduce to "this attribute holds a URL".
    else if (isDangerousUrl(attr.value, tag)) el.removeAttribute(name);
  }
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// One iterative walk over everything the serializer will publish: the root element itself (not
// only its descendants — `querySelectorAll` never matches the element it is called on, which is
// how `<html onload>` survived), every descendant, and every `<template>`'s detached `.content`.
// Iterative rather than recursive so a deeply nested page cannot overflow the stack here.
function sanitizeClone(root) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    const tag = tagOf(node);
    if (node.nodeType === 1) {
      // Matched on the local name here rather than with querySelectorAll("script"), which misses
      // a `SCRIPT` built by createElementNS in any namespace; and removed when it is reached
      // rather than when its parent lists it, so the tag name is worked out once per node.
      if (tag === "script") {
        if (node.parentNode) node.parentNode.removeChild(node);
        continue;
      }
      sanitizeAttributes(node, tag);
    }
    if (HIDDEN_RAW_TEXT.has(tag)) {
      clearChildren(node);
      continue;
    }
    if (tag === "template" && node.content) stack.push(node.content);
    // Walked with firstChild/nextSibling rather than childNodes: a live NodeList costs a walk
    // from the start of the list for every index, so spreading one turns a 6000-row table into a
    // quadratic crawl. `next` is read before the child is removed, so removing is safe here.
    for (let child = node.firstChild; child;) {
      const next = child.nextSibling;
      if (child.nodeType === 1) {
        stack.push(child);
      } else if (child.nodeType !== 3) {
        // Comments (and processing instructions, and CDATA sections) are copied verbatim by
        // cloneNode and printed verbatim by the serializer, and no `blank` selector can match a
        // node that is not an element — so a server-rendered request id, user email or debug dump
        // left in one would be published with no way for the app to stop it.
        node.removeChild(child);
      }
      child = next;
    }
  }
}

// A <template>'s children are never part of the normal tree: `.content` holds them in a detached
// DocumentFragment that querySelectorAll on the template (or any ancestor of it) does not descend
// into — but cloneNode(true)/.outerHTML copy that fragment in full, so anything the selector-based
// passes below (stampValues, blankElements) reach only via querySelectorAll would otherwise pass
// through untouched. `templateRoots` returns every scope that needs its own querySelectorAll call
// to be seen at all: the given root, plus every <template>'s `.content` found anywhere under it,
// applied recursively so a template nested inside another template's content is found too (the
// array grows while the loop walks it, so a newly appended content fragment is itself scanned for
// further nested templates on a later iteration).
//
// Both guards matter. `<template>` is not on the HTML parser's foreign-content breakout list, so
// `<svg><template>` (likewise `<math>`, or createElementNS) is an ordinary element in the SVG
// namespace with no `.content` at all: pushing that `undefined` blew up the next iteration and
// cost the report its entire DOM snapshot — one icon sprite disabling capture for a whole app.
function templateRoots(root) {
  const roots = [];
  if (!root || typeof root.querySelectorAll !== "function") return roots;
  roots.push(root);
  for (let i = 0; i < roots.length; i += 1) {
    for (const template of roots[i].querySelectorAll("template")) {
      const content = template.content;
      if (content && typeof content.querySelectorAll === "function") roots.push(content);
    }
  }
  return roots;
}

// querySelectorAll never matches the element it is called on, so every selector-based pass has to
// test the scope itself as well or the root element is exempt from all of them.
function matchesIn(scope, selector) {
  const found = [];
  if (scope.nodeType === 1 && typeof scope.matches === "function" && scope.matches(selector)) {
    found.push(scope);
  }
  found.push(...scope.querySelectorAll(selector));
  return found;
}

function fieldsIn(roots) {
  const fields = [];
  for (const root of roots) fields.push(...root.querySelectorAll(FIELDS));
  return fields;
}

// contenteditable is an enumerated attribute: absent means "not this element" (it may still
// inherit editability from an ancestor, which is that ancestor's own contenteditable element and
// gets masked there), "false" opts out, and "", "true" and "plaintext-only" all mean editable.
function isEditableHost(el) {
  if (!el.hasAttribute("contenteditable")) return false;
  const value = el.getAttribute("contenteditable").trim().toLowerCase();
  return value === "" || value === "true" || value === "plaintext-only";
}

// `document.designMode = "on"` makes the whole document editable with no contenteditable
// attribute anywhere, so under maskAllInputs its body IS the field and its content is what the
// user typed.
function inDesignMode(el) {
  try {
    const doc = el && el.ownerDocument;
    return Boolean(doc) && String(doc.designMode || "").toLowerCase() === "on";
  } catch {
    return false;
  }
}

export function stampValues(live, clone, options) {
  const maskAllInputs = Boolean(options && options.maskAllInputs);
  const liveRoots = templateRoots(live);
  const cloneRoots = templateRoots(clone);
  const liveFields = fieldsIn(liveRoots);
  const cloneFields = fieldsIn(cloneRoots);
  // Both root lists walk the same light-DOM shape the clone was made from (cloneNode(true)
  // preserves template nesting exactly), so they line up index for index — including skipping
  // shadow-root and <iframe> content identically, since neither call pierces either boundary.
  // Only the shorter length is trusted, in case the two ever disagree. This is also why stamping
  // runs before any pass that removes elements from the clone: drop one field from the clone
  // first and every later field takes the value of a different live one.
  const count = Math.min(liveFields.length, cloneFields.length);
  for (let i = 0; i < count; i += 1) {
    const from = liveFields[i];
    const to = cloneFields[i];
    const tag = from.tagName.toLowerCase();
    if (tag === "input") {
      // `.type` is a spec-reflected IDL attribute: it tracks the content attribute whether that
      // attribute was set in markup or the property was assigned by script after the element
      // already existed, and it normalizes an unrecognized value to "text" instead of echoing
      // back an arbitrary string. Reading it here (not getAttribute) is what keeps a password
      // whose type is flipped by script after render correctly masked.
      const type = String(from.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        // Which options a colleague ticked is exactly what maskAllInputs promises to withhold, so
        // under it the checked state is never carried over — not even the live "false" value.
        if (!maskAllInputs && from.checked) to.setAttribute("checked", "");
        else to.removeAttribute("checked");
        continue;
      }
      const masked = type === "password" || maskAllInputs;
      to.setAttribute("value", masked ? "" : String(from.value ?? ""));
    } else if (tag === "textarea") {
      to.textContent = maskAllInputs ? "" : String(from.value ?? "");
    } else {
      const options = to.querySelectorAll("option");
      for (let j = 0; j < options.length; j += 1) {
        if (!maskAllInputs && j === from.selectedIndex) options[j].setAttribute("selected", "");
        else options[j].removeAttribute("selected");
      }
    }
  }

  // contenteditable holds what was typed as real child nodes, not a hidden `.value` property, so
  // cloneNode already carries it — the only work left is to clear it in the clone when
  // maskAllInputs asks for every field to be withheld. Scanned across the same template-aware
  // roots as everything else, so a contenteditable authored inside a <template> is covered too,
  // and through matchesIn so `<html contenteditable>` is not exempt.
  if (!maskAllInputs) return;
  if (inDesignMode(live)) {
    for (const root of cloneRoots)
      for (const body of matchesIn(root, "body")) body.textContent = "";
  }
  for (const root of cloneRoots) {
    for (const el of matchesIn(root, "[contenteditable]")) {
      if (isEditableHost(el)) el.textContent = "";
    }
  }
}

// `blank` selectors (spec §5.7) must hide a value completely, not just its rendered text: the
// element keeps its tag name, `class` and `id`, and loses everything else (rule 1 at the top of
// this file). That covers the three shapes that used to need their own case and every shape that
// did not get one: a container whose subtree goes with it, a void `<input>` whose typed value
// lives in an attribute, a `<template>` whose real children hide in `.content`, and the long tail
// of `title`, `data-*`, `alt`, `href`, `poster`, `placeholder` and `name`.
function blankOne(el) {
  for (const attr of el.attributes ? [...el.attributes] : []) {
    if (!BLANK_KEEP_ATTRS.has(attrLocalName(attr.name))) el.removeAttribute(attr.name);
  }
  el.textContent = "";
  // `.textContent = ""` only touches a <template>'s (always empty) light-DOM children; its actual
  // content lives in the detached `.content` fragment, which a selector matching the <template>
  // element directly — as opposed to matching an ancestor of one, already covered by the
  // ancestor's own wipe removing the template node whole — would otherwise miss. Tested through
  // the tag name, not by `el.content` alone: `<meta>` has a `content` IDL property too and it is
  // a string, and an SVG-namespaced <template> has none at all.
  if (tagOf(el) === "template" && el.content) clearChildren(el.content);
  el.setAttribute(BLANKED_ATTR, "");
}

// `blank` arrives from the host app's configuration, so it is whatever the app put there. A
// string is taken as the one selector it obviously is rather than iterated character by
// character, and anything else that is not an array is nothing: losing the whole snapshot over a
// mistyped option would be the worst possible answer to it.
function selectorList(selectors) {
  if (typeof selectors === "string") return [selectors];
  return Array.isArray(selectors) ? selectors : [];
}

export function blankElements(clone, selectors) {
  const list = selectorList(selectors);
  if (!list.length) return;
  // Scanned across the template-aware roots too: a `blank` selector can match something authored
  // inside a <template>'s content just as easily as something in the normal tree, and that
  // content is invisible to a plain clone.querySelectorAll call.
  const roots = templateRoots(clone);
  for (const selector of list) {
    for (const root of roots) {
      let matches;
      try {
        matches = matchesIn(root, selector);
      } catch {
        break; // an invalid selector fails the same way on every root; stop trying this one
      }
      for (const el of matches) blankOne(el);
    }
  }
}

export function snapshotDom(doc, options) {
  try {
    const maskAllInputs = Boolean(options && options.maskAllInputs);
    const root = doc.documentElement;
    const clone = root.cloneNode(true);
    // Order is load-bearing: stamp first (it pairs live and cloned fields by index, so nothing may
    // have been removed from the clone yet), then sanitize, then blank.
    stampValues(root, clone, { maskAllInputs });
    sanitizeClone(clone);
    blankElements(clone, options && options.blank);
    return `<!doctype html>\n${clone.outerHTML}`;
  } catch (err) {
    warnOnce("dom snapshot", err);
    return undefined;
  }
}
