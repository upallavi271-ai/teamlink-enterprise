// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > FREE PHOTOS (2026-11-24): OPENVERSE (WordPress / Creative Commons, open source) as the SECOND free source of photos, as the services document suggests
// ("keep Pixabay as the primary image API and add Openverse as a second option"). Pixabay is untouched. This only searches: it returns each photo with its licence, its creator and a ready credit line.
//   * only photos whose licence allows COMMERCIAL use are asked for (license_type=commercial); "mature" content is excluded;
//   * every result carries its licence (for example CC BY 4.0), the creator, the page it came from and the credit text: CHECK the licence of the individual photo before using it, and give the credit;
//   * no key is needed (Openverse allows anonymous use at lower limits); a busy answer is shown in words; answers are kept for 10 minutes so the same search does not ask again.
// Nothing is downloaded, posted or stored here.
// ---------------------------------------------------------------------------
const BASE = 'https://api.openverse.org/v1/images/';
const cache = new Map();
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const https = (u) => (/^https:\/\/[^\s]+$/i.test(String(u || '')) ? String(u) : '');

function normalise(r) {
  const lic = String(r.license || '').toLowerCase(); const ver = r.license_version ? ` ${r.license_version}` : '';
  const licLabel = lic === 'cc0' ? 'CC0 (public domain)' : lic === 'pdm' ? 'Public Domain Mark' : lic ? `CC ${lic.toUpperCase()}${ver}` : 'Licence not stated';
  const creator = clean(r.creator, 80) || 'Unknown creator'; const title = clean(r.title, 100) || 'Untitled';
  return { id: String(r.id || ''), title, creator, license: licLabel, licenseUrl: https(r.license_url), thumb: https(r.thumbnail) || https(r.url), url: https(r.url), page: https(r.foreign_landing_url), source: clean(r.source || r.provider, 40), width: Number(r.width) || null, height: Number(r.height) || null,
    credit: clean(r.attribution, 400) || `"${title}" by ${creator}, ${licLabel}${r.license_url ? `: ${r.license_url}` : ''}`, needsCredit: !['cc0', 'pdm'].includes(lic) };
}
// q: what to look for; opts: { page, shape: 'tall'|'wide'|'square' }; fetchFn lets a test answer instead of the internet
async function search(q, opts = {}, fetchFn = fetch) {
  const query = clean(q, 100); if (query.length < 2) return { error: 'Write what you want to see (two letters or more).', status: 400 };
  const page = Math.min(10, Math.max(1, Math.round(Number(opts.page)) || 1)); const shape = ['tall', 'wide', 'square'].includes(opts.shape) ? opts.shape : '';
  const params = new URLSearchParams({ q: query, license_type: 'commercial', page_size: '18', page: String(page), mature: 'false' }); if (shape) params.set('aspect_ratio', shape);
  const key = params.toString(); const hit = cache.get(key); if (hit && Date.now() - hit.at < 600000) return hit.data;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 10000); let res;
  try { res = await fetchFn(`${BASE}?${key}`, { headers: { accept: 'application/json', 'user-agent': 'TeamLinkMarketing/1.0 (free photo search for our clients)' }, signal: ctl.signal }); }
  catch (e) { return { error: e.name === 'AbortError' ? 'Openverse did not answer in time. Try again.' : 'Openverse could not be reached right now.', status: 502 }; } finally { clearTimeout(timer); }
  if (res.status === 429) return { error: 'Openverse is busy (its free limit was reached). Try again in a minute.', status: 429 };
  if (res.status >= 400) return { error: `Openverse answered with an error (${res.status}).`, status: 502 };
  let j; try { j = await res.json(); } catch { return { error: 'Openverse sent an answer that could not be read.', status: 502 }; }
  const items = (Array.isArray(j.results) ? j.results : []).map(normalise).filter((x) => x.id && x.thumb);
  const data = { query, page, total: Number(j.result_count) || items.length, pages: Number(j.page_count) || 1, items, note: 'Free to use commercially under each photo\'s own licence. Check the licence of the photo you pick, and give the credit where the licence asks for it. Pixabay stays the first source.' };
  if (cache.size > 200) cache.clear(); cache.set(key, { at: Date.now(), data }); return data;
}
module.exports = { search, normalise };
