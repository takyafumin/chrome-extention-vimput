# 受け入れテスト(Playwright)

このディレクトリには、実際にChromeへ拡張機能を読み込んだ状態で動作を確認する
受け入れテスト(E2Eテスト)が含まれます。Playwrightの
[Chrome拡張機能テスト](https://playwright.dev/docs/chrome-extensions)方式に従い、
`--load-extension` でリポジトリ直下(`manifest.json`のある場所)をそのまま
未パッケージ拡張機能として読み込みます。

## 事前準備

```bash
npm install
npx playwright install --with-deps chromium
```

## 実行方法

```bash
# ヘッドレスではなく、実ブラウザウィンドウを使って実行する
# (拡張機能のテストには headless: false の起動が必要なため)
npm run test:e2e
```

GUIのないサーバー環境(CI等)で実行する場合は、仮想ディスプレイ経由で実行してください。

```bash
xvfb-run -a npm run test:e2e
```

その他の実行方法:

```bash
# ブラウザの動きを目視しながらデバッグする
npm run test:e2e:headed

# Playwrightの対話型UIモードで実行する
npm run test:e2e:ui

# 直近の実行結果(録画動画・トレースを含む)をブラウザで開く
npm run test:e2e:report
```

## 何を検証しているか

- `mode-switching.spec.js`
  - textarea / input / contenteditable のいずれでも、フォーカス直後は
    Insertモード(素の入力)になること
  - `Esc` でNormalモードに入り、モードインジケータバッジが `NORMAL` になること
  - Normalモードでの基本操作(`0`, `x`, `dd`, `yy`/`p`, `u`)が正しく反映されること
  - `i` でInsertモードに戻り、バッジが `INSERT` になること
  - `v` でVisualモードに入り、選択範囲に対する `d` が機能すること
- `popup-toggle.spec.js`
  - ツールバーのポップアップで拡張機能全体をOFFにすると、`Esc` を押しても
    Normalモードに入らなくなること(＝ページ側の挙動に何も介入しないこと)
  - 再度ONにすると元の挙動に戻ること

## 動画・トレースについて

`playwright.config.js` で `video: "on"` を指定しているため、実行するたびに
各テストの操作を録画した動画が `test-results/` 配下に生成されます。
失敗したテストについては加えてトレース(`trace: "retain-on-failure"`)も
保存されます。PRに受け入れテストの実施結果を添付する際は、この録画動画または
`npm run test:e2e:report` で開けるHTMLレポートを添付してください。

`test-results/` と `playwright-report/` はリポジトリには含めません(`.gitignore`
で除外済み)。
