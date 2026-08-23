# 受け入れテスト (Playwright)

Chrome拡張機能を実際にChromiumへ読み込んだ状態で、[Playwright](https://playwright.dev/docs/chrome-extensions)を用いて動作を検証する受け入れテスト(E2Eテスト)です。

## テスト対象

- `mode-switching.spec.js` — Normal/Insert/Visual(V-LINE含む)モードの切り替え、および `x` `dd`(+`u`でundo) `yy`/`p` などの基本編集操作。textarea / input / contenteditable のすべてで確認します。
- `popup-toggle.spec.js` — ポップアップから拡張機能全体をOFFにした際、Escapeを押してもNormalモードに入らなくなること(拡張機能が無効化されていること)を確認します。

## 実行方法

```bash
npm install
npx playwright install --with-deps chromium
npm run test:e2e
```

拡張機能はheadlessモードでは読み込めないため、`playwright.config.js`では実ブラウザウィンドウを起動します。GUIの無いサーバー環境(CIなど)では [`xvfb-run`](https://manpages.ubuntu.com/manpages/jammy/man1/xvfb-run.1.html) 経由で実行してください。

```bash
xvfb-run -a npm run test:e2e
```

## テスト結果の確認

`use.video: "on"` を設定しているため、実行するたびに操作の様子を録画した動画が `test-results/` 配下に生成されます。また、以下のコマンドでHTMLレポート(録画・トレース付き)を閲覧できます。

```bash
npm run test:e2e:report
```

PRへ受け入れテスト結果を添付する際は、これらの動画やHTMLレポートをご利用ください。
