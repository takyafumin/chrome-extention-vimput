// ツールバーのポップアップから拡張機能全体をON/OFFできることの受け入れテスト。
"use strict";
const { test, expect } = require("./fixtures.js");
const { PORT } = require("./server.js");

const FIXTURE_URL = `http://127.0.0.1:${PORT}/page.html`;

test.describe("ポップアップからの有効/無効切り替え", () => {
  test("グローバルトグルをOFFにすると、Escapeを押してもNormalモードにならない", async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const globalToggle = popup.locator("#globalToggle");
    await expect(globalToggle).toBeChecked();

    await globalToggle.uncheck();
    await expect(globalToggle).not.toBeChecked();
    // popup.js の storage.sync.set は change イベントハンドラ内で非同期に実行される
    // ため、書き込みの完了をポーリングで確認してからポップアップを閉じる。
    await expect
      .poll(async () => (await popup.evaluate(() => chrome.storage.sync.get(["globalEnabled"]))).globalEnabled)
      .toBe(false);
    await popup.close();

    const page = await context.newPage();
    await page.goto(FIXTURE_URL);
    const ta = page.locator("#ta");
    await ta.fill("abc");
    await ta.click();
    await page.keyboard.press("Escape");

    // 拡張機能が無効なので、モードインジケータのバッジは表示されないままのはず。
    await expect(page.locator(".badge")).toHaveCount(0);
    // Escapeがブラウザの既定動作のままになるため、値も変化しない。
    await expect(ta).toHaveValue("abc");
    await page.close();
  });

  test("グローバルトグルをONに戻すと、Escapeで再びNormalモードになる", async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const globalToggle = popup.locator("#globalToggle");
    await globalToggle.uncheck();
    await expect
      .poll(async () => (await popup.evaluate(() => chrome.storage.sync.get(["globalEnabled"]))).globalEnabled)
      .toBe(false);
    await globalToggle.check();
    await expect(globalToggle).toBeChecked();
    await expect
      .poll(async () => (await popup.evaluate(() => chrome.storage.sync.get(["globalEnabled"]))).globalEnabled)
      .toBe(true);
    await popup.close();

    const page = await context.newPage();
    await page.goto(FIXTURE_URL);
    const ta = page.locator("#ta");
    await ta.click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".badge")).toHaveText("NORMAL");
    await page.close();
  });
});
