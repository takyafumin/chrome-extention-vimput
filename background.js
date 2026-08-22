// Ensures default settings exist on install.
//
// Storage split rationale (privacy): `globalEnabled` is a single boolean
// preference, harmless to sync across the user's devices. `siteOverrides`
// maps specific hostnames to an on/off choice — effectively a fragment of
// browsing history — so it stays in storage.local and is never sent through
// Chrome Sync / the user's Google account.
chrome.runtime.onInstalled.addListener(async () => {
  const { globalEnabled } = await chrome.storage.sync.get(["globalEnabled"]);
  if (globalEnabled === undefined) {
    await chrome.storage.sync.set({ globalEnabled: true });
  }

  // One-time migration: earlier versions kept siteOverrides in storage.sync.
  // Move any such data to storage.local (merging over defaults) and clear it
  // from sync, so upgrading doesn't silently drop a user's per-site choices.
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
