// Normal/Insert/Visualモードの切り替えと、基本的な編集コマンド
// (x, dd, yy/p, u) の受け入れテスト。
"use strict";
const { test, expect } = require("./fixtures.js");
const { PORT } = require("./server.js");

const FIXTURE_URL = `http://127.0.0.1:${PORT}/page.html`;

test.describe("モード切り替えと基本編集操作", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE_URL);
  });

  test("フィールドにフォーカスした直後はInsertモードで、そのまま入力できる", async ({ page }) => {
    const ta = page.locator("#ta");
    await ta.click();
    await expect(page.locator(".badge")).toHaveText("INSERT");

    await page.keyboard.type("hello");
    await expect(ta).toHaveValue("hello");
  });

  test("Escapeを押すとNormalモードになり、0とxでカーソル位置の文字を削除できる", async ({ page }) => {
    const ta = page.locator("#ta");
    await ta.fill("abc");
    await ta.click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".badge")).toHaveText("NORMAL");

    await page.keyboard.press("0");
    await page.keyboard.press("x");
    await expect(ta).toHaveValue("bc");
  });

  test("ddで行削除、uでundoできる", async ({ page }) => {
    const ta = page.locator("#ta");
    await ta.fill("line1\nline2\nline3");
    await ta.click();
    await page.keyboard.press("Escape");

    // 先頭行へ移動してから1行下(line2)へ進み、その行を削除する。
    await page.keyboard.press("g");
    await page.keyboard.press("g");
    await page.keyboard.press("j");
    await page.keyboard.press("d");
    await page.keyboard.press("d");
    await expect(ta).toHaveValue("line1\nline3");

    await page.keyboard.press("u");
    await expect(ta).toHaveValue("line1\nline2\nline3");
  });

  test("yyとpで行をヤンク&ペーストできる", async ({ page }) => {
    const ta = page.locator("#ta");
    await ta.fill("line1\nline2");
    await ta.click();
    await page.keyboard.press("Escape");

    await page.keyboard.press("g");
    await page.keyboard.press("g");
    await page.keyboard.press("y");
    await page.keyboard.press("y");
    await page.keyboard.press("j");
    await page.keyboard.press("p");
    await expect(ta).toHaveValue("line1\nline2\nline1");
  });

  test("vでVisualモード、Vで Visual Lineモードに入れる", async ({ page }) => {
    const ta = page.locator("#ta");
    await ta.fill("hello world");
    await ta.click();
    await page.keyboard.press("Escape");

    await page.keyboard.press("v");
    await expect(page.locator(".badge")).toHaveText("VISUAL");

    await page.keyboard.press("Escape");
    await expect(page.locator(".badge")).toHaveText("NORMAL");

    await page.keyboard.press("V");
    await expect(page.locator(".badge")).toHaveText("V-LINE");
  });

  test("input要素とcontenteditable要素でもNormalモードの編集操作ができる", async ({ page }) => {
    const inp = page.locator("#inp");
    await inp.fill("abc");
    await inp.click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("0");
    await page.keyboard.press("x");
    await expect(inp).toHaveValue("bc");

    const ce = page.locator("#ce");
    await ce.click();
    await page.keyboard.type("abc");
    await expect(page.locator(".badge")).toHaveText("INSERT");
    await page.keyboard.press("Escape");
    await expect(page.locator(".badge")).toHaveText("NORMAL");
    await page.keyboard.press("0");
    await page.keyboard.press("x");
    await expect(ce).toHaveText("bc");
  });
});
