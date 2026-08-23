# Vim for Text Fields

Chromeの`<textarea>`・`<input>`・`contenteditable`要素にVim風のモーダル編集(Normal / Insert / Visual)を追加するChrome拡張機能です。

## インストール(開発者モードで読み込み)

1. Chromeで `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をオンにする
3. 「パッケージ化されていない拡張機能を読み込む」をクリックし、このフォルダ(`google-extention-vim`)を選択する
4. ツールバーにアイコンが表示されれば完了

## 使い方

- テキストフィールドをクリック/フォーカスした直後は **Insertモード**(通常の入力)です。
- `Esc` を押すと **Normalモード** に入り、Vimのキー操作で編集できます。
- フィールドの左下に現在のモードを示す小さなバッジが表示されます(緑=Insert、青=Normal、橙=Visual、紫=Visual Line)。
- Normalモードでは、カーソル位置の1文字を選択状態にすることでVimのブロックカーソル風の見た目にしています(textarea/inputはブロックカーソルを描画するAPIがないため、選択ハイライトで代用しています)。
- サイト側が`Escape`を横取りしてフォーカスを外してしまう場合の代替として、Insertモード中に `j` を2回素早く(350ms以内)入力すると `Esc` と同じ扱いになります。
- ツールバーアイコンから、拡張機能全体のON/OFFと、サイトごとの無効化ができます。

## 対応キー

### 移動
`h j k l` `w W b B e E` `0 ^ $` `gg G` `f{c} F{c} t{c} T{c}` `; ,`
矢印キー・Space・Backspace・Enterも一部の移動として扱われます。

### 編集
`i a I A o O` (Insertモードへ)
`x X D C Y` `~`
`d{motion} c{motion} y{motion}` (`dd cc yy` を含む)
`p P` (ペースト) `u` (undo) `Ctrl+r` (redo) `.` (直前の変更を繰り返す・一部コマンドのみ)

### Visual
`v` (Visual) `V` (Visual Line)、選択中に `d c y p` などを実行

カウント(`3w`, `2dd` など)にも対応しています。

## 制限事項

これは実用的なサブセットの実装で、以下は未対応です:

- 名前付きレジスタ(`"a`など)・マクロ・検索(`/`, `?`)・マーク
- テキストオブジェクト(`iw`, `a"` など)
- `.`によるdot-repeatは`i a I A o O`系と単純な単発コマンドのみ対応(`c{motion}`の再現は未対応)
- `contenteditable`はリッチなDOM構造を持つエディタ(Notion風の複雑なブロックなど)では挙動が不安定な場合があります

## ファイル構成

- `manifest.json` — MV3マニフェスト
- `src/vim-engine.js` — カーソル移動・単語境界などの純粋なテキストロジック(DOM非依存)
- `src/dom-helpers.js` — 対象要素の判定と、要素の値/選択範囲の読み書き(React等のcontrolled inputにも対応)
- `src/vim-field.js` — Normal/Insert/Visualのモーダル編集状態機械(`VimField`)本体
- `src/content.js` — 設定の読み込み・モードインジケータ・フォーカス/キー入力の配線(グルーコード)
- `popup/` — ツールバーのポップアップUI(ON/OFF切り替え)
- `background.js` — インストール時の初期設定
- `tests/e2e/` — Playwrightによる受け入れテスト(詳細は[tests/e2e/README.md](tests/e2e/README.md)参照)

読み込み順は `vim-engine.js` → `dom-helpers.js` → `vim-field.js` → `content.js`(`manifest.json`の`content_scripts.js`の順序に対応)。

## 受け入れテスト

実際にChromeへ拡張機能を読み込んだ状態でVimの操作を検証する受け入れテスト(E2Eテスト)を
[Playwright](https://playwright.dev/)で用意しています。実行方法・検証内容は
[tests/e2e/README.md](tests/e2e/README.md)を参照してください。

```bash
npm install
npx playwright install --with-deps chromium
npm run test:e2e
```

## プライバシー

- `globalEnabled`(全体のON/OFF)は`chrome.storage.sync`に保存し、デバイス間で同期されます。
- `siteOverrides`(サイトごとの無効化設定)は閲覧履歴の断片になり得るため、あえて`chrome.storage.local`に保存し、Chrome同期やGoogleアカウントには一切送信されません。
