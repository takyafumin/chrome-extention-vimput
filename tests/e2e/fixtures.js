// Chrome拡張機能を実際に読み込んだ状態でテストするためのカスタムフィクスチャ。
// https://playwright.dev/docs/chrome-extensions の手順に従い、
// launchPersistentContext + --load-extension で拡張機能をロードする。
// MV3拡張機能はheadlessモードでは読み込めないため headless: false を使う
// (GUIの無いサーバーでは `xvfb-run` 経由で実行する。README参照)。
const path = require("path");
const { chromium, test: base, expect } = require("@playwright/test");
const { startFixtureServer } = require("./server");

const EXTENSION_PATH = path.join(__dirname, "..", "..");

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
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

  fixtureUrl: async ({}, use) => {
    const { server, url } = await startFixtureServer();
    await use(url);
    server.close();
  },

  page: async ({ context, fixtureUrl }, use) => {
    const page = await context.newPage();
    await page.goto(fixtureUrl);
    await use(page);
    await page.close();
  },
});

module.exports = { test, expect };
