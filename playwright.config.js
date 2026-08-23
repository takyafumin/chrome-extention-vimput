// @ts-check
"use strict";
const { defineConfig } = require("@playwright/test");
const { PORT } = require("./tests/e2e/server.js");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.js",
  timeout: 30_000,
  // Chrome拡張機能のロードにはPersistent Contextが必要で、複数ワーカーで
  // 同時実行すると各ワーカーが専用のブラウザプロファイルを起動してリソースを
  // 圧迫しやすいため、直列実行にしている。
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    // 受け入れテストの実行結果として、操作を録画した動画をPRに添付できるように
    // 毎回動画を記録する。
    video: "on",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/e2e/server.js",
    url: `http://127.0.0.1:${PORT}/page.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
