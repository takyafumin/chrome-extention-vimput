// 結合レイヤー: ページ単位の設定（有効/無効）、Normal モードを示す
// インジケータバッジ + ブロックカーソル描画、そして実際の focus/keydown
// イベントへの VimField の配線を担う。モーダル編集ロジック自体は
// vim-field.js に、要素の対象判定・入出力ヘルパーは dom-helpers.js にある。
(function () {
  "use strict";
  const E = window.VimTextEngine;
  const D = window.VimDomHelpers;

  // ---------------------------------------------------------------------
  // 設定（グローバルトグル + サイトごとの上書き）
  //
  // globalEnabled は storage.sync に保存される — 単一の真偽値であり、
  // ユーザーの複数デバイス間で同期しても問題ない。siteOverrides は
  // ホスト名ごとの選択を保持するマップで、プライバシーに関わる
  // （実質的に閲覧履歴の断片となる）ため storage.local に保存し、
  // Chrome Sync には一切送信しない（background.js 参照）。
  //
  // loadSettingsOnce は（focusin ハンドラから呼び出す形で）遅延読み込み
  // する。スクリプト読み込み時に無条件で読み込まないのは、all_frames:true
  // によりこのスクリプトはページ内のすべての iframe（広告やトラッカーを
  // 含む）で実行されるためであり、ユーザーが実際にフォーカスするフィールドを
  // 持たない iframe がほとんどなので、それらでストレージ読み込みのコストを
  // かける理由がないからである。
  // ---------------------------------------------------------------------
  let globalEnabled = true;
  let siteOverrides = {};
  let settingsLoadPromise = null;

  /**
   * グローバル設定とサイトごとの上書き設定を、初回呼び出し時にのみ
   * ストレージから読み込む。2回目以降の呼び出しは同じ Promise を返す。
   * @returns {Promise<void>} 設定の読み込みが完了したら解決される Promise
   */
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

  /**
   * 現在のホストで本拡張機能が有効かどうかを判定する。
   * サイトごとの上書き設定があればそれを優先し、なければグローバル設定に従う。
   * @returns {boolean} 有効なら true
   */
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
  // モードインジケータ（Shadow DOM によるオーバーレイ）
  // ---------------------------------------------------------------------
  let indicatorHost = null;
  let indicatorEl = null;

  /**
   * モードインジケータ用の Shadow DOM ホスト要素を（まだ無ければ）生成し、
   * ページに追加する。
   * @returns {void}
   */
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

  /**
   * インジケータバッジを、対象要素の直下（画面内に収まる位置）に配置する。
   * @param {Element} el 基準となる要素
   * @returns {void}
   */
  function positionIndicator(el) {
    if (!indicatorHost) return;
    const r = el.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 24, r.bottom + 4);
    const left = Math.max(4, r.left);
    indicatorHost.style.top = top + "px";
    indicatorHost.style.left = left + "px";
  }

  /**
   * 指定したモードのインジケータバッジを表示する。
   * @param {Element} el バッジを表示する基準要素
   * @param {"normal"|"insert"|"visual"} mode 現在のモード
   * @param {"char"|"line"|null} [visualKind] Visual モードの種類（文字単位 or 行単位）
   * @returns {void}
   */
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

  /**
   * インジケータバッジを非表示にする。
   * @returns {void}
   */
  function hideIndicator() {
    if (indicatorHost) indicatorHost.style.display = "none";
  }

  // ---------------------------------------------------------------------
  // 配線: フォーカス中の対象フィールドを追跡し、keydown をそのフィールドに転送する
  // ---------------------------------------------------------------------
  const fields = new WeakMap();
  let activeField = null;
  let activeEl = null;

  /**
   * 要素に対応する VimField インスタンスを取得する。まだ無ければ生成してキャッシュする。
   * @param {Element} el 対象要素
   * @returns {InstanceType<Window["VimField"]>} 対応する VimField インスタンス
   */
  function getField(el) {
    let f = fields.get(el);
    if (!f) {
      f = new window.VimField(el);
      fields.set(el, f);
    }
    return f;
  }

  /**
   * 現在アクティブなフィールドの状態に合わせて、インジケータの表示・非表示を更新する。
   * @returns {void}
   */
  function updateIndicatorForActive() {
    if (!activeField) {
      hideIndicator();
      return;
    }
    showIndicator(activeField.el, activeField.mode, activeField.visualMode);
  }

  // テキストエリアや input には本物のブロックカーソルを描画する手段がないため、
  // Normal モードではカーソル位置の1文字を選択状態にすることで代用している —
  // ブラウザ標準の選択ハイライトがブロックカーソルのように見える。これは
  // 見た目だけの処理である点に注意: getCursor() は常に selectionStart を
  // 返すため、ここで selectionEnd を拡張しても、エンジン自身のロジックには
  // 何も影響しない。Insert モードでは本物の折りたたまれたキャレットのままにし、
  // Visual モードは（既に本物の、場合によっては複数文字にまたがる）選択が
  // 表示されているのでそのままにする。
  /**
   * 現在のモードに応じて、Normal モード用の疑似ブロックカーソル表示を適用する。
   * @param {InstanceType<Window["VimField"]>|null} field 対象の VimField
   * @returns {void}
   */
  function applyCursorDisplay(field) {
    if (!field || field.mode !== "normal") return;
    const text = field.getText();
    const cur = field.getCursor();
    const { end } = E.lineBounds(text, cur);
    const blockEnd = Math.min(end, cur + 1);
    field.setSel(cur, blockEnd > cur ? blockEnd : cur);
  }

  // リスナーは（document ではなく）window に capture フェーズで登録しており、
  // かつコンテンツスクリプトは document_start で実行されるため、ページ自身の
  // スクリプトが動き出す前に keydown を最初に捕捉できる。一部のサイトは
  // Escape キー自体に反応してモーダルやツールチップを閉じ、その副作用として
  // フィールドから blur させることがあり、これを放置すると本来こちらが
  // 処理すべき Escape を横取りされてしまう。
  window.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      loadSettingsOnce().then(() => {
        // このフォーカスが発生した瞬間には設定がまだ読み込み中だった
        // 可能性がある（新しいフレームでの最初のフォーカスなど）。
        // 楽観的なデフォルト値を信用せず、実際の値が判明した時点で
        // 改めて検証する。
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
        // ちょうど自分自身でフォーカスを取り戻した直後（下の keydown
        // ハンドラを参照）で、制御外の何かによってフィールドが blur
        // させられた後なので、Insert モードへ戻さずユーザーが元々
        // いたモードを維持する。
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
          // こちらでキー処理を終えた直後に、制御外の何か（OS/IME/
          // ブラウザレベルでの特定キー、特に Escape の扱い）によって
          // フォーカスが奪われるケースに対する保険。モード遷移が
          // 起きたときだけに限定しているのは、実際に観測された競合が
          // 特定サイトの Escape/モーダルクローズ処理とこちらの処理との
          // 競合だったためであり、すべての単なるモーション操作のたびに
          // これを行うと、得られる利益がないままキー入力ごとにタイマーを
          // 割り当ててスケジューリングすることになってしまう。
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
