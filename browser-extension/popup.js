const $ = (id) => document.getElementById(id);
const send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, res));
const FIELDS = ['name', 'email', 'phone', 'headline', 'currentCompany', 'location', 'experienceYears', 'noticePeriod', 'currentSalary', 'expectedSalary', 'education'];
const SITES = { linkedin: 'LinkedIn', naukri: 'Naukri', shine: 'Shine', foundit: 'foundit' };
const BOARD = /^https:\/\/([a-z0-9-]+\.)*(linkedin\.com|naukri\.com|shine\.com|foundit\.in|monsterindia\.com)\//i;
let profile = null;

function link(text, href) { const a = document.createElement('a'); a.textContent = text; if (href) { a.href = href; a.target = '_blank'; } return a; }
async function checkKnown() {
  const known = await send({ type: 'teamlink-check', url: profile.profileUrl, email: $('f-email').value, phone: $('f-phone').value });
  $('known').textContent = '';
  if (known && known.status === 200 && known.body.known) {
    $('known').className = 'warn';
    $('known').appendChild(known.body.inScope
      ? link(`Already in TeamLink: ${known.body.candidate.name}`, known.body.candidate.url)
      : document.createTextNode('Already in TeamLink (another team). Adding links this page to the same person - no duplicate is made.'));
  }
}

(async () => {
  const me = await send({ type: 'teamlink-me' });
  $('who').textContent = me.status === 200 ? `Signed in as ${me.body.name}` : (me.body.error || 'The key does not work.');
  if (me.status === 200 && !me.body.mayAdd) $('who').textContent += ' (your role cannot add candidates)';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !BOARD.test(tab.url || '')) return;
  profile = await new Promise((res) => chrome.tabs.sendMessage(tab.id, { type: 'teamlink-read-profile' }, (r) => res(chrome.runtime.lastError ? null : r)));
  if (!profile) { $('profile').textContent = 'Could not read this page. Reload it, scroll it once and open the extension again.'; return; }
  $('profile').textContent = '';
  const s = document.createElement('span'); s.className = 'site'; s.textContent = SITES[profile.site] || profile.site; $('profile').appendChild(s);
  $('profile').appendChild(document.createTextNode(profile.name ? ` ${profile.name}` : ' Name not found on the page - type it below.'));
  FIELDS.forEach((f) => { $(`f-${f}`).value = profile[f] == null ? '' : profile[f]; });
  $('f-skills').value = (profile.skills || []).join(', ');
  $('form').style.display = '';
  $('add').disabled = !(me.status === 200 && me.body.mayAdd);
  checkKnown();
  $('f-email').addEventListener('change', checkKnown);
  $('f-phone').addEventListener('change', checkKnown);
  if (me.status === 200 && me.body.mayAdd) {
    const reqs = await send({ type: 'teamlink-reqs' });
    ((reqs && reqs.body && reqs.body.rows) || []).forEach((r) => { const o = document.createElement('option'); o.value = r.id; o.textContent = r.label; $('f-req').appendChild(o); });
  }
})();

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$('f-name').value.trim()) { $('msg').className = 'err'; $('msg').textContent = 'Write the name first.'; return; }
  $('add').disabled = true;
  const body = { site: profile.site, profileUrl: profile.profileUrl };
  FIELDS.forEach((f) => { body[f] = $(`f-${f}`).value.trim(); });
  body.experienceYears = body.experienceYears === '' ? null : Number(body.experienceYears);
  body.skills = $('f-skills').value.split(',').map((x) => x.trim()).filter(Boolean);
  if ($('f-req').value) body.requirementId = $('f-req').value;
  const r = await send({ type: 'teamlink-add', profile: body });
  const ok = r.status === 200 || r.status === 201;
  $('msg').textContent = '';
  $('msg').className = ok ? 'ok' : 'err';
  $('msg').appendChild(document.createTextNode(r.status === 201 ? 'Added to TeamLink.' : (r.status === 200 ? 'Already in TeamLink - this page is linked to that candidate.' : (r.body.error || 'Not added.'))));
  if (r.body && r.body.attached) {
    const d = document.createElement('div');
    d.className = r.body.attached.error ? 'warn' : 'ok';
    d.textContent = r.body.attached.error ? r.body.attached.error : `Put on ${r.body.attached.requirement}.`;
    $('msg').appendChild(d);
  }
  if (r.body && r.body.url) { $('msg').appendChild(document.createTextNode(' ')); $('msg').appendChild(link('Open in TeamLink', r.body.url)); }
  if (!ok) $('add').disabled = false;
});
