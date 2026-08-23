// インストール時にデフォルト設定が存在することを保証する。
//
// ストレージを分割している理由（プライバシー保護）:
// `globalEnabled` は単一の真偽値の設定であり、ユーザーの複数デバイス間で
// 同期しても問題ない。一方 `siteOverrides` は特定のホスト名ごとの
// 有効/無効の選択を保持するマップであり、実質的に閲覧履歴の断片と言える。
// そのため storage.local に保存し、Chrome Sync（ユーザーの Google アカウント）
// を通じて送信されないようにしている。

/**
 * 拡張機能インストール時に呼ばれるハンドラ。
 * デフォルト設定を用意し、旧バージョンで storage.sync に保存されていた
 * siteOverrides を storage.local へ移行する。
 * @returns {Promise<void>}
 */
chrome.runtime.onInstalled.addListener(async () => {
  const { globalEnabled } = await chrome.storage.sync.get(["globalEnabled"]);
  if (globalEnabled === undefined) {
    await chrome.storage.sync.set({ globalEnabled: true });
  }

  // 一度限りの移行処理: 以前のバージョンでは siteOverrides を storage.sync に
  // 保存していた。該当データがあれば（既存の値に上書きマージしつつ）
  // storage.local へ移し、sync 側からは削除する。これにより、更新時に
  // サイトごとの設定が気づかぬうちに失われることを防ぐ。
  const legacy = await chrome.storage.sync.get(["siteOverrides"]);
  if (legacy.siteOverrides !== undefined) {
    const { siteOverrides: current = {} } = await chrome.storage.local.get(["siteOverrides"]);
    await chrome.storage.local.set({ siteOverrides: { ...legacy.siteOverrides, ...current } });
    await chrome.storage.sync.remove("siteOverrides");
  } else {
    const { siteOverrides } = await chrome.storage.local.get(["siteOverrides"]);
    if (siteOverrides === undefined) {
      await chrome.storage.local.set({ siteOverrides: {} });
    }
  }
});
