// TeamLink extension: talks to TeamLink from the service worker. The TeamLink address and the person's OWN key are kept in
// chrome.storage.sync. The key is made in TeamLink (a candidate > Outreach tools > Browser extension) and removed there.
async function settings() {
  const s = await chrome.storage.sync.get(['base', 'key']);
  return { base: String(s.base || '').replace(/\/+$/, ''), key: s.key || '' };
}
async function api(method, path, body) {
  const { base, key } = await settings();
  if (!base || !key) return { status: 0, body: { error: 'Open the extension settings and add your TeamLink address and key.' } };
  const r = await fetch(`${base}/api/public/mkt/ext${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-TeamLink-Key': key }, body: body ? JSON.stringify(body) : undefined });
  let j = {};
  try { j = await r.json(); } catch (e) { j = {}; }
  return { status: r.status, body: j };
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === 'teamlink-me') reply(await api('GET', '/me'));
    else if (msg.type === 'teamlink-check') reply(await api('GET', `/check?url=${encodeURIComponent(msg.url)}`));
    else if (msg.type === 'teamlink-add') reply(await api('POST', '/profile', msg.profile));
    else reply({ status: 400, body: { error: 'unknown request' } });
  })().catch((e) => reply({ status: 0, body: { error: e.message } }));
  return true;
});
