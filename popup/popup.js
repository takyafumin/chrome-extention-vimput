/**
 * ポップアップ画面の初期化処理。
 * アクティブなタブのホスト名を取得し、グローバル設定とサイトごとの
 * 上書き設定をストレージから読み込んで、各トグルスイッチに反映する。
 * @returns {Promise<void>}
 */
(async function () {
  const globalToggle = document.getElementById("globalToggle");
  const siteToggle = document.getElementById("siteToggle");
  const siteHost = document.getElementById("siteHost");

  let host = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) host = new URL(tab.url).hostname;
  } catch (_) {
    host = null;
  }
  siteHost.textContent = host || "(このページでは利用できません)";
  if (!host) siteToggle.disabled = true;

  // globalEnabled は単一の真偽値で、デバイス間で同期される。siteOverrides は
  // ホスト名ごとの選択を保持し、ローカルにのみ保存される（background.js 参照）。
  const [{ globalEnabled = true }, { siteOverrides = {} }] = await Promise.all([
    chrome.storage.sync.get(["globalEnabled"]),
    chrome.storage.local.get(["siteOverrides"]),
  ]);

  globalToggle.checked = globalEnabled;
  siteToggle.checked = host ? siteOverrides[host] === false : false;

  globalToggle.addEventListener("change", async () => {
    await chrome.storage.sync.set({ globalEnabled: globalToggle.checked });
  });

  siteToggle.addEventListener("change", async () => {
    if (!host) return;
    const cur = (await chrome.storage.local.get(["siteOverrides"])).siteOverrides || {};
    if (siteToggle.checked) {
      cur[host] = false; // このサイトでは明示的に無効化する
    } else {
      delete cur[host];
    }
    await chrome.storage.local.set({ siteOverrides: cur });
  });
})();
