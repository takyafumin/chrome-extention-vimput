// プレーンテキストバッファに対する Vim 風モーダル編集エンジン。
// 純粋な文字列・インデックス計算のみをここに集約することで、content.js の
// DOM 連携部分から切り離して考察（およびテスト）できるようにしている。
(function (global) {
  "use strict";

  /**
   * 文字が「単語文字」（Vim の word motion 上での word 構成文字）かどうかを判定する。
   * @param {string} ch 判定する1文字
   * @returns {boolean}
   */
  function isWordChar(ch) {
    return /[\p{L}\p{N}_]/u.test(ch);
  }
  /**
   * 文字が空白文字かどうかを判定する。
   * @param {string} ch 判定する1文字
   * @returns {boolean}
   */
  function isSpace(ch) {
    return /\s/.test(ch);
  }
  /**
   * 文字が記号（単語文字でも空白でもない文字）かどうかを判定する。
   * @param {string|undefined} ch 判定する1文字
   * @returns {boolean}
   */
  function isPunct(ch) {
    return ch !== undefined && !isWordChar(ch) && !isSpace(ch);
  }
  /**
   * 文字を "eof" / "space" / "word" / "punct" のいずれかのクラスに分類する。
   * word motion（w/b/e など）の単語境界判定に使う。
   * @param {string|undefined} ch 分類する1文字（バッファ末尾では undefined）
   * @returns {"eof"|"space"|"word"|"punct"}
   */
  function charClass(ch) {
    if (ch === undefined) return "eof";
    if (isSpace(ch)) return "space";
    if (isWordChar(ch)) return "word";
    return "punct";
  }

  /**
   * 指定位置を含む行の開始・終了インデックスを求める。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos 対象位置（文字インデックス）
   * @returns {{start: number, end: number}} 行の開始位置と終了位置（改行文字自体は含まない）
   */
  function lineBounds(text, pos) {
    // インデックス 0 より前には何の文字も存在し得ないため、pos がバッファの
    // 先頭（または それ以前）にある場合は検索の必要がない。この特殊ケースを
    // 個別に扱わず fromIndex を単純に 0 にクランプすると、バッファが空行から
    // 始まる場合に lastIndexOf("\n", 0) が「位置0より前」ではなく「位置0に
    // ちょうどある」改行にマッチしてしまい、start が1行分ずれて先頭行に
    // gg/k で到達できなくなる不具合があった。
    let start;
    if (pos <= 0) {
      start = 0;
    } else {
      const idx = text.lastIndexOf("\n", pos - 1);
      start = idx === -1 ? 0 : idx + 1;
    }
    let end = text.indexOf("\n", pos);
    if (end === -1) end = text.length;
    return { start, end };
  }

  /**
   * Normal モードでのカーソル位置を、その行内の有効な範囲にクランプする
   * （Normal モードでは改行の直後には乗れない）。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos クランプ対象の位置
   * @returns {number} クランプ後の位置
   */
  function clampNormal(text, pos) {
    const { start, end } = lineBounds(text, pos);
    const lastCol = Math.max(start, end - 1);
    if (pos < start) return start;
    if (pos > lastCol) return lastCol;
    return pos;
  }

  /**
   * 現在行の範囲内でカーソルを左に count 文字分移動する（h 相当）。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos 現在位置
   * @param {number} count 移動する文字数
   * @returns {number} 移動後の位置
   */
  function moveLeft(text, pos, count) {
    const { start } = lineBounds(text, pos);
    return Math.max(start, pos - count);
  }

  /**
   * 現在行の範囲内でカーソルを右に count 文字分移動する（l 相当）。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos 現在位置
   * @param {number} count 移動する文字数
   * @param {boolean} allowEnd 行末の改行位置まで移動を許すか（Visual モード等）
   * @returns {number} 移動後の位置
   */
  function moveRight(text, pos, count, allowEnd) {
    const { end } = lineBounds(text, pos);
    const max = allowEnd ? end : Math.max(0, end - 1);
    return Math.min(max, pos + count);
  }

  /**
   * カーソルを上下に count 行分移動する（j/k 相当）。目標列（desiredCol）を
   * 維持しながら移動し、実際に採用した列も返す。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos 現在位置
   * @param {number} delta 移動方向（負なら上、正なら下）
   * @param {number} count 移動する行数
   * @param {number|null|undefined} desiredCol 維持したい列（null/undefined なら現在位置の列を使う）
   * @returns {{pos: number, col: number}} 移動後の位置と、採用した列
   */
  function moveVertical(text, pos, delta, count, desiredCol) {
    let cur = pos;
    const { start: curStart } = lineBounds(text, cur);
    let col = desiredCol !== null && desiredCol !== undefined ? desiredCol : cur - curStart;
    for (let i = 0; i < count; i++) {
      const { start, end } = lineBounds(text, cur);
      if (delta < 0) {
        if (start === 0) break;
        const prevEnd = start - 1;
        const { start: prevStart } = lineBounds(text, prevEnd);
        cur = Math.min(prevEnd, prevStart + col);
        if (cur < prevStart) cur = prevStart;
      } else {
        if (end >= text.length) break;
        const nextStart = end + 1;
        if (nextStart > text.length) break;
        const { end: nextEnd } = lineBounds(text, nextStart);
        cur = Math.min(Math.max(nextStart, nextEnd - 1), nextStart + col);
      }
    }
    return { pos: clampNormal(text, cur), col };
  }

  /**
   * 指定位置を含む行の先頭位置を返す（0 相当）。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos 対象位置
   * @returns {number} 行頭の位置
   */
  function lineStart(text, pos) {
    return lineBounds(text, pos).start;
  }

  /**
   * 指定位置を含む行における、最初の非空白文字の位置を返す（^ 相当）。
   * 行全体が空白のみの場合は行頭を返す。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos 対象位置
   * @returns {number} 最初の非空白文字の位置
   */
  function lineFirstNonBlank(text, pos) {
    const { start, end } = lineBounds(text, pos);
    let i = start;
    while (i < end && isSpace(text[i])) i++;
    return i === end ? start : i;
  }

  /**
   * 指定位置を含む行の末尾位置を返す（$ 相当）。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos 対象位置
   * @param {boolean} forNormal true の場合 Normal モード用に最終文字の位置を返し、
   *   false の場合はオペレータ対象として改行直前（排他的末尾）の位置を返す
   * @returns {number} 行末位置
   */
  function lineEndPos(text, pos, forNormal) {
    const { end } = lineBounds(text, pos);
    return forNormal ? Math.max(lineBounds(text, pos).start, end - 1) : end;
  }

  /**
   * count 個先の単語の先頭へ移動する（w/W 相当）。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos 現在位置
   * @param {number} count 移動する単語数
   * @param {boolean} bigWord true なら WORD（空白区切りのみ）、false なら word（記号も区切りとして扱う）
   * @returns {number} 移動後の位置
   */
  function wordForward(text, pos, count, bigWord) {
    let cur = pos;
    for (let i = 0; i < count; i++) {
      if (cur >= text.length) break;
      let cls = bigWord ? (isSpace(text[cur]) ? "space" : "word") : charClass(text[cur]);
      // 現在の連続領域を読み飛ばす
      while (cur < text.length) {
        const c = bigWord ? (isSpace(text[cur]) ? "space" : "word") : charClass(text[cur]);
        if (c !== cls) break;
        cur++;
      }
      // 空白（改行を含む。Vim の行をまたぐ挙動に合わせる）を読み飛ばす
      while (cur < text.length && isSpace(text[cur])) cur++;
    }
    return Math.min(cur, text.length);
  }

  /**
   * count 個先の単語の末尾へ移動する（e/E 相当）。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos 現在位置
   * @param {number} count 移動する単語数
   * @param {boolean} bigWord true なら WORD、false なら word
   * @returns {number} 移動後の位置
   */
  function wordEnd(text, pos, count, bigWord) {
    let cur = pos;
    for (let i = 0; i < count; i++) {
      cur++;
      while (cur < text.length && isSpace(text[cur])) cur++;
      if (cur >= text.length) {
        cur = text.length - 1;
        break;
      }
      let cls = bigWord ? (isSpace(text[cur]) ? "space" : "word") : charClass(text[cur]);
      while (cur + 1 < text.length) {
        const c = bigWord ? (isSpace(text[cur + 1]) ? "space" : "word") : charClass(text[cur + 1]);
        if (c !== cls) break;
        cur++;
      }
    }
    return Math.max(0, Math.min(cur, text.length - 1));
  }

  /**
   * count 個前の単語の先頭へ移動する（b/B 相当）。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos 現在位置
   * @param {number} count 移動する単語数
   * @param {boolean} bigWord true なら WORD、false なら word
   * @returns {number} 移動後の位置
   */
  function wordBackward(text, pos, count, bigWord) {
    let cur = pos;
    for (let i = 0; i < count; i++) {
      if (cur <= 0) break;
      cur--;
      while (cur > 0 && isSpace(text[cur])) cur--;
      if (cur <= 0) {
        cur = 0;
        break;
      }
      let cls = bigWord ? (isSpace(text[cur]) ? "space" : "word") : charClass(text[cur]);
      while (cur > 0) {
        const c = bigWord ? (isSpace(text[cur - 1]) ? "space" : "word") : charClass(text[cur - 1]);
        if (c !== cls) break;
        cur--;
      }
    }
    return cur;
  }

  /**
   * 現在行内で指定した文字を検索し、その位置（または直前/直後の位置）を返す（f/F/t/T 相当）。
   * @param {string} text バッファ全体のテキスト
   * @param {number} pos 検索開始位置
   * @param {string} ch 検索する文字
   * @param {number} dir 検索方向（正なら前方、負なら後方）
   * @param {boolean} till true なら見つけた文字の手前で止まる（t/T 相当）
   * @param {number} count 何番目の出現を探すか
   * @returns {number|null} 見つかった位置。行内に見つからない場合は null
   */
  function findChar(text, pos, ch, dir, till, count) {
    const { start, end } = lineBounds(text, pos);
    let cur = pos;
    let idx = -1;
    for (let i = 0; i < count; i++) {
      if (dir > 0) {
        idx = text.indexOf(ch, cur + 1);
        if (idx === -1 || idx >= end) return null;
      } else {
        idx = text.lastIndexOf(ch, cur - 1);
        if (idx === -1 || idx < start) return null;
      }
      cur = idx;
    }
    return till ? (dir > 0 ? idx - 1 : idx + 1) : idx;
  }

  /**
   * バッファの先頭、または指定行の最初の非空白文字位置を返す（gg 相当）。
   * @param {string} text バッファ全体のテキスト
   * @param {number|null|undefined} atLine 移動先の行番号（1始まり）。省略時はバッファ先頭
   * @returns {number} 移動先の位置
   */
  function documentStart(text, atLine) {
    if (atLine === null || atLine === undefined) return lineFirstNonBlank(text, 0);
    const lines = text.split("\n");
    const idx = Math.max(1, Math.min(lines.length, atLine)) - 1;
    let pos = 0;
    for (let i = 0; i < idx; i++) pos += lines[i].length + 1;
    return lineFirstNonBlank(text, pos);
  }

  /**
   * バッファの末尾、または指定行の最初の非空白文字位置を返す（G 相当）。
   * @param {string} text バッファ全体のテキスト
   * @param {number|null|undefined} atLine 移動先の行番号（1始まり）。省略時はバッファ末尾
   * @returns {number} 移動先の位置
   */
  function documentEnd(text, atLine) {
    if (atLine === null || atLine === undefined) return lineFirstNonBlank(text, text.length);
    return documentStart(text, atLine);
  }

  global.VimTextEngine = {
    isWordChar,
    isSpace,
    isPunct,
    lineBounds,
    clampNormal,
    moveLeft,
    moveRight,
    moveVertical,
    lineStart,
    lineFirstNonBlank,
    lineEndPos,
    wordForward,
    wordEnd,
    wordBackward,
    findChar,
    documentStart,
    documentEnd,
  };
})(typeof window !== "undefined" ? window : globalThis);
