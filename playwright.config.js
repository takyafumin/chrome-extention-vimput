// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["html", { open: "never" }]],
  timeout: 30_000,
  use: {
    trace: "on-first-retry",
    video: "on",
  },
});
