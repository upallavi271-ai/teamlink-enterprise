// ---------------------------------------------------------------------------
// FILTER RULES -> SQL (one place, used by the contacts list, the segments and the target resolver). Every query uses the alias `c`
// for OutreachContact. Values are always bound parameters, never pasted into the SQL.
//   rules: { industries:[], cities:[], importIds:[], reachable:['email'|'whatsapp'|'sms'], skip:['opted_out'], text:'',
//            languages:[], preferred:['whatsapp'|'email'|'sms'|'call'], fields:[{ key, values:[] }] }
//   reachable  the person can be messaged on at least one of these channels now (opted in, address ok)
//   languages / preferred  the person's language / preferred channel is one of these
//   fields     custom field values (CRM Fields): the person's value for that field is one of `values` (for a multi-choice field: any of them)
// ---------------------------------------------------------------------------
const CHANNELS = ['email', 'whatsapp', 'sms'];
const PREFERRED = ['whatsapp', 'email', 'sms', 'call'];
const list = (v) => (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v])).map((x) => String(x).trim()).filter(Boolean).slice(0, 60);

// [{ key, values }] (or { key: values }) -> at most 10 clean rows
function cleanFieldRules(v) {
  const rows = Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.entries(v).map(([key, values]) => ({ key, values })) : []);
  const out = []; const seen = new Set();
  for (const r of rows.slice(0, 20)) {
    const key = String(r && r.key || '').trim();
    if (!/^[a-z0-9_]{1,40}$/.test(key) || seen.has(key)) continue; // eslint-disable-line no-continue
    const values = list(r.values).map((x) => x.slice(0, 80)).slice(0, 30);
    if (!values.length) continue; // eslint-disable-line no-continue
    seen.add(key); out.push({ key, values });
  }
  return out.slice(0, 10);
}

function cleanRules(r) {
  const x = r && typeof r === 'object' ? r : {};
  return {
    industries: list(x.industries), cities: list(x.cities), importIds: list(x.importIds),
    reachable: list(x.reachable).filter((c) => CHANNELS.includes(c)),
    text: String(x.text || '').trim().slice(0, 80),
    languages: list(x.languages).map((l) => l.slice(0, 40)), preferred: list(x.preferred).map((c) => c.toLowerCase()).filter((c) => PREFERRED.includes(c)),
    fields: cleanFieldRules(x.fields),
  };
}
const ph = (n) => new Array(n).fill('?').join(',');

// returns { conds: [sql...], params: [...] }; the caller adds the contact type / status / scope
function ruleConds(rules) {
  const r = cleanRules(rules);
  const conds = []; const params = [];
  if (r.industries.length) { conds.push(`EXISTS (SELECT 1 FROM "OutreachContactTag" t WHERE t.contactId = c.id AND t.industry IN (${ph(r.industries.length)}))`); params.push(...r.industries); }
  if (r.cities.length) { conds.push(`LOWER(c.city) IN (${ph(r.cities.length)})`); params.push(...r.cities.map((x) => x.toLowerCase())); }
  if (r.importIds.length) { conds.push(`c.importId IN (${ph(r.importIds.length)})`); params.push(...r.importIds); }
  if (r.reachable.length) { conds.push(`EXISTS (SELECT 1 FROM "OutreachContactChannel" h WHERE h.contactId = c.id AND h.optIn = 'opted_in' AND h.health = 'ok' AND h.channel IN (${ph(r.reachable.length)}))`); params.push(...r.reachable); }
  if (r.languages.length) { conds.push(`LOWER(c.language) IN (${ph(r.languages.length)})`); params.push(...r.languages.map((x) => x.toLowerCase())); }
  if (r.preferred.length) { conds.push(`LOWER(c.preferredChannel) IN (${ph(r.preferred.length)})`); params.push(...r.preferred); }
  // custom values: json_each(customValues, '$.key') yields the one value of a plain field or every item of a multi-choice field
  r.fields.forEach((f) => {
    conds.push(`EXISTS (SELECT 1 FROM json_each(c.customValues, ?) j WHERE LOWER(CAST(j.value AS TEXT)) IN (${ph(f.values.length)}))`);
    params.push(`$.${f.key}`, ...f.values.map((v) => v.toLowerCase()));
  });
  return { conds, params, rules: r };
}

// THE SAFE DEFAULT (quick wins, T5): a group with no rule at all means NOBODY, never everybody. "Has a rule" = at least one of the
// filters that really narrow the list (the free-text box is not a filter of a group). Groups, counts, previews, the campaign list of
// people and a recruiter's view of a group all use segmentConds, so "who the preview counts" is "who gets it".
function isEmpty(rules) {
  const r = cleanRules(rules);
  return !(r.industries.length || r.cities.length || r.importIds.length || r.reachable.length || r.languages.length || r.preferred.length || r.fields.length);
}
function segmentConds(rules) {
  const rc = ruleConds(rules);
  if (isEmpty(rules)) return { conds: ['0 = 1'], params: [], rules: rc.rules, empty: true };
  return { ...rc, empty: false };
}

module.exports = { cleanRules, cleanFieldRules, ruleConds, segmentConds, isEmpty, CHANNELS, PREFERRED, ph, list };
