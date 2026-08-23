const { test, expect } = require("./fixtures");

const badge = (page) => page.locator(".badge");

test("ポップアップから拡張機能をOFFにすると、Escapeを押してもNormalモードに入らなくなる", async ({
  context,
  extensionId,
  page,
}) => {
  const textarea = page.locator("#textarea");
  await textarea.click();
  await expect(badge(page)).toHaveText("INSERT");
  await page.keyboard.press("Escape");
  await expect(badge(page)).toHaveText("NORMAL");

  // ポップアップを開き、拡張機能全体をOFFにする
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(popup.locator("#globalToggle")).toBeChecked();
  await popup.locator(".row:has(#globalToggle) .slider").click();
  await expect(popup.locator("#globalToggle")).not.toBeChecked();
  await popup.close();

  // OFFの状態でEscapeを押してもNormalモードに切り替わらず、
  // モードインジケータも表示されないことを確認する
  await textarea.click();
  await expect(badge(page)).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(badge(page)).toBeHidden();
});
