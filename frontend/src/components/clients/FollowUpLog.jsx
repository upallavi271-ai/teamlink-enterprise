import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import ExportMenu from '../ExportMenu.jsx';
import FollowUpLogImport from './FollowUpLogImport.jsx'; // Export / Import on the tab (founder 2026-11-04)
import Combo from '../Combo.jsx';
import './followUpLog.css';

// THE CLIENT'S FOLLOW-UP LOG (founder 2026-11-03: "comments option recruiters ki, tls ki, bde ki andhariki vundali. vallu ey
// roju followup chesaro teluskovadaniki"). One dated line per follow-up - who did it, on which day, what happened - the same
// log on the client page and on every requirement page of that client. Lines imported from the BDE desk's Excel sheet
// carry a "From the sheet" tag. The server (routes/clientFollowLog.js) decides who may read and who may write.
// ON A CLIENT (founder 2026-11-05): sub tabs as the BDE sheets have them (Client follow-up · Schedule · Interviews · Notes), each line names
// the requirement it is about, the writer edits it, the BDE TL edits and deletes any line, and the client's status is one dropdown.
const fmtDay = (ymd) => {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y) return ymd || '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const PAGE = 40; // days shown at a time

// candidateId (2026-11-03: "recruiters ki ithey, candidate follow up vundali"): the same log on the candidate profile, with the
// calls / mails logged from "Follow up" and the follow-up tasks marked done; applicationId tags a new line with that job.
export default function FollowUpLog({ clientId, requirementId, candidateId, applicationId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [onDate, setOnDate] = useState('');
  // CALL BACK ON (2026-11-04): picked here, or read from the words ("call on 7th november") - a pop-up on that day
  const [remindOn, setRemindOn] = useState('');
  const [subTab, setSubTab] = useState('client');
  const [lineReq, setLineReq] = useState('');
  const [reqFilter, setReqFilter] = useState('');
  const [editing, setEditing] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [who, setWho] = useState('');
  // FROM - TO (founder 2026-11-20): the list can be cut to some days
  const [fromD, setFromD] = useState('');
  const [toD, setToD] = useState('');
  const [q, setQ] = useState('');
  const [days, setDays] = useState(PAGE);
  const params = candidateId ? { candidateId } : requirementId ? { requirementId } : { clientId };

  function load() {
    api.get('/client-followlog', { params })
      .then((r) => { setData(r.data); setError(''); setOnDate((d) => d || r.data.today); })
      .catch((e) => { setData(null); setError(e.response?.data?.error || 'The follow-ups could not be loaded.'); });
  }
  useEffect(load, [clientId, requirementId, candidateId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (note.trim().length < 3) { setError('Write what happened in the follow-up.'); return; }
    setBusy(true); setError(''); setFlash('');
    try {
      const r = await api.post('/client-followlog', { ...params, ...(candidateId && applicationId ? { applicationId } : {}), onDate, note: note.trim(), ...(remindOn ? { remindOn } : {}), ...(clientId ? { tab: subTab, lineRequirementId: lineReq || undefined } : {}) });
      setNote(''); setRemindOn(''); setFlash(r.data?.message || 'Saved.'); load();
    } catch (e) { setError(e.response?.data?.error || 'That did not save. Please try again.'); } finally { setBusy(false); }
  }

  async function saveEdit() {
    if (editing.note.trim().length < 3) { setError('Write what happened in the follow-up.'); return; }
    setBusy(true); setError(''); setFlash('');
    try {
      await api.put(`/client-followlog/${editing.id}`, { clientId, note: editing.note.trim(), onDate: editing.onDate, tab: editing.tab, lineRequirementId: editing.requirementId || '' });
      setEditing(null); setFlash('Saved.'); load();
    } catch (e) { setError(e.response?.data?.error || 'That did not save. Please try again.'); } finally { setBusy(false); }
  }
  async function removeLine(e) {
    if (!window.confirm('Delete this follow-up?')) return;
    setError(''); setFlash('');
    try { await api.delete(`/client-followlog/${e.id}`, { params: { clientId } }); setFlash('Deleted.'); load(); } catch (err) { setError(err.response?.data?.error || 'That did not delete. Please try again.'); }
  }
  async function saveStatus(status) {
    setError(''); setFlash('');
    try { await api.put('/client-followlog/status', { clientId, status }); setData((d) => ({ ...d, workStatus: status || null })); } catch (e) { setError(e.response?.data?.error || 'That did not save. Please try again.'); }
  }

  // THE SEARCH (founder 2026-11-05: "yedhaina oka keyword or anything type chesethey ... ahh count kanipincheyla pettu"): every word typed must
  // be on the line. perTab = the matches in each sub tab, so a word that is under another sub tab is not "0"; people = different candidates found.
  // WHO (founder 2026-11-20): on a candidate the server says whose lines this login may read - a recruiter: Me; a TL: Everyone (team) and each
  // recruiter by name; a Manager / Admin: everyone who wrote (whoPeople is null then).
  const teamWho = !!(data && data.whoMode === 'team' && Array.isArray(data.whoPeople));
  const { groups, perTab, people } = useMemo(() => {
    if (!data) return { groups: [], perTab: {}, people: 0 };
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const said = (e) => {
      const text = `${e.note} ${e.topic || ''} ${e.byName || ''} ${e.candidate || ''} ${e.recruiter || ''} ${e.requirementLabel || ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    };
    const all = data.entries.filter((e) => (!reqFilter || e.requirementId === reqFilter)
      && (!who || (teamWho ? e.byId === who : e.byName === who) || (who === '__sheet' && e.source === 'sheet'))
      && (!fromD || (e.onDate && e.onDate >= fromD)) && (!toD || (e.onDate && e.onDate <= toD))
      && said(e));
    const counts = {};
    all.forEach((e) => { counts[e.tab] = (counts[e.tab] || 0) + 1; });
    const rows = all.filter((e) => !data.tabs || e.tab === subTab);
    const names = new Set(rows.map((e) => String(e.candidate || '').trim().toLowerCase()).filter(Boolean));
    const out = [];
    rows.forEach((e) => {
      const last = out[out.length - 1];
      if (last && last.day === e.onDate) last.rows.push(e); else out.push({ day: e.onDate, rows: [e] });
    });
    return { groups: out, perTab: counts, people: names.size };
  }, [data, who, q, subTab, reqFilter, fromD, toD]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="card section">{error ? <div className="error-text">{error}</div> : <div className="small-muted">Loading the follow-ups…</div>}</div>;
  const sheetRows = data.entries.filter((e) => e.source === 'sheet').length;
  const shownRows = groups.slice(0, days).reduce((n, g) => n + g.rows.length, 0);
  const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);
  const tabCount = data.tabs ? (data.tabs.find((t) => t.key === subTab) || {}).count || 0 : data.entries.length;
  const searching = q.trim() !== '';
  const elsewhere = searching && !totalRows && data.tabs ? data.tabs.find((t) => perTab[t.key]) : null;
  const pickTab = (key) => { setSubTab(key); setDays(PAGE); setEditing(null); };
  const reqPick = (value, onChange, label) => (
    <Combo value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">No particular requirement</option>
      {data.requirements.map((r) => <option key={r.id} value={r.id}>{`${r.label}${r.closed ? ' (closed)' : ''}`}</option>)}
    </Combo>
  );

  return (
    <div className="card section flog">
      <div className="flog-head">
        <div>
          <h3 style={{ margin: 0 }}>Follow-ups — {data.client.name}</h3>
          <div className="small-muted">
            {data.entries.length ? `${data.entries.length} follow-up${data.entries.length === 1 ? '' : 's'}; the last one on ${fmtDay(data.lastOn)}.` : 'No follow-up written yet.'}
            {' '}{candidateId ? 'Everyone who works this candidate, and their TL, sees the same list.' : `Everyone who works this client sees the same list${data.requirement ? ' (also on the client page)' : ''}.`}
          </div>
        </div>
        <div className="flog-tools">
          {data.workStatuses && (
            <label className="flog-status">
              <span>Status</span>
              <Combo value={data.workStatus || ''} disabled={!data.canSetStatus} onChange={(e) => saveStatus(e.target.value)} aria-label="Client status">
                <option value="">Not set</option>
                {data.workStatuses.map((w) => <option key={w} value={w}>{w}</option>)}
              </Combo>
            </label>
          )}
          {data.canAdd && <FollowUpLogImport params={params} onDone={(m) => { setFlash(m); load(); }} />}
          <ExportMenu url="/client-followlog/export" params={params} />
        </div>
      </div>

      {data.tabs && (
        <div className="flog-tabs" role="tablist" aria-label="Follow-up sub tabs">
          {data.tabs.map((t) => <button key={t.key} type="button" role="tab" aria-selected={subTab === t.key} className={`flog-tab${subTab === t.key ? ' on' : ''}`} onClick={() => pickTab(t.key)}>{t.label}<span>{(searching ? perTab[t.key] || 0 : t.count).toLocaleString('en-IN')}</span></button>)}
        </div>
      )}

      {data.canAdd && (
        <div className={`flog-add${data.tabs ? ' flog-add-client' : ''}`}>
          <label className="flog-date">
            <span>Follow-up date</span>
            <input type="date" value={onDate} max={data.today} onChange={(e) => setOnDate(e.target.value)} />
          </label>
          {data.tabs && (
            <label className="flog-reqpick">
              <span>Requirement</span>
              {reqPick(lineReq, setLineReq, 'Requirement')}
            </label>
          )}
          <label className="flog-note">
            <span>What happened?</span>
            <textarea rows="2" value={note} maxLength={2000} placeholder={candidateId ? 'Called the candidate: interested, will attend the interview on Monday' : 'Called the HOD: 5 interviews scheduled for tomorrow at 10:30'} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="flog-date" title="A pop-up reminds the recruiter on this day. A date in the words (call on 7th november, tomorrow, monday) is used when this is empty.">
            <span>Call back on</span>
            <input type="date" value={remindOn} min={data.today} onChange={(e) => setRemindOn(e.target.value)} />
          </label>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add follow-up'}</button>
        </div>
      )}
      {flash && <div className="flog-flash" role="status">{flash}</div>}
      {error && <div className="error-text">{error}</div>}

      {tabCount > 0 && (
        <div className="flog-filters">
          {data.tabs && data.requirements.length > 0 && (
            <Combo value={reqFilter} onChange={(e) => { setReqFilter(e.target.value); setDays(PAGE); }} aria-label="Filter by requirement">
              <option value="">All requirements</option>
              {data.requirements.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </Combo>
          )}
          {data.whoMode === 'mine' ? (
            <select value="" disabled aria-label="Who" title="You see your own follow-ups on this candidate">
              <option value="">Me</option>
            </select>
          ) : (
            <select value={who} onChange={(e) => { setWho(e.target.value); setDays(PAGE); }} aria-label="Who">
              <option value="">{teamWho ? 'Everyone (team)' : 'Everyone'}</option>
              {teamWho
                ? data.whoPeople.map((p) => <option key={p.id} value={p.id}>{`${p.name}${p.role ? ` (${p.role})` : ''}`}</option>)
                : data.people.map((p) => <option key={p} value={p}>{p}</option>)}
              {sheetRows > 0 && <option value="__sheet">Only the lines from the sheet</option>}
            </select>
          )}
          <label className="small-muted">From <input type="date" value={fromD} max={toD || undefined} onChange={(e) => { setFromD(e.target.value); setDays(PAGE); }} aria-label="From date" /></label>
          <label className="small-muted">To <input type="date" value={toD} min={fromD || undefined} onChange={(e) => { setToD(e.target.value); setDays(PAGE); }} aria-label="To date" /></label>
          <input type="search" value={q} placeholder="Search what happened, a name, requirement or client…" onChange={(e) => { setQ(e.target.value); setDays(PAGE); }} />
          {searching ? (
            <span className="flog-found" role="status">
              {people > 0 ? `${people.toLocaleString('en-IN')} ${people === 1 ? 'person' : 'people'} found · ` : ''}
              {`${totalRows.toLocaleString('en-IN')} of ${tabCount.toLocaleString('en-IN')} lines`}
              {elsewhere && <button type="button" className="flog-found-go" onClick={() => pickTab(elsewhere.key)}>{`${perTab[elsewhere.key].toLocaleString('en-IN')} in ${elsewhere.label} →`}</button>}
            </span>
          ) : <span className="small-muted">{totalRows === tabCount ? '' : `${totalRows} of ${tabCount}`}</span>}
        </div>
      )}

      <div className="flog-list">
        {groups.slice(0, days).map((g) => (
          <div key={g.day} className="flog-day">
            <div className="flog-dayhead">{g.day ? fmtDay(g.day) : 'No date in the sheet'}</div>
            {g.rows.map((e) => (editing && editing.id === e.id ? (
              <div key={e.id} className="flog-row flog-edit">
                <textarea rows="3" value={editing.note} maxLength={2000} aria-label="What happened" onChange={(x) => setEditing({ ...editing, note: x.target.value })} />
                <div className="flog-edit-row">
                  <input type="date" value={editing.onDate} max={data.today} aria-label="Follow-up date" onChange={(x) => setEditing({ ...editing, onDate: x.target.value })} />
                  <Combo value={editing.tab} onChange={(x) => setEditing({ ...editing, tab: x.target.value })} aria-label="Sub tab">
                    {data.tabs.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </Combo>
                  {reqPick(editing.requirementId || '', (v) => setEditing({ ...editing, requirementId: v }), 'Requirement')}
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={saveEdit}>Save</button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div key={e.id} className="flog-row">
                <div className="flog-text">{e.note}</div>
                <div className="flog-meta">
                  {e.source === 'sheet'
                    ? <span className="flog-tag">From the sheet{e.topic ? ` · ${e.topic}` : ''}</span>
                    : <span><b>{e.byName || 'Someone'}</b>{e.byRole ? ` (${e.byRole})` : ''}</span>}
                  {e.source === 'quick' && <span className="flog-tag">{`Logged ${e.topic === 'Call' ? 'call' : (e.topic || '').toLowerCase()}`}</span>}
                  {e.source === 'task' && <span className="flog-tag">Follow-up task</span>}
                  {e.callBackOn && <span className="flog-tag" title={e.callBackOpen ? 'A pop-up reminds the recruiter on this day' : 'The reminder was answered'}>{`${e.callBackOpen ? '🔔' : '✓'} Call back on ${fmtDay(e.callBackOn)}`}</span>}
                  {e.requirementLabel && <span className="flog-req">{e.requirementLabel}</span>}
                  {e.recruiter && <span>{`Recruiter: ${e.recruiter}`}</span>}
                  {e.editedBy && <span>{`Edited by ${e.editedBy}`}</span>}
                  {e.canEdit && <button type="button" className="flog-act" onClick={() => setEditing({ id: e.id, note: e.note, onDate: e.onDate || '', tab: e.tab, requirementId: e.requirementId || '' })}>Edit</button>}
                  {e.canDelete && <button type="button" className="flog-act danger" onClick={() => removeLine(e)}>Delete</button>}
                </div>
              </div>
            )))}
          </div>
        ))}
        {groups.length === 0 && <div className="small-muted">{elsewhere ? `Nothing in this sub tab. It is under ${elsewhere.label}.` : (tabCount ? 'No follow-up matches.' : 'Nothing here yet.')}</div>}
      </div>
      {groups.length > days && (
        <button type="button" className="btn btn-sm" onClick={() => setDays((d) => d + PAGE)}>{`Show more (${totalRows - shownRows} older)`}</button>
      )}
    </div>
  );
}
