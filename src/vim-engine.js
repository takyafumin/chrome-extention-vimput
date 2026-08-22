// Vim-style modal editing engine for plain-text buffers.
// Pure string/index math lives here so it can be reasoned about (and tested)
// independently from the DOM glue in content.js.
(function (global) {
  "use strict";

  function isWordChar(ch) {
    return /[\p{L}\p{N}_]/u.test(ch);
  }
  function isSpace(ch) {
    return /\s/.test(ch);
  }
  function isPunct(ch) {
    return ch !== undefined && !isWordChar(ch) && !isSpace(ch);
  }
  function charClass(ch) {
    if (ch === undefined) return "eof";
    if (isSpace(ch)) return "space";
    if (isWordChar(ch)) return "word";
    return "punct";
  }

  function lineBounds(text, pos) {
    // No character can precede index 0, so there's nothing to search for
    // when pos is at (or before) the very start of the buffer. Clamping the
    // search's fromIndex to 0 instead of special-casing this used to make
    // lastIndexOf("\n", 0) match a newline that sits AT position 0 (rather
    // than strictly before it) whenever the buffer starts with a blank
    // line, which threw off `start` by one line and made that first line
    // unreachable via gg/k.
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

  function clampNormal(text, pos) {
    const { start, end } = lineBounds(text, pos);
    const lastCol = Math.max(start, end - 1);
    if (pos < start) return start;
    if (pos > lastCol) return lastCol;
    return pos;
  }

  function moveLeft(text, pos, count) {
    const { start } = lineBounds(text, pos);
    return Math.max(start, pos - count);
  }

  function moveRight(text, pos, count, allowEnd) {
    const { end } = lineBounds(text, pos);
    const max = allowEnd ? end : Math.max(0, end - 1);
    return Math.min(max, pos + count);
  }

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

  function lineStart(text, pos) {
    return lineBounds(text, pos).start;
  }

  function lineFirstNonBlank(text, pos) {
    const { start, end } = lineBounds(text, pos);
    let i = start;
    while (i < end && isSpace(text[i])) i++;
    return i === end ? start : i;
  }

  function lineEndPos(text, pos, forNormal) {
    const { end } = lineBounds(text, pos);
    return forNormal ? Math.max(lineBounds(text, pos).start, end - 1) : end;
  }

  function wordForward(text, pos, count, bigWord) {
    let cur = pos;
    for (let i = 0; i < count; i++) {
      if (cur >= text.length) break;
      let cls = bigWord ? (isSpace(text[cur]) ? "space" : "word") : charClass(text[cur]);
      // skip current run
      while (cur < text.length) {
        const c = bigWord ? (isSpace(text[cur]) ? "space" : "word") : charClass(text[cur]);
        if (c !== cls) break;
        cur++;
      }
      // skip whitespace (including newlines, matching vim's cross-line behaviour)
      while (cur < text.length && isSpace(text[cur])) cur++;
    }
    return Math.min(cur, text.length);
  }

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

  function documentStart(text, atLine) {
    if (atLine === null || atLine === undefined) return lineFirstNonBlank(text, 0);
    const lines = text.split("\n");
    const idx = Math.max(1, Math.min(lines.length, atLine)) - 1;
    let pos = 0;
    for (let i = 0; i < idx; i++) pos += lines[i].length + 1;
    return lineFirstNonBlank(text, pos);
  }

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
