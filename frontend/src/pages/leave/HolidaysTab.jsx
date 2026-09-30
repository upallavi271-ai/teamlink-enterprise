import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead, EmptyMini, Modal } from '../../components/proto.jsx';
import Combo from '../../components/Combo.jsx';
import './LeaveExtras.css';

// ---------------------------------------------------------------------------
// COMPANY HOLIDAY CALENDAR — list (sorted by date, year filter, export) and
// the Add / Edit Holiday form.
//
// WHAT IS STORED. The Holiday table has name, date and type only, so the form
// stores exactly those (routes/leave.js):
//   * Multi-day   → one row per day (From – To, at most 31 days)
//   * Repeat every year → next year's row is created on save (no yearly job)
//   * Optional holiday  → type "Optional"
//   * Day               → worked out from the date, never stored
// Location / branch, "applicable to" and a description have NO column: every
// employee is Hyderabad branch and a holiday applies to everyone, and the form
// says so instead of pretending to save them.
// ---------------------------------------------------------------------------
const TYPES = ['National Holiday', 'Festival', 'Optional', 'Company', 'Restricted'];
const todayIso = () => new Date().toISOString().slice(0, 10);
const dayOf = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long' }) : '');
const fmt = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const EMPTY = { id: null, name: '', date: '', multi: false, toDate: '', type: 'Festival', optional: false, repeatYearly: false };

