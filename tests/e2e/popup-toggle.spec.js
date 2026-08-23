// 受け入れテスト: ツールバーのポップアップから拡張機能のON/OFFを切り替えると、
// ページ側のVim動作(Escによるモード切り替え)に反映されることを確認する。
"use strict";
const { test, expect, getBadgeState } = require("./fixtures");

test.describe("ポップアップからの有効/無効切り替え", () => {
  test.afterEach(async ({ context, extensionId }) => {
    // 次のテストに影響しないよう、グローバル設定をONに戻しておく。
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const globalToggle = popup.locator("#globalToggle");
    if (!(await globalToggle.isChecked())) await globalToggle.click();
    await popup.close();
  });

  test("拡張機能全体をOFFにすると、Escを押してもNormalモードにならない", async ({
    context,
    extensionId,
    page,
  }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const globalToggle = popup.locator("#globalToggle");
    await expect(globalToggle).toBeChecked();
    await globalToggle.click();
    await expect(globalToggle).not.toBeChecked();
    await popup.close();

    await page.goto("/page.html");
    const ta = page.locator("#ta");
    await ta.click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Escape");

    // 拡張機能が無効なのでバッジは表示されず、Escはそのままtextareaに渡る
    // (フォーカスは外れず、値も変化しない)。
    const badge = await getBadgeState(page);
    expect(badge === null || badge.visible === false).toBeTruthy();
    await expect(ta).toHaveValue("hello");
  });

  test("再度ONにすると、Escでの Normal モード切り替えが復活する", async ({
    context,
    extensionId,
    page,
  }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const globalToggle = popup.locator("#globalToggle");
    await globalToggle.click(); // OFF
    await globalToggle.click(); // 再度ON
    await expect(globalToggle).toBeChecked();
    await popup.close();

    await page.goto("/page.html");
    const ta = page.locator("#ta");
    await ta.click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Escape");
    await expect.poll(() => getBadgeState(page)).toEqual(expect.objectContaining({ text: "NORMAL" }));
  });
});
