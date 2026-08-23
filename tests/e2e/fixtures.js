// 拡張機能を実際にロードしたPersistent Contextを提供するカスタムフィクスチャ。
// https://playwright.dev/docs/chrome-extensions に準拠し、`--load-extension`と
// `--disable-extensions-except`で拡張機能ディレクトリをChromiumに読み込む。
"use strict";
const path = require("path");
const { test: base, chromium } = require("@playwright/test");

const EXTENSION_PATH = path.resolve(__dirname, "..", "..");

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      // MV3のservice workerを含む拡張機能はheadlessモードでは正しく動作しないため、
      // headedで起動する(GUIのないサーバーではxvfb-run経由での実行を想定)。
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extensionId = worker.url().split("/")[2];
    await use(extensionId);
  },
});

const expect = base.expect;

module.exports = { test, expect };
