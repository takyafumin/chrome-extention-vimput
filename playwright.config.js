// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  // 拡張機能ごとにPersistent Context(専用プロファイル)を起動するため、
  // 同時起動数を抑えて安定性を優先する。
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    // 受け入れテストの実施結果としてPRに添付できるよう、常に録画する。
    video: "on",
  },
  webServer: {
    command: "node tests/e2e/server.js",
    url: "http://localhost:4173/page.html",
    reuseExistingServer: !process.env.CI,
  },
});
