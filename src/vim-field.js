// VimField: the Normal/Insert/Visual modal-editing state machine bound to
// one DOM element. Depends on VimTextEngine (pure text/index math) and
// VimDomHelpers (element value/selection IO); content.js owns wiring it
// up to the page (focus tracking, key dispatch, the mode indicator).
(function (global) {
  "use strict";
  const E = global.VimTextEngine;
  const D = global.VimDomHelpers;

  const JJ_ESCAPE_MS = 350;

  const PASSTHROUGH_KEYS = new Set([
    "Tab", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    "PageUp", "PageDown", "Home", "End", "Insert", "ContextMenu", "PrintScreen",
  ]);

  // Hoisted so handleNormalOrVisualKey (called on every Normal/Visual mode
  // keystroke) doesn't allocate a fresh array to test membership in each time.
  const MODIFIER_ONLY_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

  class VimField {
    constructor(el) {
      this.el = el;
      this.isCE = !!el.isContentEditable;
      this.mode = "insert";
      this.countBuf = "";
      this.pendingOperator = null;
      this.opCount = 1;
      this.pendingFind = null;
      this.pendingFindCount = 1;
      this.lastFind = null;
      this.gPending = false;
      this.pendingCountForG = null;
      this.register = "";
      this.registerLinewise = false;
      this.desiredCol = null;
      this.undoStack = [];
      this.redoStack = [];
      this.visualAnchor = 0;
      this.visualHead = 0;
      this.visualMode = null;
      this.lastChange = null;
      this.insertStart = null;
      this.preserveModeOnNextFocus = false;
      this.pendingJTime = 0;
    }

    // ---- text / selection IO ----
    getText() {
      return this.isCE ? this.el.textContent : this.el.value;
    }
    setText(v) {
      if (this.isCE) D.setCEText(this.el, v);
      else D.setInputValue(this.el, v);
    }
    getSel() {
      try {
        if (this.isCE) return D.ceGetOffsets(this.el);
        return { start: this.el.selectionStart, end: this.el.selectionEnd };
      } catch (_) {
        return { start: 0, end: 0 };
      }
    }
    setSel(start, end) {
      end = end === undefined ? start : end;
      try {
        if (this.isCE) D.ceSetOffsets(this.el, start, end);
        else this.el.setSelectionRange(start, end);
      } catch (_) {
        // Some input types (e.g. email, number) don't support the selection
        // API; fail silently rather than aborting the key handler mid-flight.
      }
    }
    getCursor() {
      return this.getSel().start;
    }
    applyChange(newText, cursor) {
      this.setText(newText);
      this.setSel(cursor);
    }
    commit(newText, cursor) {
      this.undoStack.push({ text: this.getText(), cursor: this.getCursor() });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.applyChange(newText, cursor);
    }
    undo() {
      if (!this.undoStack.length) return;
      const cur = { text: this.getText(), cursor: this.getCursor() };
      const prev = this.undoStack.pop();
      this.redoStack.push(cur);
      this.applyChange(prev.text, prev.cursor);
    }
    redo() {
      if (!this.redoStack.length) return;
      const cur = { text: this.getText(), cursor: this.getCursor() };
      const next = this.redoStack.pop();
      this.undoStack.push(cur);
      this.applyChange(next.text, next.cursor);
    }

    resetPending() {
      this.pendingOperator = null;
      this.opCount = 1;
      this.pendingFind = null;
      this.gPending = false;
      this.countBuf = "";
    }

    consumeCount() {
      const n = this.countBuf === "" ? null : parseInt(this.countBuf, 10);
      this.countBuf = "";
      return n;
    }

    // ---- top-level dispatch. returns true if the key was consumed. ----
    handleKey(e) {
      // While an IME composition is in progress (e.g. typing full-width
      // romaji before conversion), keydown still fires per keystroke but the
      // browser owns the text — it hasn't been committed to the field yet.
      // Acting on these (in particular the jj-escape check below) used to
      // fire "handled" and flip to Normal mode without being able to find a
      // literal "j" to delete, since what's in the field mid-composition is
      // whatever full-width/kana text the IME is building, not "j". Leaving
      // composition keystrokes alone lets the IME finish normally; Escape
      // during composition also then correctly cancels the composition
      // itself rather than us swallowing it.
      if (e.isComposing) return false;
      if (this.mode === "insert") return this.handleInsertKey(e);
      return this.handleNormalOrVisualKey(e, this.mode === "visual");
    }

    handleInsertKey(e) {
      if (e.key === "Escape" || (e.ctrlKey && e.key === "[")) {
        this.pendingJTime = 0;
        this.exitInsert();
        return true;
      }
      // "jj" typed quickly is an alternate way to leave Insert mode, handy
      // when a page's own keydown handling intercepts Escape before it
      // reaches us (see JJ_ESCAPE_MS below).
      if (e.key === "j" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const now = Date.now();
        if (this.pendingJTime && now - this.pendingJTime <= JJ_ESCAPE_MS) {
          this.pendingJTime = 0;
          // Don't trust a position remembered from the earlier keydown — ask
          // where the cursor actually is right now and only remove a 'j'
          // that's really sitting immediately before it. This is immune to
          // any drift between the two keystrokes (site reformatting the
          // value, etc.), which used to cause an off-by-one character eaten.
          const cur = this.getCursor();
          const text = this.getText();
          if (cur > 0 && text[cur - 1] === "j") {
            const newText = text.slice(0, cur - 1) + text.slice(cur);
            this.applyChange(newText, cur - 1);
          }
          this.exitInsert();
          return true;
        }
        this.pendingJTime = now;
        return false;
      }
      this.pendingJTime = 0;
      return false;
    }

    exitInsert() {
      if (this.insertStart) {
        const endPos = this.getCursor();
        const text = this.getText();
        const inserted = text.slice(this.insertStart.pos, endPos);
        const { cmd, count } = this.insertStart;
        this.lastChange = { replay: () => this.replayInsertChange(cmd, count, inserted) };
        this.insertStart = null;
      }
      this.mode = "normal";
      const text = this.getText();
      const cur = this.getCursor();
      const { start } = E.lineBounds(text, cur);
      this.setSel(E.clampNormal(text, cur > start ? cur - 1 : cur));
    }

    enterInsert(pos, cmd, count) {
      this.setSel(pos);
      this.mode = "insert";
      this.insertStart = { pos, cmd, count };
    }

    replayInsertChange(cmd, count, insertedText) {
      switch (cmd) {
        case "i":
          this.enterInsert(this.getCursor(), "i", count);
          break;
        case "a": {
          const p = E.moveRight(this.getText(), this.getCursor(), 1, true);
          this.setSel(p);
          this.enterInsert(p, "a", count);
          break;
        }
        case "I":
          this.enterInsert(E.lineFirstNonBlank(this.getText(), this.getCursor()), "I", count);
          break;
        case "A": {
          const p = E.lineEndPos(this.getText(), this.getCursor(), false);
          this.setSel(p);
          this.enterInsert(p, "A", count);
          break;
        }
        case "o":
          this.openLine(1, true);
          break;
        case "O":
          this.openLine(1, false);
          break;
        default:
          return; // 'c'-based changes are not replayed (unsupported for dot-repeat)
      }
      if (this.mode === "insert") {
        const text = this.getText();
        const cur = this.getCursor();
        const newText = text.slice(0, cur) + insertedText + text.slice(cur);
        this.applyChange(newText, cur + insertedText.length);
        this.mode = "normal";
        const t2 = this.getText();
        const c2 = this.getCursor();
        const { start } = E.lineBounds(t2, c2);
        this.setSel(c2 > start ? c2 - 1 : c2);
        this.insertStart = null;
      }
    }

    repeatLastChange() {
      if (this.lastChange) this.lastChange.replay();
    }

    // ---- movement / selection ----
    moveCursor(pos, isVisual, isVertical) {
      const text = this.getText();
      if (isVisual) {
        this.visualHead = E.clampNormal(text, pos);
        this.updateVisualSelection();
      } else {
        this.setSel(E.clampNormal(text, pos));
      }
      if (!isVertical) this.desiredCol = null;
    }

    updateVisualSelection() {
      const text = this.getText();
      if (this.visualMode === "line") {
        const a = E.lineBounds(text, this.visualAnchor);
        const b = E.lineBounds(text, this.visualHead);
        this.setSel(Math.min(a.start, b.start), Math.max(a.end, b.end));
      } else {
        const lo = Math.min(this.visualAnchor, this.visualHead);
        const hi = Math.max(this.visualAnchor, this.visualHead);
        this.setSel(lo, Math.min(text.length, hi + 1));
      }
    }

    toggleVisual(kind) {
      if (this.mode === "visual" && this.visualMode === kind) {
        this.exitVisual();
        return;
      }
      this.mode = "visual";
      this.visualMode = kind;
      this.visualAnchor = this.getCursor();
      this.visualHead = this.visualAnchor;
      this.updateVisualSelection();
    }

    exitVisual() {
      const head = this.visualHead;
      this.mode = "normal";
      this.visualMode = null;
      this.setSel(E.clampNormal(this.getText(), head));
    }

    // ---- word motions used both standalone and as operator targets ----
    computeMotionTarget(motionKey, fromPos, count) {
      const text = this.getText();
      switch (motionKey) {
        case "w":
          return { pos: E.wordForward(text, fromPos, count, false), inclusive: false };
        case "W":
          return { pos: E.wordForward(text, fromPos, count, true), inclusive: false };
        case "b":
          return { pos: E.wordBackward(text, fromPos, count, false), inclusive: false };
        case "B":
          return { pos: E.wordBackward(text, fromPos, count, true), inclusive: false };
        case "e":
          return { pos: E.wordEnd(text, fromPos, count, false), inclusive: true };
        case "E":
          return { pos: E.wordEnd(text, fromPos, count, true), inclusive: true };
        default:
          return { pos: fromPos, inclusive: false };
      }
    }

    applyMotionOrOperator(motionKey, count, isVisual) {
      const from = isVisual ? this.visualHead : this.getCursor();
      const target = this.computeMotionTarget(motionKey, from, count);
      if (this.pendingOperator) {
        this.executeOperatorOverRange(this.pendingOperator, from, target.pos, target.inclusive);
        this.pendingOperator = null;
        return;
      }
      this.moveCursor(target.pos, isVisual);
    }

    // Shared by the 0/^/$ line motions: apply a pending operator charwise
    // over [cursor, operatorTarget), or just move the cursor to
    // cursorTarget. The two targets usually coincide; $ is the one case
    // where they differ (exclusive end for the operator vs. the clamped
    // on-a-character position for display).
    resolveMotion(operatorTarget, cursorTarget, isVisual) {
      if (this.pendingOperator) {
        this.executeOperatorOverRange(this.pendingOperator, this.getCursor(), operatorTarget, false);
        this.pendingOperator = null;
      } else {
        this.moveCursor(cursorTarget, isVisual);
      }
    }

    // Shared by G/gg: apply a pending operator linewise from the cursor's
    // line through target's line, or just move the cursor to target.
    resolveLinewiseMotion(target, isVisual) {
      if (this.pendingOperator) {
        this.runLinewise(this.pendingOperator, this.getCursor(), target);
        this.pendingOperator = null;
      } else {
        this.moveCursor(target, isVisual);
      }
    }

    // ---- charwise operator execution over [posA, posB) ----
    executeOperatorOverRange(op, posA, posB, inclusive) {
      const text = this.getText();
      let s = Math.min(posA, posB);
      let e = Math.max(posA, posB);
      if (inclusive) e = Math.min(text.length, e + 1);
      if (e <= s) {
        if (op !== "y") this.setSel(E.clampNormal(text, s));
        return;
      }
      const removed = text.slice(s, e);
      this.register = removed;
      this.registerLinewise = false;
      if (op === "y") {
        this.setSel(s);
        return;
      }
      const newText = text.slice(0, s) + text.slice(e);
      this.commit(newText, s);
      if (op === "c") this.enterInsert(s, "c", 1);
      else this.setSel(E.clampNormal(newText, s));
    }

    // ---- linewise operator execution spanning the lines between posA/posB ----
    runLinewise(op, posA, posB) {
      const text = this.getText();
      const lo = Math.min(posA, posB);
      const hi = Math.max(posA, posB);
      const a = E.lineBounds(text, lo);
      const b = E.lineBounds(text, hi);
      const start = a.start;

      if (op === "c") {
        const removed = text.slice(start, b.end);
        this.register = removed;
        this.registerLinewise = true;
        const newText = text.slice(0, start) + text.slice(b.end);
        this.commit(newText, start);
        this.enterInsert(start, "c", 1);
        return;
      }

      const hasTrailingNL = b.end < text.length;
      const fullEnd = hasTrailingNL ? b.end + 1 : b.end;
      const removed = text.slice(start, fullEnd);

      if (op === "y") {
        this.register = removed;
        this.registerLinewise = true;
        this.setSel(start);
        return;
      }

      this.register = removed;
      this.registerLinewise = true;
      const newText = text.slice(0, start) + text.slice(fullEnd);
      const cursor = E.lineFirstNonBlank(newText, Math.min(start, Math.max(0, newText.length - 1)));
      this.commit(newText, cursor);
    }

    applyVisualOperator(op) {
      if (this.visualMode === "line") {
        this.runLinewise(op, this.visualAnchor, this.visualHead);
      } else {
        this.executeOperatorOverRange(op, this.visualAnchor, this.visualHead, true);
      }
      this.mode = "normal";
      this.visualMode = null;
    }

    visualPaste() {
      const reg = this.register;
      const regLinewise = this.registerLinewise;
      this.applyVisualOperator("d");
      this.register = reg;
      this.registerLinewise = regLinewise;
      this.paste(1, false);
    }

    // ---- misc edits ----
    deleteChars(count, isVisual) {
      if (isVisual) {
        this.applyVisualOperator("d");
        return;
      }
      const text = this.getText();
      const cur = this.getCursor();
      const { end } = E.lineBounds(text, cur);
      const stop = Math.min(end, cur + count);
      if (stop <= cur) return;
      this.register = text.slice(cur, stop);
      this.registerLinewise = false;
      const newText = text.slice(0, cur) + text.slice(stop);
      this.commit(newText, E.clampNormal(newText, cur));
      this.lastChange = { replay: () => this.deleteChars(count, false) };
    }

    deleteCharsBefore(count) {
      const text = this.getText();
      const cur = this.getCursor();
      const { start } = E.lineBounds(text, cur);
      const from = Math.max(start, cur - count);
      if (from >= cur) return;
      this.register = text.slice(from, cur);
      this.registerLinewise = false;
      const newText = text.slice(0, from) + text.slice(cur);
      this.commit(newText, from);
      this.lastChange = { replay: () => this.deleteCharsBefore(count) };
    }

    deleteToLineEnd(count) {
      const text = this.getText();
      const cur = this.getCursor();
      const targetLine = count > 1 ? E.moveVertical(text, cur, 1, count - 1, null).pos : cur;
      const target = E.lineEndPos(text, targetLine, false);
      this.executeOperatorOverRange("d", cur, target, false);
      this.lastChange = { replay: () => this.deleteToLineEnd(count) };
    }

    changeToLineEnd(count) {
      const text = this.getText();
      const cur = this.getCursor();
      const targetLine = count > 1 ? E.moveVertical(text, cur, 1, count - 1, null).pos : cur;
      const target = E.lineEndPos(text, targetLine, false);
      this.executeOperatorOverRange("c", cur, target, false);
    }

    yankLines(count) {
      const cur = this.getCursor();
      const target = count > 1 ? E.moveVertical(this.getText(), cur, 1, count - 1, null).pos : cur;
      this.runLinewise("y", cur, target);
    }

    paste(count, after) {
      if (!this.register) return;
      const text = this.getText();
      const cur = this.getCursor();
      if (this.registerLinewise) {
        const { start, end } = E.lineBounds(text, cur);
        const rawBlock = this.register.endsWith("\n") ? this.register : this.register + "\n";
        let insertAt;
        let payload = rawBlock.repeat(count);
        if (after) {
          if (end < text.length) {
            insertAt = end + 1;
          } else {
            insertAt = text.length;
            payload = "\n" + payload;
          }
        } else {
          insertAt = start;
        }
        const newText = text.slice(0, insertAt) + payload + text.slice(insertAt);
        const cursorPos = after && end === text.length ? insertAt + 1 : insertAt;
        this.commit(newText, E.lineFirstNonBlank(newText, Math.min(cursorPos, newText.length)));
      } else {
        const insertAt = after ? E.moveRight(text, cur, 1, true) : cur;
        const payload = this.register.repeat(count);
        const newText = text.slice(0, insertAt) + payload + text.slice(insertAt);
        this.commit(newText, E.clampNormal(newText, insertAt + payload.length - 1));
      }
      this.lastChange = { replay: () => this.paste(count, after) };
    }

    openLine(count, below) {
      const text = this.getText();
      const cur = this.getCursor();
      const { start, end } = E.lineBounds(text, cur);
      const insertAt = below ? end : start;
      const newText = text.slice(0, insertAt) + "\n" + text.slice(insertAt);
      const cursorPos = below ? insertAt + 1 : insertAt;
      this.commit(newText, cursorPos);
      this.enterInsert(cursorPos, below ? "o" : "O", count);
    }

    toggleCase(count) {
      const text = this.getText();
      const cur = this.getCursor();
      const { end } = E.lineBounds(text, cur);
      const stop = Math.min(end, cur + count);
      if (stop <= cur) return;
      const seg = text
        .slice(cur, stop)
        .replace(/[a-zA-Z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
      const newText = text.slice(0, cur) + seg + text.slice(stop);
      this.commit(newText, E.clampNormal(newText, stop));
      this.lastChange = { replay: () => this.toggleCase(count) };
    }

    replaceChar(ch, count) {
      const text = this.getText();
      const cur = this.getCursor();
      const { end } = E.lineBounds(text, cur);
      if (cur + count > end) return;
      const newText = text.slice(0, cur) + ch.repeat(count) + text.slice(cur + count);
      this.commit(newText, cur + count - 1);
      this.lastChange = { replay: () => this.replaceChar(ch, count) };
    }

    finishFindOrReplace(cmd, ch, isVisual) {
      if (cmd === "r") {
        this.replaceChar(ch, this.pendingFindCount || 1);
        return;
      }
      const text = this.getText();
      const cur = this.getCursor();
      const dir = cmd === "f" || cmd === "t" ? 1 : -1;
      const till = cmd === "t" || cmd === "T";
      const target = E.findChar(text, cur, ch, dir, till, this.pendingFindCount || 1);
      this.lastFind = { cmd, ch };
      if (target === null) return;
      if (this.pendingOperator) {
        this.executeOperatorOverRange(this.pendingOperator, cur, target, dir > 0);
        this.pendingOperator = null;
      } else {
        this.moveCursor(target, isVisual);
      }
    }

    repeatFind(sign, count, isVisual) {
      if (!this.lastFind) return;
      const { cmd, ch } = this.lastFind;
      const baseDir = cmd === "f" || cmd === "t" ? 1 : -1;
      const dir = baseDir * sign;
      const till = cmd === "t" || cmd === "T";
      const text = this.getText();
      const cur = this.getCursor();
      const target = E.findChar(text, cur, ch, dir, till, count);
      if (target === null) return;
      if (this.pendingOperator) {
        this.executeOperatorOverRange(this.pendingOperator, cur, target, dir > 0);
        this.pendingOperator = null;
      } else {
        this.moveCursor(target, isVisual);
      }
    }

    // ---- normal / visual key dispatch ----
    handleNormalOrVisualKey(e, isVisual) {
      if (MODIFIER_ONLY_KEYS.has(e.key)) return false;
      if (PASSTHROUGH_KEYS.has(e.key)) return false;

      if (e.ctrlKey && e.key.toLowerCase() === "r") {
        this.redo();
        return true;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return false;

      if (this.pendingFind) {
        const cmd = this.pendingFind;
        this.pendingFind = null;
        if (e.key.length !== 1) {
          this.resetPending();
          return true;
        }
        this.finishFindOrReplace(cmd, e.key, isVisual);
        return true;
      }

      if (this.gPending) {
        this.gPending = false;
        if (e.key === "g") {
          this.resolveLinewiseMotion(E.documentStart(this.getText(), this.pendingCountForG), isVisual);
          return true;
        }
        this.resetPending();
        return true;
      }

      if (/^[1-9]$/.test(e.key) || (e.key === "0" && this.countBuf !== "")) {
        this.countBuf += e.key;
        return true;
      }

      const rawCount = this.consumeCount();
      const count = rawCount === null ? 1 : rawCount;
      const text = this.getText();

      switch (e.key) {
        case "Escape":
          if (isVisual) this.exitVisual();
          this.resetPending();
          return true;

        case "h":
        case "ArrowLeft":
        case "Backspace":
          this.moveCursor(E.moveLeft(text, this.getCursor(), count), isVisual);
          return true;

        case "l":
        case "ArrowRight":
        case " ":
          this.moveCursor(E.moveRight(text, this.getCursor(), count, isVisual), isVisual);
          return true;

        case "j":
        case "ArrowDown": {
          if (this.pendingOperator) {
            const target = E.moveVertical(text, this.getCursor(), 1, count, null).pos;
            this.runLinewise(this.pendingOperator, this.getCursor(), target);
            this.pendingOperator = null;
            return true;
          }
          const r = E.moveVertical(text, this.getCursor(), 1, count, this.desiredCol);
          this.desiredCol = r.col;
          this.moveCursor(r.pos, isVisual, true);
          return true;
        }

        case "k":
        case "ArrowUp": {
          if (this.pendingOperator) {
            const target = E.moveVertical(text, this.getCursor(), -1, count, null).pos;
            this.runLinewise(this.pendingOperator, this.getCursor(), target);
            this.pendingOperator = null;
            return true;
          }
          const r = E.moveVertical(text, this.getCursor(), -1, count, this.desiredCol);
          this.desiredCol = r.col;
          this.moveCursor(r.pos, isVisual, true);
          return true;
        }

        case "Enter": {
          if (this.pendingOperator) {
            const target = E.moveVertical(text, this.getCursor(), 1, count, null).pos;
            this.runLinewise(this.pendingOperator, this.getCursor(), target);
            this.pendingOperator = null;
            return true;
          }
          const r = E.moveVertical(text, this.getCursor(), 1, count, null);
          this.moveCursor(E.lineFirstNonBlank(this.getText(), r.pos), isVisual);
          return true;
        }

        case "0": {
          const target = E.lineStart(text, this.getCursor());
          this.resolveMotion(target, target, isVisual);
          return true;
        }

        case "^": {
          const target = E.lineFirstNonBlank(text, this.getCursor());
          this.resolveMotion(target, target, isVisual);
          return true;
        }

        case "$": {
          const cur = this.getCursor();
          const lineAt = count > 1 ? E.moveVertical(text, cur, 1, count - 1, null).pos : cur;
          this.resolveMotion(E.lineEndPos(text, lineAt, false), E.lineEndPos(text, lineAt, true), isVisual);
          this.desiredCol = Infinity;
          return true;
        }

        case "w":
        case "W":
        case "b":
        case "B":
        case "e":
        case "E":
          this.applyMotionOrOperator(e.key, count, isVisual);
          return true;

        case "g":
          this.gPending = true;
          this.pendingCountForG = rawCount;
          return true;

        case "G":
          this.resolveLinewiseMotion(E.documentEnd(text, rawCount), isVisual);
          return true;

        case "f":
        case "F":
        case "t":
        case "T":
          this.pendingFind = e.key;
          this.pendingFindCount = count;
          return true;

        case "r":
          if (isVisual) {
            this.resetPending();
            return true;
          }
          this.pendingFind = "r";
          this.pendingFindCount = count;
          return true;

        case ";":
          this.repeatFind(1, count, isVisual);
          return true;

        case ",":
          this.repeatFind(-1, count, isVisual);
          return true;

        case "d":
        case "c":
        case "y":
          if (isVisual) {
            this.applyVisualOperator(e.key);
            return true;
          }
          if (this.pendingOperator === e.key) {
            const cur = this.getCursor();
            const totalCount = Math.max(1, this.opCount) * count;
            const target = totalCount > 1 ? E.moveVertical(text, cur, 1, totalCount - 1, null).pos : cur;
            this.runLinewise(e.key, cur, target);
            this.pendingOperator = null;
            this.opCount = 1;
          } else if (this.pendingOperator) {
            this.resetPending();
          } else {
            this.pendingOperator = e.key;
            this.opCount = count;
          }
          return true;

        case "x":
          this.deleteChars(count, isVisual);
          return true;

        case "X":
          this.deleteCharsBefore(count);
          return true;

        case "D":
          this.deleteToLineEnd(count);
          return true;

        case "C":
          this.changeToLineEnd(count);
          return true;

        case "Y":
          this.yankLines(count);
          return true;

        case "p":
          if (isVisual) this.visualPaste();
          else this.paste(count, true);
          return true;

        case "P":
          if (isVisual) this.visualPaste();
          else this.paste(count, false);
          return true;

        case "i":
          if (!isVisual) this.enterInsert(this.getCursor(), "i", count);
          return true;

        case "a":
          if (!isVisual) {
            const p = E.moveRight(text, this.getCursor(), 1, true);
            this.setSel(p);
            this.enterInsert(p, "a", count);
          }
          return true;

        case "I":
          if (!isVisual) this.enterInsert(E.lineFirstNonBlank(text, this.getCursor()), "I", count);
          return true;

        case "A":
          if (!isVisual) {
            const p = E.lineEndPos(text, this.getCursor(), false);
            this.setSel(p);
            this.enterInsert(p, "A", count);
          }
          return true;

        case "o":
          if (!isVisual) this.openLine(count, true);
          return true;

        case "O":
          if (!isVisual) this.openLine(count, false);
          return true;

        case "~":
          this.toggleCase(count);
          return true;

        case "u":
          if (isVisual) this.exitVisual();
          this.undo();
          return true;

        case "v":
          this.toggleVisual("char");
          return true;

        case "V":
          this.toggleVisual("line");
          return true;

        case ".":
          this.repeatLastChange();
          return true;

        default:
          this.resetPending();
          return true;
      }
    }
  }

  global.VimField = VimField;
})(typeof window !== "undefined" ? window : globalThis);
