// 受け入れテスト: Normal / Insert モードの切り替えと基本的な編集操作。
// README.md「使い方」「対応キー」章に記載の挙動を検証する。
"use strict";
const { test, expect, getBadgeState } = require("./fixtures");

test.describe("モード切り替えと基本編集", () => {
  test("textareaはフォーカス直後Insertモードで、そのまま入力できる", async ({ page }) => {
    await page.goto("/page.html");
    const ta = page.locator("#ta");
    await ta.click();
    await page.keyboard.type("hello");
    await expect(ta).toHaveValue("hello");
  });

  test("Escでノーマルモードに入り、バッジがNORMALになる", async ({ page }) => {
    await page.goto("/page.html");
    const ta = page.locator("#ta");
    await ta.click();
    await page.keyboard.type("hello world");
    await page.keyboard.press("Escape");
    await expect
      .poll(() => getBadgeState(page))
      .toEqual(expect.objectContaining({ text: "NORMAL", visible: true }));
  });

  test("Normalモードで0の後にxを押すと行頭の1文字が削除される", async ({ page }) => {
    await page.goto("/page.html");
    const ta = page.locator("#ta");
    await ta.click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Escape");
    await page.keyboard.press("0");
    await page.keyboard.press("x");
    await expect(ta).toHaveValue("ello");
  });

  test("iでInsertモードに戻り、バッジがINSERTになる", async ({ page }) => {
    await page.goto("/page.html");
    const ta = page.locator("#ta");
    await ta.click();
    await page.keyboard.type("abc");
    await page.keyboard.press("Escape");
    await page.keyboard.press("i");
    await expect.poll(() => getBadgeState(page)).toEqual(expect.objectContaining({ text: "INSERT" }));
    await page.keyboard.type("X");
    await expect(ta).toHaveValue("abXc");
  });

  test("ddで現在行を1行削除できる", async ({ page }) => {
    await page.goto("/page.html");
    const ta = page.locator("#ta");
    await ta.click();
    await page.keyboard.type("line1\nline2\nline3");
    await page.keyboard.press("Escape");
    await page.keyboard.press("0");
    await page.keyboard.press("k");
    await page.keyboard.press("k");
    await page.keyboard.press("d");
    await page.keyboard.press("d");
    await expect(ta).toHaveValue("line2\nline3");
  });

  test("yyとpで行のヤンク・ペーストができる", async ({ page }) => {
    await page.goto("/page.html");
    const ta = page.locator("#ta");
    await ta.click();
    await page.keyboard.type("line1\nline2");
    await page.keyboard.press("Escape");
    await page.keyboard.press("0");
    await page.keyboard.press("k");
    await page.keyboard.press("y");
    await page.keyboard.press("y");
    await page.keyboard.press("p");
    await expect(ta).toHaveValue("line1\nline1\nline2");
  });

  test("uでundoができる", async ({ page }) => {
    await page.goto("/page.html");
    const ta = page.locator("#ta");
    await ta.click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Escape");
    await page.keyboard.press("0");
    await page.keyboard.press("x");
    await expect(ta).toHaveValue("ello");
    await page.keyboard.press("u");
    await expect(ta).toHaveValue("hello");
  });

  test("input要素でもEscでNormalモードに入る", async ({ page }) => {
    await page.goto("/page.html");
    const inp = page.locator("#inp");
    await inp.click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Escape");
    await expect.poll(() => getBadgeState(page)).toEqual(expect.objectContaining({ text: "NORMAL" }));
    await page.keyboard.press("0");
    await page.keyboard.press("x");
    await expect(inp).toHaveValue("ello");
  });

  test("contenteditableでもEscでNormalモードに入り、xで1文字削除できる", async ({ page }) => {
    await page.goto("/page.html");
    const ce = page.locator("#ce");
    await ce.click();
    await page.keyboard.type("hi");
    await page.keyboard.press("Escape");
    await expect.poll(() => getBadgeState(page)).toEqual(expect.objectContaining({ text: "NORMAL" }));
    await page.keyboard.press("0");
    await page.keyboard.press("x");
    await expect(ce).toHaveText("i");
  });
});

test.describe("Visualモード", () => {
  test("vで選択してdを押すと選択範囲が削除される", async ({ page }) => {
    await page.goto("/page.html");
    const ta = page.locator("#ta");
    await ta.click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Escape");
    await page.keyboard.press("0");
    await page.keyboard.press("v");
    await expect.poll(() => getBadgeState(page)).toEqual(expect.objectContaining({ text: "VISUAL" }));
    await page.keyboard.press("l");
    await page.keyboard.press("l");
    await page.keyboard.press("d");
    await expect(ta).toHaveValue("lo");
  });
});
