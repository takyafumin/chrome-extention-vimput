// Chrome拡張機能をロードした状態でテストを実行するための、
// Playwright公式が案内している方式(Persistent Context + --load-extension)の
// カスタムフィクスチャ。
// https://playwright.dev/docs/chrome-extensions
"use strict";
const path = require("node:path");
const base = require("@playwright/test");

const EXTENSION_PATH = path.join(__dirname, "..", "..");

exports.test = base.test.extend({
  context: async ({}, use) => {
    const context = await base.chromium.launchPersistentContext("", {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) background = await context.waitForEvent("serviceworker");
    const extensionId = background.url().split("/")[2];
    await use(extensionId);
  },
  page: async ({ context }, use) => {
    const page = context.pages()[0] || (await context.newPage());
    await use(page);
  },
});

exports.expect = base.expect;

/**
 * ページ内に表示されているモードインジケータバッジ(Shadow DOM)の状態を取得する。
 * @param {import("@playwright/test").Page} page 対象ページ
 * @returns {Promise<{text: string, visible: boolean} | null>} バッジのテキストと表示状態(未表示ならnull)
 */
exports.getBadgeState = function getBadgeState(page) {
  return page.evaluate(() => {
    for (const el of document.documentElement.children) {
      if (el.shadowRoot) {
        const badge = el.shadowRoot.querySelector(".badge");
        if (badge) {
          return { text: badge.textContent, visible: el.style.display !== "none" };
        }
      }
    }
    return null;
  });
};
