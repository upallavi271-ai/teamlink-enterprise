const $ = (id) => document.getElementById(id);
chrome.storage.sync.get(['base', 'key']).then((s) => { $('base').value = s.base || ''; $('key').value = s.key || ''; });
$('save').addEventListener('click', async () => {
  const base = $('base').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) { $('msg').textContent = 'Write the full address (https://...).'; return; }
  // the extension may only reach the one TeamLink address the person typed (asked once)
  const granted = await chrome.permissions.request({ origins: [`${new URL(base).origin}/*`] }).catch(() => false);
  if (!granted) { $('msg').textContent = 'Allow the extension to reach your TeamLink address.'; return; }
  await chrome.storage.sync.set({ base, key: $('key').value.trim() });
  $('msg').textContent = 'Saved.';
});
