const $ = (id) => document.getElementById(id);
const send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, res));
let profile = null;

(async () => {
  const me = await send({ type: 'teamlink-me' });
  $('who').textContent = me.status === 200 ? `Signed in as ${me.body.name}` : (me.body.error || 'The key does not work.');
  if (me.status === 200 && !me.body.mayAdd) $('who').textContent += ' (your role cannot add candidates)';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.linkedin\.com\/in\//.test(tab.url || '')) return;
  profile = await new Promise((res) => chrome.tabs.sendMessage(tab.id, { type: 'teamlink-read-profile' }, res));
  if (!profile || !profile.name) { $('profile').textContent = 'Could not read this page. Scroll it once and open the extension again.'; return; }
  $('profile').textContent = '';
  const b = document.createElement('b'); b.textContent = profile.name; $('profile').appendChild(b);
  const d = document.createElement('div'); d.textContent = [profile.headline, profile.location].filter(Boolean).join(' - '); $('profile').appendChild(d);
  const known = await send({ type: 'teamlink-check', url: profile.profileUrl });
  if (known.status === 200 && known.body.known) {
    const a = document.createElement('a');
    a.textContent = known.body.inScope ? `Already in TeamLink: ${known.body.candidate.name}` : 'Already in TeamLink (another team)';
    if (known.body.candidate) { a.href = known.body.candidate.url; a.target = '_blank'; }
    $('msg').appendChild(a);
  }
  $('add').disabled = !(me.status === 200 && me.body.mayAdd);
})();

$('add').addEventListener('click', async () => {
  $('add').disabled = true;
  const r = await send({ type: 'teamlink-add', profile: { ...profile, email: $('email').value, phone: $('phone').value } });
  $('msg').className = r.status === 200 || r.status === 201 ? 'ok' : 'err';
  $('msg').textContent = r.status === 201 ? 'Added to TeamLink.' : (r.status === 200 ? 'Already in TeamLink.' : (r.body.error || 'Not added.'));
  if (r.body && r.body.url) { const a = document.createElement('a'); a.href = r.body.url; a.target = '_blank'; a.textContent = ' Open'; $('msg').appendChild(a); }
});
