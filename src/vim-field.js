// VimField:1つの DOM 要素に紐づく Normal/Insert/Visual モーダル編集の
// 状態マシン。VimTextEngine（純粋なテキスト・インデックス計算）と
// VimDomHelpers（要素の値・選択範囲の入出力）に依存する。ページへの配線
// （フォーカス追跡、キーのディスパッチ、モードインジケータ）は content.js
// が担う。
(function (global) {
  "use strict";
  const E = global.VimTextEngine;
  const D = global.VimDomHelpers;

  const JJ_ESCAPE_MS = 350;

  const PASSTHROUGH_KEYS = new Set([
    "Tab", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    "PageUp", "PageDown", "Home", "End", "Insert", "ContextMenu", "PrintScreen",
  ]);

  // Normal/Visual モードのキー入力ごとに呼ばれる handleNormalOrVisualKey が
  // 毎回配列を新規生成してメンバーシップ判定するのを避けるため、あらかじめ
  // Set 化しておく。
  const MODIFIER_ONLY_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

  /**
   * 1つの DOM 要素（input/textarea/contenteditable）に対する
   * Vim 風モーダル編集の状態を保持し、キー入力を処理するクラス。
   */
  class VimField {
    /**
     * @param {HTMLElement} el 紐づける対象要素
     */
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

    // ---- テキスト・選択範囲の入出力 ----
    /**
     * 対象要素の現在のテキスト内容を取得する。
     * @returns {string}
     */
    getText() {
      return this.isCE ? this.el.textContent : this.el.value;
    }
    /**
     * 対象要素のテキスト内容を設定する。
     * @param {string} v 設定するテキスト
     * @returns {void}
     */
    setText(v) {
      if (this.isCE) D.setCEText(this.el, v);
      else D.setInputValue(this.el, v);
    }
    /**
     * 対象要素の現在の選択範囲を取得する。
     * @returns {{start: number, end: number}}
     */
    getSel() {
      try {
        if (this.isCE) return D.ceGetOffsets(this.el);
        return { start: this.el.selectionStart, end: this.el.selectionEnd };
      } catch (_) {
        return { start: 0, end: 0 };
      }
    }
    /**
     * 対象要素の選択範囲を設定する。
     * @param {number} start 開始位置
     * @param {number} [end] 終了位置（省略時は start と同じ、つまりカーソル位置のみ）
     * @returns {void}
     */
    setSel(start, end) {
      end = end === undefined ? start : end;
      try {
        if (this.isCE) D.ceSetOffsets(this.el, start, end);
        else this.el.setSelectionRange(start, end);
      } catch (_) {
        // email や number など、一部の input type は選択範囲 API に
        // 対応していない。キー処理を途中で中断させず、静かに失敗させる。
      }
    }
    /**
     * 現在のカーソル位置（選択範囲の開始位置）を取得する。
     * @returns {number}
     */
    getCursor() {
      return this.getSel().start;
    }
    /**
     * テキストと選択範囲（カーソル位置）を undo 履歴に積まずに直接適用する。
     * @param {string} newText 新しいテキスト
     * @param {number} cursor 適用後のカーソル位置
     * @returns {void}
     */
    applyChange(newText, cursor) {
      this.setText(newText);
      this.setSel(cursor);
    }
    /**
     * 現在の状態を undo スタックに積んでから、新しいテキストと
     * カーソル位置を適用する。redo スタックはクリアされる。
     * @param {string} newText 新しいテキスト
     * @param {number} cursor 適用後のカーソル位置
     * @returns {void}
     */
    commit(newText, cursor) {
      this.undoStack.push({ text: this.getText(), cursor: this.getCursor() });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.applyChange(newText, cursor);
    }
    /**
     * 直前の変更を取り消す（u 相当）。
     * @returns {void}
     */
    undo() {
      if (!this.undoStack.length) return;
      const cur = { text: this.getText(), cursor: this.getCursor() };
      const prev = this.undoStack.pop();
      this.redoStack.push(cur);
      this.applyChange(prev.text, prev.cursor);
    }
    /**
     * 取り消した変更をやり直す（Ctrl-r 相当）。
     * @returns {void}
     */
    redo() {
      if (!this.redoStack.length) return;
      const cur = { text: this.getText(), cursor: this.getCursor() };
      const next = this.redoStack.pop();
      this.undoStack.push(cur);
      this.applyChange(next.text, next.cursor);
    }

    /**
     * カウント・保留中のオペレータ・find 待ち状態などをリセットする。
     * @returns {void}
     */
    resetPending() {
      this.pendingOperator = null;
      this.opCount = 1;
      this.pendingFind = null;
      this.gPending = false;
      this.countBuf = "";
    }

    /**
     * 蓄積されているカウント文字列を数値として取り出し、バッファをクリアする。
     * @returns {number|null} 入力されていたカウント。何も入力されていなければ null
     */
    consumeCount() {
      const n = this.countBuf === "" ? null : parseInt(this.countBuf, 10);
      this.countBuf = "";
      return n;
    }

    // ---- 最上位のディスパッチ。キーが消費された場合 true を返す ----
    /**
     * keydown イベントを現在のモードに応じて処理する。
     * @param {KeyboardEvent} e キーイベント
     * @returns {boolean} キーを消費した（=既定動作を止めるべき）場合 true
     */
    handleKey(e) {
      // IME 変換中（例: 変換前の全角ローマ字を入力している最中）は、
      // keydown はキーストロークごとに発火するが、テキストの内容は
      // まだブラウザが保持しておりフィールドにはコミットされていない。
      // これに反応してしまう（特に下の jj-escape 判定）と、フィールド
      // 中に実際には存在しない文字 "j" を探そうとして失敗しつつも
      // "handled" を返して Normal モードに切り替わってしまっていた
      // ——変換中の内容は "j" ではなく IME が構築中の全角/かな文字だから
      // である。変換中のキー入力に手を出さないことで IME は通常通り
      // 変換を完了でき、変換中の Escape も（こちらに横取りされず）
      // 正しく変換自体をキャンセルする。
      if (e.isComposing) return false;
      if (this.mode === "insert") return this.handleInsertKey(e);
      return this.handleNormalOrVisualKey(e, this.mode === "visual");
    }

    /**
     * Insert モードでのキー入力を処理する。
     * @param {KeyboardEvent} e キーイベント
     * @returns {boolean} キーを消費した場合 true
     */
    handleInsertKey(e) {
      if (e.key === "Escape" || (e.ctrlKey && e.key === "[")) {
        this.pendingJTime = 0;
        this.exitInsert();
        return true;
      }
      // すばやく入力された "jj" は Insert モードを抜けるもう一つの方法。
      // ページ自身の keydown 処理が Escape をこちらに届く前に横取りして
      // しまう場合に役立つ（下の JJ_ESCAPE_MS 参照）。
      if (e.key === "j" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const now = Date.now();
        if (this.pendingJTime && now - this.pendingJTime <= JJ_ESCAPE_MS) {
          this.pendingJTime = 0;
          // 前回の keydown 時点で記憶した位置を信用せず、カーソルが
          // 実際に今どこにあるかを確認し、本当にその直前に "j" が
          // ある場合のみ削除する。これにより2回のキー入力の間に
          // 何らかのズレ（サイト側による値の再フォーマット等）が
          // あっても影響を受けない——以前はこれが原因で誤った1文字が
          // 削除されることがあった。
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

    /**
     * Insert モードを抜けて Normal モードへ遷移する。ドットリピート用に
     * このセッションで挿入されたテキストを記録する。
     * @returns {void}
     */
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

    /**
     * 指定位置にカーソルを置いて Insert モードへ入る。
     * @param {number} pos Insert モードに入る位置
     * @param {string} cmd 呼び出し元のコマンド（i/a/I/A/o/O/c など。ドットリピート用）
     * @param {number} count コマンドに渡されたカウント
     * @returns {void}
     */
    enterInsert(pos, cmd, count) {
      this.setSel(pos);
      this.mode = "insert";
      this.insertStart = { pos, cmd, count };
    }

    /**
     * ドットリピート（.）のために、直前の Insert モード遷移コマンドと
     * 挿入されたテキストを再現する。
     * @param {string} cmd 再現するコマンド（i/a/I/A/o/O）
     * @param {number} count コマンドのカウント
     * @param {string} insertedText 前回挿入されたテキスト
     * @returns {void}
     */
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
          return; // 'c' 系の変更はドットリピート非対応のため再現しない
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

    /**
     * 直前の変更をドットリピート（.）で繰り返す。
     * @returns {void}
     */
    repeatLastChange() {
      if (this.lastChange) this.lastChange.replay();
    }

    // ---- 移動・選択 ----
    /**
     * カーソル（または Visual モードでの選択ヘッド）を指定位置へ移動する。
     * @param {number} pos 移動先の位置
     * @param {boolean} isVisual Visual モード中かどうか
     * @param {boolean} [isVertical] 上下移動（j/k）による呼び出しかどうか。
     *   false/未指定の場合、目標列（desiredCol）をリセットする
     * @returns {void}
     */
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

    /**
     * Visual モードの選択アンカーとヘッドから、実際の選択範囲を再計算して適用する。
     * @returns {void}
     */
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

    /**
     * Visual モードのオン/オフを切り替える（v/V 相当）。既に同じ種類の
     * Visual モードであれば抜ける。
     * @param {"char"|"line"} kind Visual モードの種類
     * @returns {void}
     */
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

    /**
     * Visual モードを抜けて Normal モードへ戻る。
     * @returns {void}
     */
    exitVisual() {
      const head = this.visualHead;
      this.mode = "normal";
      this.visualMode = null;
      this.setSel(E.clampNormal(this.getText(), head));
    }

    // ---- 単体でもオペレータの対象としても使われる単語モーション ----
    /**
     * 単語モーションキー（w/W/b/B/e/E）に対応する移動先位置を計算する。
     * @param {string} motionKey モーションキー
     * @param {number} fromPos 現在位置
     * @param {number} count カウント
     * @returns {{pos: number, inclusive: boolean}} 移動先位置と、
     *   オペレータ適用時に終端を含むかどうか
     */
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

    /**
     * 単語モーションを適用する。保留中のオペレータがあればその対象範囲に
     * 適用し、なければ単にカーソル（または選択ヘッド）を移動する。
     * @param {string} motionKey モーションキー（w/W/b/B/e/E）
     * @param {number} count カウント
     * @param {boolean} isVisual Visual モード中かどうか
     * @returns {void}
     */
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

    // 0/^/$ の行内モーションで共有される処理: 保留中のオペレータがあれば
    // [カーソル, operatorTarget) の範囲に文字単位で適用し、なければ単に
    // カーソルを cursorTarget へ移動する。通常この2つの目標値は一致するが、
    // $ の場合だけ異なる（オペレータには排他的な終端、表示上はクランプ
    // された実在の文字位置を使う）。
    /**
     * @param {number} operatorTarget オペレータ適用時の終端位置
     * @param {number} cursorTarget カーソル移動時の目標位置
     * @param {boolean} isVisual Visual モード中かどうか
     * @returns {void}
     */
    resolveMotion(operatorTarget, cursorTarget, isVisual) {
      if (this.pendingOperator) {
        this.executeOperatorOverRange(this.pendingOperator, this.getCursor(), operatorTarget, false);
        this.pendingOperator = null;
      } else {
        this.moveCursor(cursorTarget, isVisual);
      }
    }

    // G/gg で共有される処理: 保留中のオペレータがあればカーソルの行から
    // target の行までを行単位で適用し、なければ単にカーソルを target へ移動する。
    /**
     * @param {number} target 移動先/オペレータ対象となる位置
     * @param {boolean} isVisual Visual モード中かどうか
     * @returns {void}
     */
    resolveLinewiseMotion(target, isVisual) {
      if (this.pendingOperator) {
        this.runLinewise(this.pendingOperator, this.getCursor(), target);
        this.pendingOperator = null;
      } else {
        this.moveCursor(target, isVisual);
      }
    }

    // ---- [posA, posB) の範囲に対する文字単位のオペレータ実行 ----
    /**
     * オペレータ（d/c/y）を [posA, posB) の文字単位の範囲に適用する。
     * @param {"d"|"c"|"y"} op 適用するオペレータ
     * @param {number} posA 範囲の一方の端
     * @param {number} posB 範囲のもう一方の端
     * @param {boolean} inclusive true の場合 posB 自身も範囲に含める
     * @returns {void}
     */
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

    // ---- posA/posB の間の行にまたがる、行単位のオペレータ実行 ----
    /**
     * オペレータ（d/c/y）を posA と posB の間の行全体（行単位）に適用する。
     * @param {"d"|"c"|"y"} op 適用するオペレータ
     * @param {number} posA 範囲の一方の端となる位置
     * @param {number} posB 範囲のもう一方の端となる位置
     * @returns {void}
     */
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

    /**
     * Visual モードで選択されている範囲にオペレータを適用し、Normal モードへ戻る。
     * @param {"d"|"c"|"y"} op 適用するオペレータ
     * @returns {void}
     */
    applyVisualOperator(op) {
      if (this.visualMode === "line") {
        this.runLinewise(op, this.visualAnchor, this.visualHead);
      } else {
        this.executeOperatorOverRange(op, this.visualAnchor, this.visualHead, true);
      }
      this.mode = "normal";
      this.visualMode = null;
    }

    /**
     * Visual モードでの貼り付け（p 相当）: 選択範囲を削除しレジスタに退避した後、
     * 元のレジスタ内容を復元してから貼り付ける。
     * @returns {void}
     */
    visualPaste() {
      const reg = this.register;
      const regLinewise = this.registerLinewise;
      this.applyVisualOperator("d");
      this.register = reg;
      this.registerLinewise = regLinewise;
      this.paste(1, false);
    }

    // ---- その他の編集操作 ----
    /**
     * カーソル位置から count 文字を削除する（x 相当）。
     * @param {number} count 削除する文字数
     * @param {boolean} isVisual Visual モード中かどうか
     * @returns {void}
     */
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

    /**
     * カーソルの手前 count 文字を削除する（X 相当）。
     * @param {number} count 削除する文字数
     * @returns {void}
     */
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

    /**
     * カーソル位置から（count 行分先の）行末までを削除する（D 相当）。
     * @param {number} count 対象とする行数
     * @returns {void}
     */
    deleteToLineEnd(count) {
      const text = this.getText();
      const cur = this.getCursor();
      const targetLine = count > 1 ? E.moveVertical(text, cur, 1, count - 1, null).pos : cur;
      const target = E.lineEndPos(text, targetLine, false);
      this.executeOperatorOverRange("d", cur, target, false);
      this.lastChange = { replay: () => this.deleteToLineEnd(count) };
    }

    /**
     * カーソル位置から（count 行分先の）行末までを変更する（C 相当）。
     * @param {number} count 対象とする行数
     * @returns {void}
     */
    changeToLineEnd(count) {
      const text = this.getText();
      const cur = this.getCursor();
      const targetLine = count > 1 ? E.moveVertical(text, cur, 1, count - 1, null).pos : cur;
      const target = E.lineEndPos(text, targetLine, false);
      this.executeOperatorOverRange("c", cur, target, false);
    }

    /**
     * カーソル行から count 行分をヤンクする（Y 相当）。
     * @param {number} count 対象とする行数
     * @returns {void}
     */
    yankLines(count) {
      const cur = this.getCursor();
      const target = count > 1 ? E.moveVertical(this.getText(), cur, 1, count - 1, null).pos : cur;
      this.runLinewise("y", cur, target);
    }

    /**
     * レジスタの内容を貼り付ける（p/P 相当）。
     * @param {number} count 貼り付けを繰り返す回数
     * @param {boolean} after true なら現在位置の後ろに、false なら前に貼り付ける
     * @returns {void}
     */
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

    /**
     * 現在行の上または下に新しい行を開き、Insert モードへ入る（o/O 相当）。
     * @param {number} count コマンドのカウント（ドットリピート用に保持される）
     * @param {boolean} below true なら現在行の下に、false なら上に開く
     * @returns {void}
     */
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

    /**
     * カーソル位置から count 文字分の英字の大文字/小文字を反転する（~ 相当）。
     * @param {number} count 対象とする文字数
     * @returns {void}
     */
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

    /**
     * カーソル位置から count 文字を指定した文字で置き換える（r 相当）。
     * @param {string} ch 置き換え後の文字
     * @param {number} count 置き換える文字数
     * @returns {void}
     */
    replaceChar(ch, count) {
      const text = this.getText();
      const cur = this.getCursor();
      const { end } = E.lineBounds(text, cur);
      if (cur + count > end) return;
      const newText = text.slice(0, cur) + ch.repeat(count) + text.slice(cur + count);
      this.commit(newText, cur + count - 1);
      this.lastChange = { replay: () => this.replaceChar(ch, count) };
    }

    /**
     * f/F/t/T/r で保留していた「次の1文字」の入力を受けて、検索または
     * 置換を完了させる。
     * @param {"f"|"F"|"t"|"T"|"r"} cmd 保留していたコマンド
     * @param {string} ch 入力された文字
     * @param {boolean} isVisual Visual モード中かどうか
     * @returns {void}
     */
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

    /**
     * 直前の f/F/t/T 検索を繰り返す（;/, 相当）。
     * @param {1|-1} sign 1 なら元の方向、-1 なら逆方向に繰り返す
     * @param {number} count カウント
     * @param {boolean} isVisual Visual モード中かどうか
     * @returns {void}
     */
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

    // ---- Normal / Visual モードのキーディスパッチ ----
    /**
     * Normal モードまたは Visual モードでのキー入力を処理する。
     * @param {KeyboardEvent} e キーイベント
     * @param {boolean} isVisual Visual モード中かどうか
     * @returns {boolean} キーを消費した場合 true
     */
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
