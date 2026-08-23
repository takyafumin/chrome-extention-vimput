# 受け入れテスト(E2E)

[Playwright](https://playwright.dev/docs/chrome-extensions)を使い、この拡張機能を実際にChromiumへ`--load-extension`でロードした状態でNormal/Insert/Visualモードの切り替えや基本編集操作を検証します。

## 実行方法

```bash
npm install
npx playwright install --with-deps chromium
npm run test:e2e
```

拡張機能のロードにはヘッドフルなChromiumが必要です。GUIのないサーバー環境(CIなど)では[xvfb](https://en.wikipedia.org/wiki/Xvfb)を使って実行してください。

```bash
xvfb-run -a npm run test:e2e
```

テスト結果のHTMLレポート(実行のたびに録画される操作動画を含む)は以下で確認できます。

```bash
npm run test:e2e:report
```

## 構成

- `fixtures.js` — 拡張機能をロードしたPersistent Context(`chromium.launchPersistentContext`)を用意するカスタムフィクスチャ
- `server.js` — フィクスチャページを配信する最小限の静的サーバー(`playwright.config.js`の`webServer`から自動起動)
- `fixtures/page.html` — `textarea` / `input[type=text]` / `contenteditable`を配置したテスト用ページ
- `mode-switching.spec.js` — Normal/Insert/Visualモードの切り替え、`x` `dd` `yy` `p` `u`などの基本編集操作
- `popup-toggle.spec.js` — ツールバーポップアップからの拡張機能全体のON/OFF切り替え

## PRへの添付

`playwright.config.js`で`video: "on"`を指定しているため、実行するたびに`test-results/`配下に操作を録画した動画が生成されます。この動画やHTMLレポートを、受け入れテスト結果としてPRに添付してください。
