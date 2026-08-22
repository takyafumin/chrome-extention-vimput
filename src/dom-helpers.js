// content.js と vim-field.js から共有される、DOM の値・選択範囲操作用ヘルパー。
// ここでは2つの責務を扱う: (1) どの要素を制御対象にするかの判定
// （「対象判定」）、(2) React のようにネイティブの value セッターを
// 横取りするフレームワークとも問題なく動作する形での、要素のテキスト・
// 選択範囲の読み書き。
(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 対象判定 (Eligibility)
  // ---------------------------------------------------------------------
  // Chrome が実際に selectionStart/selectionEnd/setSelectionRange を
  // 公開している input type のみを対象とする。特に "email" と "number" は
  // このリストに含まれない点に注意 — これらで選択範囲にアクセスすると
  // 例外が発生し、以前は keydown ハンドラの処理途中（preventDefault が
  // 呼ばれる前）で処理が中断してしまい、フィールドが壊れた状態のまま
  // 残ることがあった。
  const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password", ""]);

  /**
   * 要素が本拡張機能による Vim 風モーダル編集の対象になり得るかを判定する。
   * @param {Element|null} el 判定対象の要素
   * @returns {boolean} 対象にできる場合は true
   */
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
  // DOM の値・選択範囲ヘルパー（React 等のフレームワークとも互換）
  // ---------------------------------------------------------------------
  // コンテンツスクリプトは分離された JS ワールドで実行される: ページ側は
  // 自分の `window.HTMLInputElement.prototype` を自由に書き換えられるが、
  // それはこのワールドに存在する別のプロトタイプのコピーには影響しない。
  // そのため *この* `window` からセッターを取得すれば、常に本物の
  // 改変されていないネイティブセッターが得られる — これはまさに、
  // インスタンス自身の `value` プロパティを上書きして自分自身の書き込みだけを
  // 検知しようとする React のようなフレームワークを回避する方法でもある。
  /**
   * 要素のタグに応じた、ネイティブの value セッターを取得する。
   * @param {HTMLInputElement|HTMLTextAreaElement} el 対象要素
   * @returns {(value: string) => void} ネイティブの value セッター関数
   */
  function nativeValueSetter(el) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, "value").set;
  }

  /**
   * input/textarea 要素の値をネイティブセッター経由で設定し、input イベントを発火させる。
   * @param {HTMLInputElement|HTMLTextAreaElement} el 対象要素
   * @param {string} value 設定する値
   * @returns {void}
   */
  function setInputValue(el, value) {
    nativeValueSetter(el).call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText" }));
  }

  /**
   * contenteditable 要素のテキストを設定し、input イベントを発火させる。
   * @param {HTMLElement} el 対象要素
   * @param {string} value 設定するテキスト
   * @returns {void}
   */
  function setCEText(el, value) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText" }));
  }

  /**
   * contenteditable 要素内の文字オフセット範囲を、対応する Range オブジェクトに変換する。
   * @param {HTMLElement} el 対象要素
   * @param {number} start 開始文字オフセット
   * @param {number} end 終了文字オフセット
   * @returns {Range} 対応する Range
   */
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

  /**
   * contenteditable 要素における現在の選択範囲を、文字オフセットとして取得する。
   * @param {HTMLElement} el 対象要素
   * @returns {{start: number, end: number}} 選択範囲の開始・終了オフセット
   */
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

  /**
   * 文字オフセットの範囲を、contenteditable 要素上の選択範囲として設定する。
   * @param {HTMLElement} el 対象要素
   * @param {number} start 開始文字オフセット
   * @param {number} end 終了文字オフセット
   * @returns {void}
   */
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
