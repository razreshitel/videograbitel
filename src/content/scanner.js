// Loader: content scripts cannot be ES modules, so import the real one.
(async () => {
  try {
    await import(chrome.runtime.getURL('src/content/scan-main.js'));
  } catch {
    /* page blocked the import */
  }
})();
