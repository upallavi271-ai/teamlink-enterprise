import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

// The places a job's "Preferred location" is picked from (GET /requirements/locations, 2026-10-13):
// the company's offices, places added by the client manager (BDE) team, common Indian cities and places used on earlier jobs.
// "Remote" and "Any location" are one-click choices, not places.
export const ANY_LOCATION = 'Any location';
export const REMOTE = 'Remote';

export const prefToList = (v) => {
  const t = String(v || '').trim();
  if (!t || /^any$/i.test(t) || /^any location$/i.test(t)) return t ? [ANY_LOCATION] : [];
  return t.split(',').map((s) => s.trim()).filter(Boolean);
};
// What is stored on the job: "Hyderabad, Pune" / "Remote" / "Any" (the old word for no choice, kept so matching keeps working).
export const listToPref = (list) => {
  const l = (list || []).filter(Boolean);
  if (!l.length || (l.length === 1 && l[0] === ANY_LOCATION)) return 'Any';
  return l.join(', ');
};

// Same place, other spelling (2026-10-14): "Bangalore" = Bengaluru, "Hyderabad, Telangana" and "Head office - Hyderabad" are Hyderabad.
const PLACE_ALIAS = {
  bangalore: 'bengaluru', bombay: 'mumbai', madras: 'chennai', calcutta: 'kolkata', vizag: 'visakhapatnam', vishakapatnam: 'visakhapatnam',
  gurgaon: 'gurugram', trivandrum: 'thiruvananthapuram', cochin: 'kochi', mysore: 'mysuru', mangalore: 'mangaluru', tirupathi: 'tirupati',
  ahemadabad: 'ahmedabad', belgaum: 'belagavi', hubli: 'hubballi', trichy: 'tiruchirappalli', delhi: 'delhi ncr', ncr: 'delhi ncr', hyd: 'hyderabad',
};
const placeKey = (s) => { const k = String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/s+/g, ' ').trim(); return PLACE_ALIAS[k] || k; };
// true when the text is a place the shared list already has (any spelling), or names one as a whole word.
export function placeInList(options, text) {
  const known = new Set((options || []).map((o) => placeKey(o.value)));
  if (!known.size) return true; // the list has not loaded: never call a place "custom" without knowing
  const k = placeKey(text);
  if (!k) return true;
  if (known.has(k)) return true;
  const words = String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/s+/).filter(Boolean);
  return [...known].some((p) => p.length >= 4 && (' ' + words.join(' ') + ' ').includes(' ' + p + ' ')) || words.some((w) => known.has(PLACE_ALIAS[w] || w) && w.length >= 4);
}

export function useJobLocations() {
  const [data, setData] = useState(null);
  useEffect(() => {
    let on = true;
    api.get('/requirements/locations').then((r) => { if (on) setData(r.data); }).catch(() => { if (on) setData({ locations: [], special: [REMOTE, ANY_LOCATION], canAdd: false }); });
    return () => { on = false; };
  }, []);
  const add = useCallback(async (name) => {
    const r = await api.post('/requirements/locations', { name });
    const n = r.data.name;
    setData((d) => ({ ...(d || {}), locations: [{ name: n, source: 'managed' }, ...(((d && d.locations) || []).filter((x) => x.name.toLowerCase() !== n.toLowerCase()))] }));
    return n;
  }, []);
  return {
    loading: data === null,
    options: ((data && data.locations) || []).map((l) => ({ value: l.name, label: l.name, group: { office: 'Our offices', managed: 'Added by the team', city: 'Cities', used: 'Used on earlier requirements' }[l.source] || '' })),
    special: ((data && data.special) || [REMOTE, ANY_LOCATION]).map((s) => ({ value: s, label: s })),
    canAdd: !!(data && data.canAdd),
    add,
  };
}
