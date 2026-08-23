const { test, expect } = require("./fixtures");

const badge = (page) => page.locator(".badge");

test.describe("モードの切り替え", () => {
  test("フォーカス直後はInsertモードで、EscapeでNormalモードに入る", async ({ page }) => {
    await page.locator("#textarea").click();
    await expect(badge(page)).toHaveText("INSERT");

    await page.keyboard.press("Escape");
    await expect(badge(page)).toHaveText("NORMAL");
  });

  test("iキーでNormalモードからInsertモードへ戻る", async ({ page }) => {
    await page.locator("#textarea").click();
    await page.keyboard.press("Escape");
    await expect(badge(page)).toHaveText("NORMAL");

    await page.keyboard.press("i");
    await expect(badge(page)).toHaveText("INSERT");
  });

  test("vでVisualモード、VでVisual Lineモードに入り、EscapeでNormalモードへ戻る", async ({ page }) => {
    const textarea = page.locator("#textarea");
    await textarea.click();
    await page.keyboard.type("hello world");
    await page.keyboard.press("Escape");

    await page.keyboard.press("v");
    await expect(badge(page)).toHaveText("VISUAL");
    await page.keyboard.press("Escape");
    await expect(badge(page)).toHaveText("NORMAL");

    await page.keyboard.press("V");
    await expect(badge(page)).toHaveText("V-LINE");
    await page.keyboard.press("Escape");
    await expect(badge(page)).toHaveText("NORMAL");
  });
});

test.describe("基本編集コマンド (textarea)", () => {
  test("x でカーソル位置の1文字を削除する", async ({ page }) => {
    const textarea = page.locator("#textarea");
    await textarea.click();
    await page.keyboard.type("abc");
    await page.keyboard.press("Escape");

    await page.keyboard.press("0");
    await page.keyboard.press("x");
    await expect(textarea).toHaveValue("bc");
  });

  test("dd で1行削除し、u で元に戻せる", async ({ page }) => {
    const textarea = page.locator("#textarea");
    await textarea.click();
    await page.keyboard.type("line1\nline2\nline3");
    await page.keyboard.press("Escape");

    await page.keyboard.press("g");
    await page.keyboard.press("g");
    await page.keyboard.press("d");
    await page.keyboard.press("d");
    await expect(textarea).toHaveValue("line2\nline3");

    await page.keyboard.press("u");
    await expect(textarea).toHaveValue("line1\nline2\nline3");
  });

  test("yy と p で行をヤンク・ペーストする", async ({ page }) => {
    const textarea = page.locator("#textarea");
    await textarea.click();
    await page.keyboard.type("line1\nline2");
    await page.keyboard.press("Escape");

    await page.keyboard.press("g");
    await page.keyboard.press("g");
    await page.keyboard.press("y");
    await page.keyboard.press("y");
    await page.keyboard.press("p");
    await expect(textarea).toHaveValue("line1\nline1\nline2");
  });
});

test.describe("input / contenteditable でも動作する", () => {
  test("input[type=text] で x による削除が動作する", async ({ page }) => {
    const input = page.locator("#input");
    await input.click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Escape");

    await page.keyboard.press("0");
    await page.keyboard.press("x");
    await expect(input).toHaveValue("ello");
  });

  test("contenteditable で x による削除が動作する", async ({ page }) => {
    const editable = page.locator("#editable");
    await editable.click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Escape");

    await page.keyboard.press("0");
    await page.keyboard.press("x");
    await expect(editable).toHaveText("ello");
  });
});