function HolidayForm({ initial, existing, onClose, onSaved }) {
  const [f, setF] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const editing = !!f.id;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const days = f.multi && f.date && f.toDate && f.toDate >= f.date ? Math.round((new Date(f.toDate) - new Date(f.date)) / 86400000) + 1 : 1;
  const past = f.date && f.date < todayIso();
  const dup = f.date && f.name.trim() && existing.some((h) => h.id !== f.id && h.date === f.date && h.name.trim().toLowerCase() === f.name.trim().toLowerCase());

  async function save() {
    setError('');
    if (!f.name.trim()) { setError('Holiday name is required.'); return; }
    if (!f.date) { setError('Date is required.'); return; }
    if (f.multi && (!f.toDate || f.toDate < f.date)) { setError('The To date must be on or after the From date.'); return; }
    if (f.multi && days > 31) { setError('A multi-day holiday can cover at most 31 days.'); return; }
    if (dup) { setError(`"${f.name.trim()}" is already on the calendar for ${fmt(f.date)}.`); return; }
    setBusy(true);
    try {
      if (editing) {
        await api.put(`/leave/holidays/${f.id}`, { name: f.name.trim(), date: f.date, type: f.type, optional: f.optional });
      } else {
        await api.post('/leave/holidays', {
          name: f.name.trim(), date: f.date, toDate: f.multi ? f.toDate : undefined, type: f.type, optional: f.optional, repeatYearly: f.repeatYearly,
        });
      }
      onSaved(editing ? `${f.name.trim()} updated.` : `${f.name.trim()} added${days > 1 ? ` (${days} days)` : ''}${f.repeatYearly ? ' — and next year’s entry' : ''}.`);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save the holiday.');
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title={editing ? 'Edit Holiday' : 'Add Holiday'}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>{editing ? 'Save changes' : 'Add holiday'}</button></>}
    >
      <div className="field"><label>Holiday name <span style={{ color: 'var(--red)' }}>*</span></label>
        <input value={f.name} maxLength={120} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Sankranti" /></div>
      {!editing && (
        <div className="lvx-halfday">
          <label><input type="radio" name="hmulti" checked={!f.multi} onChange={() => set('multi', false)} /> Single day</label>
          <label><input type="radio" name="hmulti" checked={f.multi} onChange={() => set('multi', true)} /> Multi-day</label>
        </div>
      )}
      <div className="grid-2">
        <div className="field"><label>{f.multi ? 'From date' : 'Date'} <span style={{ color: 'var(--red)' }}>*</span></label>
          <input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></div>
        {f.multi
          ? <div className="field"><label>To date <span style={{ color: 'var(--red)' }}>*</span></label><input type="date" value={f.toDate} min={f.date || undefined} onChange={(e) => set('toDate', e.target.value)} /></div>
          : <div className="field"><label>Day</label><input value={dayOf(f.date)} readOnly disabled /></div>}
      </div>
      {f.multi && f.date && f.toDate && f.toDate >= f.date && (
        <div className="lvx-muted" style={{ marginBottom: 8 }}>{days} day{days === 1 ? '' : 's'}: {dayOf(f.date)} {fmt(f.date)} → {dayOf(f.toDate)} {fmt(f.toDate)} — one calendar entry per day.</div>
      )}
      <div className="grid-2">
        <div className="field"><label>Type</label>
          <Combo value={f.optional ? 'Optional' : f.type} disabled={f.optional} onChange={(e) => set('type', e.target.value)}>
            {TYPES.map((t) => <option key={t}>{t}</option>)}
          </Combo></div>
        <div className="field"><label>Optional holiday</label>
          <label className="lvx-muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={f.optional} onChange={(e) => set('optional', e.target.checked)} />
            Employees may choose to take it (saved as type “Optional”)
          </label></div>
      </div>
      <div className="grid-2">
        <div className="field"><label>Location / Branch</label><input value="Hyderabad" readOnly disabled title="Every employee is Hyderabad branch" /></div>
        <div className="field"><label>Applicable to</label><input value="All employees" readOnly disabled title="A holiday applies to every employee" /></div>
      </div>
      {!editing && (
        <label className="lvx-muted" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0 8px' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={f.repeatYearly} onChange={(e) => set('repeatYearly', e.target.checked)} />
          Repeat every year — also adds the same date next year when you save
        </label>
      )}
      <div className="lvx-note">
        Location, “applicable to” and a description cannot be saved — the holiday calendar has no such fields. Every employee is
        Hyderabad branch and a holiday applies to all of them.
      </div>
      {past && <div className="lvx-note">Heads-up: {fmt(f.date)} is in the past.</div>}
      {dup && <div className="error-text">This name is already on the calendar for that date.</div>}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

export default function HolidaysTab({ canManage, canEdit, canExport }) {
  const [holidays, setHolidays] = useState([]);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [hf, setHf] = useState({ q: '', type: '', when: '' });
  const [form, setForm] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  function load() { api.get('/leave/holidays').then((res) => setHolidays(res.data)).catch(() => setError('Could not load the holiday calendar.')); }
  useEffect(load, []);

  const years = useMemo(() => [...new Set([String(new Date().getFullYear()), ...holidays.map((h) => String(h.date).slice(0, 4))])].sort().reverse(), [holidays]);
  const types = useMemo(() => [...new Set([...TYPES, ...holidays.map((h) => h.type).filter(Boolean)])], [holidays]);
  const shown = [...holidays].sort((a, b) => a.date.localeCompare(b.date)).filter((h) => {
    if (year && !String(h.date).startsWith(year)) return false;
    if (hf.q && !String(h.name || '').toLowerCase().includes(hf.q.trim().toLowerCase())) return false;
    if (hf.type && h.type !== hf.type) return false;
    if (hf.when === 'upcoming' && h.date < todayIso()) return false;
    if (hf.when === 'past' && h.date >= todayIso()) return false;
    return true;
  });

  async function remove(h) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${h.name} (${fmt(h.date)})?`)) return;
    setError('');
    try { await api.delete(`/leave/holidays/${h.id}`); setNotice(`${h.name} deleted.`); load(); } catch (e) { setError(e.response?.data?.error || 'Could not delete.'); }
  }
  async function exportXlsx() {
    setError('');
    try {
      const res = await api.get('/leave/holidays', { params: { year: year || undefined, format: 'xlsx' }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url; a.download = `holidays-${year || 'all'}.xlsx`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { setError('Export is not included in your role’s permissions.'); }
  }
  const setH = (k, v) => setHf((x) => ({ ...x, [k]: v }));

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Company Holiday Calendar">
        <span style={{ display: 'flex', gap: 8 }}>
          {canExport && <button className="btn btn-sm" onClick={exportXlsx}>Export Excel</button>}
          {canManage && <button className="btn btn-sm btn-primary" onClick={() => { setNotice(''); setForm({ ...EMPTY }); }}>+ Add Holiday</button>}
        </span>
      </PanelHead>
      <div className="filter-row" style={{ margin: '12px 18px' }}>
        <Combo value={year} onChange={(e) => setYear(e.target.value)} style={{ minWidth: 110 }}>
          <option value="">All years</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </Combo>
        <input placeholder="Holiday name" value={hf.q} onChange={(e) => setH('q', e.target.value)} />
        <Combo value={hf.type} onChange={(e) => setH('type', e.target.value)}>
          <option value="">All types</option>
          {types.map((t) => <option key={t}>{t}</option>)}
        </Combo>
        <Combo value={hf.when} onChange={(e) => setH('when', e.target.value)}>
          <option value="">Upcoming and past</option>
          <option value="upcoming">Upcoming</option>
          <option value="past">Past</option>
        </Combo>
        <span className="small-muted" style={{ alignSelf: 'center' }}>{shown.length} of {holidays.length}</span>
      </div>
      {notice && <div className="notice" style={{ margin: '0 18px 8px' }}>{notice}</div>}
      {error && <div className="error-text" style={{ margin: '0 18px 8px' }}>{error}</div>}
      {shown.length === 0 ? <EmptyMini>{holidays.length ? 'No holidays match these filters.' : 'No holidays added yet — add the company holiday calendar for the year.'}</EmptyMini> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Date</th><th>Day</th><th>Holiday</th><th>Type</th><th>Actions</th></tr></thead>
            <tbody>
              {shown.map((h) => (
                <tr key={h.id}>
                  <td className="cell-muted" style={{ whiteSpace: 'nowrap' }}>
                    {fmt(h.date)}{' '}
                    {h.date === todayIso() && <span className="status active">Today</span>}
                    {h.date < todayIso() && <span className="status pending">Past</span>}
                  </td>
                  <td className="cell-muted">{h.day || dayOf(h.date)}</td>
                  <td>{h.name}</td>
                  <td className="cell-muted">{h.type || '—'}</td>
                  <td>
                    <span style={{ display: 'flex', gap: 6 }}>
                      {canEdit && <button className="btn btn-sm" onClick={() => { setNotice(''); setForm({ ...EMPTY, id: h.id, name: h.name, date: h.date, type: TYPES.includes(h.type) ? h.type : 'Festival', optional: h.type === 'Optional' }); }}>Edit</button>}
                      {canEdit && <button className="btn btn-sm btn-ghost" onClick={() => remove(h)}>Delete</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && (
        <HolidayForm
          initial={form}
          existing={holidays}
          onClose={() => setForm(null)}
          onSaved={(msg) => { setForm(null); setNotice(msg); load(); }}
        />
      )}
    </Panel>
  );
}
