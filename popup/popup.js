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

  // globalEnabled is a single boolean, synced across devices; siteOverrides
  // maps hostnames to a choice and stays local-only (see background.js).
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
      cur[host] = false; // explicit per-site disable
    } else {
      delete cur[host];
    }
    await chrome.storage.local.set({ siteOverrides: cur });
  });
})();
