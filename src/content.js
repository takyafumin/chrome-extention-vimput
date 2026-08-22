// Glue layer: page-level settings (enable/disable), the Normal-mode
// indicator badge + block-cursor rendering, and wiring VimField up to
// real focus/keydown events. The modal-editing logic itself lives in
// vim-field.js; element eligibility/IO helpers live in dom-helpers.js.
(function () {
  "use strict";
  const E = window.VimTextEngine;
  const D = window.VimDomHelpers;

  // ---------------------------------------------------------------------
  // Settings (global toggle + per-site override)
  //
  // globalEnabled lives in storage.sync — a single boolean, harmless to
  // sync across the user's devices. siteOverrides maps hostnames to a
  // choice and is privacy-sensitive (effectively a fragment of browsing
  // history), so it stays in storage.local and is never sent through
  // Chrome Sync (see background.js).
  //
  // Loaded lazily (loadSettingsOnce, called from the focusin handler)
  // rather than unconditionally at script load: with all_frames:true this
  // script runs in every iframe on every page, and most iframes (ads,
  // trackers, etc.) never contain a field a user actually focuses, so
  // there's no reason to spend a storage read on them.
  // ---------------------------------------------------------------------
  let globalEnabled = true;
  let siteOverrides = {};
  let settingsLoadPromise = null;

  function loadSettingsOnce() {
    if (!settingsLoadPromise) {
      settingsLoadPromise = Promise.all([
        chrome.storage.sync.get(["globalEnabled"]).catch(() => ({})),
        chrome.storage.local.get(["siteOverrides"]).catch(() => ({})),
      ]).then(([syncVals, localVals]) => {
        if (typeof syncVals.globalEnabled === "boolean") globalEnabled = syncVals.globalEnabled;
        if (localVals.siteOverrides) siteOverrides = localVals.siteOverrides;
      });
    }
    return settingsLoadPromise;
  }

  function siteEnabled() {
    const host = location.hostname;
    if (Object.prototype.hasOwnProperty.call(siteOverrides, host)) return siteOverrides[host];
    return globalEnabled;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.globalEnabled) {
      globalEnabled = changes.globalEnabled.newValue;
    } else if (area === "local" && changes.siteOverrides) {
      siteOverrides = changes.siteOverrides.newValue || {};
    } else {
      return;
    }
    if (!siteEnabled()) {
      activeField = null;
      activeEl = null;
      hideIndicator();
    }
  });

  // ---------------------------------------------------------------------
  // Mode indicator (shadow DOM overlay)
  // ---------------------------------------------------------------------
  let indicatorHost = null;
  let indicatorEl = null;

  function ensureIndicator() {
    if (indicatorHost) return;
    indicatorHost = document.createElement("div");
    indicatorHost.style.all = "initial";
    indicatorHost.style.position = "fixed";
    indicatorHost.style.zIndex = "2147483647";
    indicatorHost.style.pointerEvents = "none";
    const shadow = indicatorHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      ".badge{font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;" +
      "padding:2px 7px;border-radius:4px;color:#fff;white-space:nowrap;" +
      "box-shadow:0 1px 4px rgba(0,0,0,.35);letter-spacing:.04em}" +
      ".normal{background:#2b6cb0}.insert{background:#2f855a}.visual{background:#b7791f}.vline{background:#6b46c1}";
    indicatorEl = document.createElement("div");
    indicatorEl.className = "badge";
    shadow.appendChild(style);
    shadow.appendChild(indicatorEl);
    document.documentElement.appendChild(indicatorHost);
  }

  function positionIndicator(el) {
    if (!indicatorHost) return;
    const r = el.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 24, r.bottom + 4);
    const left = Math.max(4, r.left);
    indicatorHost.style.top = top + "px";
    indicatorHost.style.left = left + "px";
  }

  function showIndicator(el, mode, visualKind) {
    ensureIndicator();
    let label = "NORMAL";
    let cls = "normal";
    if (mode === "insert") {
      label = "INSERT";
      cls = "insert";
    } else if (mode === "visual") {
      label = visualKind === "line" ? "V-LINE" : "VISUAL";
      cls = visualKind === "line" ? "vline" : "visual";
    }
    indicatorEl.textContent = label;
    indicatorEl.className = "badge " + cls;
    positionIndicator(el);
    indicatorHost.style.display = "block";
  }

  function hideIndicator() {
    if (indicatorHost) indicatorHost.style.display = "none";
  }

  // ---------------------------------------------------------------------
  // Wiring: track the focused eligible field and forward keydown to it
  // ---------------------------------------------------------------------
  const fields = new WeakMap();
  let activeField = null;
  let activeEl = null;

  function getField(el) {
    let f = fields.get(el);
    if (!f) {
      f = new window.VimField(el);
      fields.set(el, f);
    }
    return f;
  }

  function updateIndicatorForActive() {
    if (!activeField) {
      hideIndicator();
      return;
    }
    showIndicator(activeField.el, activeField.mode, activeField.visualMode);
  }

  // Textareas/inputs have no way to draw a real block cursor, so in Normal
  // mode we fake one by selecting the single character under the cursor —
  // the browser's native selection highlight then reads as a block. This is
  // purely cosmetic: getCursor() always returns selectionStart, so nothing
  // in the engine's own logic is affected by selectionEnd being extended
  // here. Insert mode keeps the real collapsed caret; Visual mode already
  // shows a real (possibly multi-char) selection and is left alone.
  function applyCursorDisplay(field) {
    if (!field || field.mode !== "normal") return;
    const text = field.getText();
    const cur = field.getCursor();
    const { end } = E.lineBounds(text, cur);
    const blockEnd = Math.min(end, cur + 1);
    field.setSel(cur, blockEnd > cur ? blockEnd : cur);
  }

  // Listeners are attached to `window` (not `document`) with capture, and the
  // content script runs at document_start, so we get first crack at keydown
  // before any of the page's own scripts have even run — some sites react to
  // Escape themselves (closing a modal/tooltip) and blur the field as a side
  // effect, which would otherwise beat us to it.
  window.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      loadSettingsOnce().then(() => {
        // Settings may still have been loading at the moment this focus
        // happened (first focus in a fresh frame); re-validate once the
        // real value is known instead of trusting the optimistic default.
        if (el === activeEl && !siteEnabled()) {
          activeField = null;
          activeEl = null;
          hideIndicator();
        }
      });
      if (!siteEnabled() || !D.isEligible(el)) {
        activeField = null;
        activeEl = null;
        hideIndicator();
        return;
      }
      activeEl = el;
      activeField = getField(el);
      if (activeField.preserveModeOnNextFocus) {
        // We just recovered focus ourselves (see the keydown handler below)
        // after something outside our control blurred the field; keep the
        // mode the user was in instead of snapping back to Insert.
        activeField.preserveModeOnNextFocus = false;
      } else {
        activeField.mode = "insert";
        activeField.resetPending();
      }
      applyCursorDisplay(activeField);
      updateIndicatorForActive();
    },
    true
  );

  window.addEventListener(
    "focusout",
    (e) => {
      if (e.target === activeEl) {
        activeField = null;
        activeEl = null;
        hideIndicator();
      }
    },
    true
  );

  window.addEventListener(
    "keydown",
    (e) => {
      if (!activeField || activeEl !== e.target || !siteEnabled()) return;
      const field = activeField;
      const el = field.el;
      const prevMode = field.mode;
      let handled = false;
      try {
        handled = field.handleKey(e);
      } catch (err) {
        console.error("[vim-for-text-fields] key handling failed:", err);
      }
      const modeChanged = field.mode !== prevMode;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        applyCursorDisplay(field);
        if (modeChanged) {
          // Guard against something outside our control (OS/IME/browser-
          // level handling of certain keys, notably Escape) yanking focus
          // away right after we've handled a key ourselves. Scoped to mode
          // transitions only — the observed conflict was specifically a
          // site's own Escape/close-modal handler racing ours, and doing
          // this on every single motion keystroke would mean allocating and
          // scheduling a timer on every keypress for no benefit.
          setTimeout(() => {
            if (document.activeElement !== el && document.body.contains(el)) {
              field.preserveModeOnNextFocus = true;
              el.focus({ preventScroll: true });
              applyCursorDisplay(field);
            }
          }, 0);
        }
      }
      if (handled || modeChanged) updateIndicatorForActive();
    },
    true
  );

  document.addEventListener(
    "scroll",
    () => {
      if (activeField) positionIndicator(activeField.el);
    },
    true
  );
  window.addEventListener("resize", () => {
    if (activeField) positionIndicator(activeField.el);
  });
})();
