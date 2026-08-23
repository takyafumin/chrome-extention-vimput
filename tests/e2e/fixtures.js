// Chrome拡張機能を実際に読み込んだ状態でテストするためのカスタムフィクスチャ。
// https://playwright.dev/docs/chrome-extensions の手順に従い、
// launchPersistentContext + --load-extension で拡張機能をロードする。
// MV3拡張機能はheadlessモードでは読み込めないため headless: false を使う
// (GUIの無いサーバーでは `xvfb-run` 経由で実行する。README参照)。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium, test: base, expect } = require("@playwright/test");
const { startFixtureServer } = require("./server");

const EXTENSION_PATH = path.join(__dirname, "..", "..");
// 各操作の間に挟むディレイ(ms)。0だと全操作が一瞬で終わり、録画される動画も
// 1秒に満たない長さになって目視で内容を追えなくなるため、既定でwaitを入れる。
// 環境変数 PW_SLOW_MO で上書き可能(例: CIで無効化したい場合は `PW_SLOW_MO=0`)。
const SLOW_MO = process.env.PW_SLOW_MO !== undefined ? Number(process.env.PW_SLOW_MO) : 300;

const test = base.extend({
  context: async ({}, use, testInfo) => {
    const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vimput-pw-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      slowMo: SLOW_MO,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
      recordVideo: { dir: testInfo.outputPath("") },
    });
    // launchPersistentContextを使うとPlaywright組み込みのcontext/pageフィクスチャを
    // 経由しないため、動画の自動アタッチ(テストレポートへの添付)が行われない。
    // そのため、以降に開かれたページを自前で記録しておき、context.close()後に
    // 各ページの動画をtestInfo.attachで明示的にレポートへ添付する。
    const pages = [];
    context.on("page", (page) => pages.push(page));
    // launchPersistentContextは起動時に自動でabout:blankタブを1枚開く。
    // 使われないまま残ると動画エンコード対象が増えてcontext.close()が遅くなるため、即座に閉じる。
    const [initialPage] = context.pages();
    if (initialPage) await initialPage.close();
    try {
      await use(context);
    } finally {
      await context.close();
      await Promise.all(
        pages.map(async (page) => {
          const video = page.video();
          if (!video) return;
          try {
            const videoPath = await video.path();
            await testInfo.attach("video", { path: videoPath, contentType: "video/webm" });
          } catch {
            // ページがコンテンツを読み込む前に閉じられた場合など、動画が存在しないことがある
          }
        })
      );
      await fs.promises.rm(userDataDir, { recursive: true, force: true });
    }
  },

  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) background = await context.waitForEvent("serviceworker");
    const extensionId = background.url().split("/")[2];
    await use(extensionId);
  },

  fixtureUrl: async ({}, use) => {
    const { server, url } = await startFixtureServer();
    try {
      await use(url);
    } finally {
      // ChromeがHTTP keep-aliveでソケットを保持したままだと、
      // server.close()はテスト側のcontextが閉じてソケットが切れるまで
      // コールバックを呼ばず、テストタイムアウト(30s)まで固まってしまう。
      // 明示的に全接続を切断してから閉じることで即座に完了させる。
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },

  page: async ({ context, fixtureUrl }, use, testInfo) => {
    const page = await context.newPage();
    await page.goto(fixtureUrl);
    await use(page);
    // 動画と同様、独自のcontext/pageフィクスチャを使っているため
    // スクリーンショットもPlaywrightの自動アタッチが働かない。
    // テスト終了時点の画面を明示的にキャプチャしてレポートへ添付する。
    try {
      const screenshot = await page.screenshot();
      await testInfo.attach("screenshot", { body: screenshot, contentType: "image/png" });
    } catch {
      // ページがすでに閉じている/クラッシュしている場合はスキップする
    }
    await page.close();
  },
});

module.exports = { test, expect };
