import { useEffect, useState } from 'react';
import api from '../api';
import Combo from './Combo.jsx';

// ---------------------------------------------------------------------------
// ONE PERSON FILTER FOR EVERY ATS SCREEN — Recruiter, TL, BDE, and the
// Position (seat) filter beside them.
//
// The list is GET /api/ats/workers (backend/src/utils/workers.js): everyone
// who worked the records this login can see, CURRENT AND FORMER, each with the
// seat they held and when they left:
//
//   Moturi Ragini · MED-4                    a login, by the seat they sit in
//   Gundala chandra Keerthana · MED-TL       worked as a recruiter, here now
//   Bathineni Yamuna · MED-3 · left Jun 2026 left; her work is attributed by name
//
// Current people first, then former. It narrows to the chosen department.
//
// VALUES: "id:<userId>" for a person who can sign in today in that role,
// "name:<name>" for anyone else — exactly what Requirements always sent, and
// every ATS endpoint accepts both (?recruiter= ?tl= ?bde=). The backend
// decides whose work a record is (the same rule ATS Reports counts with), so
// the screen never re-derives it.
//
// Scope is the server's: a TL is offered their own team's people, a recruiter
// only themselves — and then no person filter is drawn at all.
// ---------------------------------------------------------------------------

const EMPTY = { recruiters: [], tls: [], bdes: [], positions: [], viewer: null };
const LIST_OF = { RECRUITER: 'recruiters', TL: 'tls', BDE: 'bdes' };
const ALL_LABEL = { RECRUITER: 'All recruiters', TL: 'All TLs', BDE: 'All BDEs' };

// One request per page (and per login), however many filters it draws.
let cache = null;
export function loadAtsWorkers({ force = false } = {}) {
  let token = '';
  try { token = localStorage.getItem('tl_token') || ''; } catch { token = ''; }
  if (!cache || force || cache.token !== token || Date.now() - cache.at > 60000) {
    const promise = api.get('/ats/workers').then((res) => ({ ...EMPTY, ...res.data }));
    cache = { token, at: Date.now(), promise };
    promise.catch(() => { if (cache && cache.promise === promise) cache = null; });
  }
  return cache.promise;
}

export function useAtsWorkers() {
  const [data, setData] = useState(EMPTY);
  useEffect(() => {
    let live = true;
    loadAtsWorkers().then((d) => { if (live) setData(d); }).catch(() => { if (live) setData(EMPTY); });
    return () => { live = false; };
  }, []);
  return data;
}

// "Jun 2026"
export const leftOn = (iso) => (iso
  ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
  : '');

// The option label. A login: "Name · SEAT" (the seat they sit in today). Anyone
// else: "Name · SEAT", or "Name · SEAT · left Mon YYYY" once they have gone.
export function workerLabel(w) {
  if (!w) return '';
  if (w.login) return w.currentSeat ? `${w.name} · ${w.currentSeat}` : w.name;
  return [w.name, w.seat, w.current ? '' : `left${w.to ? ` ${leftOn(w.to)}` : ''}`].filter(Boolean).join(' · ');
}

export const inDepartment = (w, department) => !department
  || w.department === department || (w.departments || []).includes(department);

// [{ value, label, person }] — current first, then former.
export function personOptions(data, role, department = '') {
  const list = ((data || EMPTY)[LIST_OF[role]] || []).filter((w) => inDepartment(w, department));
  return [...list.filter((w) => w.current), ...list.filter((w) => !w.current)]
    .map((w) => ({ value: w.value, label: workerLabel(w), person: w }));
}

// Split a value into what the Requirements endpoint has always taken.
export function splitPersonValue(value) {
  const v = String(value || '');
  if (v.startsWith('id:')) return { id: v.slice(3), name: '' };
  if (v.startsWith('name:')) return { id: '', name: v.slice(5) };
  return { id: '', name: '' };
}

// Does this person (a row with a userId and/or a name) match a filter value?
export function personMatches(value, { userId, name } = {}) {
  if (!value) return true;
  const { id, name: n } = splitPersonValue(value);
  if (id) return userId === id;
  return !!n && String(name || '').trim().toLowerCase() === n.trim().toLowerCase();
}

export default function PeopleFilter({
  role = 'RECRUITER', department = '', value = '', onChange, placeholder, title, workers, style,
}) {
  const fetched = useAtsWorkers();
  const data = workers || fetched;
  // A recruiter's own work is all they see — a person filter would offer
  // only themselves, so none is drawn.
  if (data.viewer && data.viewer.personFilters === false) return null;
  const options = personOptions(data, role, department);
  // A chosen person stays visible even when a department narrowing hides them.
  if (value && !options.some((o) => o.value === value)) {
    const all = personOptions(data, role, '');
    const keep = all.find((o) => o.value === value);
    options.unshift(keep || { value, label: splitPersonValue(value).name || value, person: null });
  }
  return (
    <Combo
      value={value || ''}
      title={title || ALL_LABEL[role]}
      style={style}
      onChange={(e) => {
        const v = e.target.value;
        const hit = options.find((o) => o.value === v);
        if (onChange) onChange(v, hit ? hit.person : null);
      }}
    >
      <option value="">{placeholder || ALL_LABEL[role]}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Combo>
  );
}

// THE POSITION (SEAT) FILTER — "MED-3 · 4 people": the seat, and how many
// people have held it. The value is the seat code (?positionCode=), and the
// work it matches is the work done FROM that seat, whoever sat in it.
export function positionOptions(data, department = '') {
  return ((data || EMPTY).positions || [])
    .filter((p) => !department || p.department === department)
    .map((p) => ({
      value: p.code,
      label: `${p.code} · ${p.people} ${p.people === 1 ? 'person' : 'people'}`,
      title: p.holderName ? `Now: ${p.holderName}` : 'Vacant',
      position: p,
    }));
}

export function PositionFilter({
  department = '', value = '', onChange, placeholder = 'All positions', workers, style,
}) {
  const fetched = useAtsWorkers();
  const data = workers || fetched;
  if (data.viewer && data.viewer.personFilters === false) return null;
  const options = positionOptions(data, department);
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: value });
  return (
    <Combo
      value={value || ''}
      title="Position (seat)"
      style={style}
      onChange={(e) => {
        const v = e.target.value;
        const hit = options.find((o) => o.value === v);
        if (onChange) onChange(v, hit ? hit.position : null);
      }}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Combo>
  );
}
