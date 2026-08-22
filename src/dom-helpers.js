// DOM value / selection helpers shared by content.js and vim-field.js.
// Two responsibilities live here: (1) deciding which elements we should
// take over ("Eligibility"), and (2) reading/writing an element's text
// and selection in a way that plays nicely with frameworks like React
// that intercept the native value setter.
(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // Eligibility
  // ---------------------------------------------------------------------
  // Only input types that Chrome actually exposes selectionStart/selectionEnd/
  // setSelectionRange on. Notably "email" and "number" are NOT in this list —
  // accessing selection on them throws, which used to abort our keydown
  // handler mid-flight (before preventDefault ran) and could leave the field
  // in a broken state.
  const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password", ""]);

  function isEligible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return TEXT_INPUT_TYPES.has(type);
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // DOM value / selection helpers (React & friends compatible)
  // ---------------------------------------------------------------------
  // Content scripts run in an isolated JS world: the page can freely
  // monkey-patch its own `window.HTMLInputElement.prototype`, but that
  // can't reach the separate copy of that prototype living in this world.
  // Reading the setter from *our* `window` therefore always gets the real,
  // un-tampered-with native setter — which is also exactly what lets this
  // bypass frameworks like React that override the instance's own `value`
  // property to detect only their own writes.
  function nativeValueSetter(el) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, "value").set;
  }

  function setInputValue(el, value) {
    nativeValueSetter(el).call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText" }));
  }

  function setCEText(el, value) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText" }));
  }

  function ceOffsetToRange(el, start, end) {
    const range = document.createRange();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let remStart = start;
    let remEnd = end;
    let startSet = false;
    let endSet = false;
    let n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (!startSet && remStart <= len) {
        range.setStart(n, Math.max(0, remStart));
        startSet = true;
      }
      if (!endSet && remEnd <= len) {
        range.setEnd(n, Math.max(0, remEnd));
        endSet = true;
        break;
      }
      remStart -= len;
      remEnd -= len;
    }
    if (!startSet) range.setStart(el, el.childNodes.length);
    if (!endSet) range.setEnd(el, el.childNodes.length);
    return range;
  }

  function ceGetOffsets(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return { start: 0, end: 0 };
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.startContainer, r.startOffset);
    const start = pre.toString().length;
    pre.setEnd(r.endContainer, r.endOffset);
    const end = pre.toString().length;
    return { start, end };
  }

  function ceSetOffsets(el, start, end) {
    const range = ceOffsetToRange(el, start, end);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  global.VimDomHelpers = {
    isEligible,
    setInputValue,
    setCEText,
    ceGetOffsets,
    ceSetOffsets,
  };
})(typeof window !== "undefined" ? window : globalThis);
