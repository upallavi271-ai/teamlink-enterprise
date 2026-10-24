import { useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import MultiPick from '../MultiPick.jsx';
import StatusChip from '../ui/StatusChip.jsx';

const TONE = { new: 'green', duplicate: 'blue', conflict: 'yellow', dup_in_file: 'yellow', invalid: 'red', opted_out_file: 'yellow', suppressed: 'yellow' };
const MODES = [['skip', 'Skip people already here'], ['merge', 'Update them: fill their empty boxes only'], ['overwrite', 'Update them: replace their details with the file']];
// a cell that starts with = @ + - (and is not a plain number) gets a leading apostrophe, so Excel never runs it as a formula
const safeCell = (v) => { let t = String(v == null ? '' : v); if (/^[=@\t\r]/.test(t) || (/^[+-]/.test(t) && !/^[+-]?\d+(\.\d+)?$/.test(t))) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
const saveCsv = (rows, name) => {
  const csv = '\uFEFF' + rows.map((r) => r.map(safeCell).join(',')).join('\r\n') + '\r\n';
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; a.click();
};

// ---------------------------------------------------------------------------
// IMPORT CONTACTS (CSV / Excel). 1 Upload  >  2 Check (nothing saved yet)  >  3 Permission tick + Save. Server: /api/outreach/import/*.
// Nothing is sent by importing. The tick "I have permission to message these people" is required and kept (who, when, why).
// ---------------------------------------------------------------------------
export default function ImportWizard({ acc, type, onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [check, setCheck] = useState(null);
  const [mapping, setMapping] = useState({});
  const [kinds, setKinds] = useState([]);
  const [mode, setMode] = useState('skip');
  const [confirmOw, setConfirmOw] = useState(false);
  const [resolutions, setResolutions] = useState({}); // row -> the person chosen for a row that matched two people
  const [perm, setPerm] = useState(false);
  const [basis, setBasis] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState('');
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(null);
  const [undone, setUndone] = useState('');
  const input = useRef(null);

  const post = (path, f, map, k, m, extra = {}, res = resolutions) => api.post(`/outreach${path}?${new URLSearchParams({ type, dupMode: m, industries: k.join('|'), mapping: JSON.stringify(map || {}), ...(Object.keys(res).length ? { resolutions: JSON.stringify(res) } : {}), ...extra }).toString()}`, f, {
    headers: { 'Content-Type': 'application/octet-stream' }, transformRequest: [(x) => x], onUploadProgress: (e) => setPct(e.total ? Math.round((e.loaded * 100) / e.total) : 0),
  });
  async function run(f, map, k = kinds, m = mode, res = resolutions) {
    setBusy('check'); setErr(''); setPct(0);
    try {
      const r = await post('/import/check', f, map, k, m, {}, res);
      setCheck(r.data); setMapping(r.data.mapping || {});
    } catch (e) { setErr(e.response?.data?.error || 'That file could not be read.'); setCheck(null); } finally { setBusy(''); }
  }
  const pick = (f) => { if (!f) return; setFile(f); setCheck(null); setSaved(null); setPerm(false); setResolutions({}); setConfirmOw(false); run(f, null, undefined, undefined, {}); };
  const choose = (line, id) => { const next = { ...resolutions }; if (id) next[line] = id; else delete next[line]; setResolutions(next); run(file, mapping, kinds, mode, next); };
  const save = async () => {
    setBusy('save'); setErr('');
    try {
      const r = await post('/import/save', file, mapping, kinds, mode, { permission: '1', basis, source, filename: file.name, ...(mode === 'overwrite' && confirmOw ? { confirmOverwrite: '1' } : {}) });
      setSaved(r.data); onSaved();
    } catch (e) { setErr(e.response?.data?.error || 'It could not be saved.'); } finally { setBusy(''); }
  };
  const undo = async () => {
    try { const r = await api.post(`/outreach/imports/${saved.importId}/undo`); setUndone(r.data.ok); onSaved(); } catch (e) { setErr(e.response?.data?.error || 'It could not be taken back.'); }
  };
  const t = check && check.totals;
  const csvProblems = () => saveCsv([['Row', 'Name', 'Phone', 'Email', 'Problem', 'Why', 'Notes'], ...(check.problems || []).map((p) => [p.i, p.name, p.phone, p.email, p.statusWords, p.why, (p.notes || []).join('; ')])], 'rows-with-problems.csv');
  // after saving: the saved per-row list from the server (every row that needs a look, in words); else the same list from what the server handed back
  const savedProblems = async () => {
    if (saved.rowsSaved) {
      try { const r = await api.get('/outreach/imports/' + saved.importId + '/rows.csv', { responseType: 'blob' }); const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'rows-with-problems.csv'; a.click(); return; } catch (e) { /* fall back to the list in hand */ }
    }
    saveCsv([['Row', 'Name', 'Result', 'Why'], ...(saved.problems || []).map((p) => [p.line, p.name, p.result, p.why])], 'rows-with-problems.csv');
  };
  const template = () => api.get('/outreach/import/template', { params: { type, format: 'xlsx' }, responseType: 'blob' }).then((r) => { const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'outreach-contacts-template.xlsx'; a.click(); });
  const ready = check && !check.needsMapping && !saved;
  const canSave = ready && perm && basis.trim().length >= 5 && !busy && (t.new > 0 || (t.duplicate > 0 && mode !== 'skip')) && (mode !== 'overwrite' || confirmOw);

  return (
    <Modal title={type === 'internal' ? 'Import internal contacts' : 'Import contacts'} size="wide" onClose={onClose} foot={(
      <>
        <button type="button" className="btn" onClick={onClose}>{saved ? 'Close' : 'Cancel'}</button>
        {ready && <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>{busy === 'save' ? 'Saving…' : `Save ${(t.new || 0).toLocaleString('en-IN')} contacts`}</button>}
      </>
    )}
    >
      <div className="bc-steps">
        <div className={`bc-step ${!check ? 'on' : 'done'}`}>1. Upload</div>
        <div className={`bc-step ${ready ? 'on' : (saved ? 'done' : '')}`}>2. Check</div>
        <div className={`bc-step ${saved ? 'done' : ''}`}>3. Save</div>
      </div>
      {!saved && (
        <div className="oc-row2">
          <input ref={input} type="file" accept=".csv,.xlsx,.xls" onChange={(e) => pick(e.target.files?.[0])} aria-label="Contact file" />
          <button type="button" className="btn btn-sm" onClick={template}>Download the Excel template</button>
          <span className="oc-note">CSV or Excel, up to 5,000 rows. Columns: Name, Phone, Email, Company, City, Skills, Kind, Tags (separated by commas), Permission.</span>
        </div>
      )}
      {busy === 'check' && <div><div className="bc-bar"><i style={{ width: `${pct || 30}%` }} /></div><div className="oc-note">Reading and checking every row…</div></div>}
      {err && <div className="bc-err" role="alert">{err}</div>}

      {check && check.needsMapping && (
        <div className="bc-box">
          <b>{check.message || 'Which column has the phone or email?'}</b>
          <div className="oc-note">Press the column that has the phone number (you can add the email column after).</div>
          <div className="oc-choice">{check.headers.map((h, i) => <button type="button" key={i} onClick={() => { const m = { ...mapping, phone: i }; setMapping(m); run(file, m); }}>{h || `Column ${i + 1}`}</button>)}</div>
        </div>
      )}

      {ready && (
        <>
          <div className="bc-tiles">
            <div className="bc-tile green"><div className="n">{t.new}</div><div className="l">Will be added</div></div>
            <div className="bc-tile blue"><div className="n">{t.duplicate}</div><div className="l">Already here</div></div>
            <div className="bc-tile red"><div className="n">{t.invalid}</div><div className="l">No usable phone or email</div></div>
            <div className="bc-tile orange"><div className="n">{t.dup_in_file + t.opted_out}</div><div className="l">Repeated in file, or opted out</div></div>
            {t.conflict > 0 && <div className="bc-tile orange"><div className="n">{t.conflict}</div><div className="l">Need you to choose a person</div></div>}
          </div>
          <div className="oc-note">A person is found by their phone OR their email, however the number is written (+91, 0, spaces).</div>
          <div className="oc-note">{`${check.rowCount.toLocaleString('en-IN')} rows read. Columns found: ${Object.entries(mapping).map(([f, i]) => `${check.fields[f]} = "${check.headers[i]}"`).join(' · ')}`}</div>
          <div className="field" style={{ marginTop: 8 }}><span>Kind for every person in this file</span>
            <MultiPick options={acc.industries.map((i) => ({ value: i.name, label: i.name }))} value={kinds} onChange={(v) => { setKinds(v); run(file, mapping, v, mode); }} placeholder="Use the Kind column of the file" />
          </div>
          {t.unknownIndustry > 0 && <div className="bc-warn">{`${t.unknownIndustry} kind${t.unknownIndustry > 1 ? 's' : ''} in the file are not in the list (${check.unknownIndustries.join(', ')}). They are ignored. An Admin can add new kinds.`}</div>}
          {t.unknownTags > 0 && <div className="bc-warn">{`${t.unknownTags} tag${t.unknownTags > 1 ? 's' : ''} in the Tags column are not in the kinds list, so they are not added (they are listed in the rows below). An Admin can add new kinds.`}</div>}
          <div className="field"><span>If a person is already here</span>
            <div className="oc-choice">{MODES.map(([k, w]) => <button type="button" key={k} className={mode === k ? 'on' : ''} onClick={() => { setMode(k); setConfirmOw(false); run(file, mapping, kinds, k); }}>{w}</button>)}</div>
            <div className="oc-note">Anyone who opted out stays opted out, whatever you choose. Phone and email are only ever added to an empty box.</div>
            {mode === 'overwrite' && <label className="oc-tick" style={{ display: 'block' }}><input type="checkbox" checked={confirmOw} onChange={(e) => setConfirmOw(e.target.checked)} /> Yes, replace their details with what is in the file</label>}
          </div>
          {check.problems.some((p) => p.status === 'conflict') && (
            <div>
              <b>Rows that match two different people</b>
              <div className="oc-note">The phone is one person and the email is another. Nothing is changed until you choose. Rows you leave are skipped.</div>
              {check.problems.filter((p) => p.status === 'conflict').slice(0, 30).map((p) => (
                <div className="oq-conflict" key={p.i}>
                  <div>Row {p.i}: <b>{p.name || '(no name)'}</b></div>
                  <div className="oc-choice">{(p.matches || []).map((m) => <button type="button" key={m.id} onClick={() => choose(p.i, m.id)}>It is {m.name}{m.hint ? ` (${m.hint})` : ''}</button>)}</div>
                </div>
              ))}
            </div>
          )}
          {Object.keys(resolutions).length > 0 && <div className="oc-note">{Object.keys(resolutions).length} {Object.keys(resolutions).length === 1 ? 'choice' : 'choices'} made. <button type="button" className="btn btn-sm" onClick={() => { setResolutions({}); run(file, mapping, kinds, mode, {}); }}>Clear my choices</button></div>}
          {check.problemCount > 0 && (
            <>
              <div className="oc-row2"><b>{check.problemCount} rows need a look</b><button type="button" className="btn btn-sm" onClick={csvProblems}>Download the rows with problems (CSV)</button></div>
              <div className="oc-scroll" style={{ maxHeight: 200 }}>
                <table className="oc-table"><thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>What</th></tr></thead>
                  <tbody>{check.problems.slice(0, 100).map((p) => <tr key={p.i}><td>{p.i}</td><td>{p.name}</td><td>{p.phone}</td><td><StatusChip tone={TONE[p.status]}>{p.statusWords}</StatusChip> <span className="oc-note">{p.why}</span>{(p.notes || []).map((n) => <div className="oc-note" key={n}>{n}</div>)}</td></tr>)}</tbody></table>
              </div>
            </>
          )}
          <div className="oc-tick">
            <label><input type="checkbox" checked={perm} onChange={(e) => setPerm(e.target.checked)} /> I have permission to message these people</label>
            <label className="field" style={{ display: 'block', fontWeight: 400, marginTop: 8 }}><span>Where do these contacts come from?</span>
              <input value={basis} maxLength={400} onChange={(e) => setBasis(e.target.value)} placeholder="Our own past candidates who shared their number" /></label>
            <label className="field" style={{ display: 'block', fontWeight: 400 }}><span>Name for this file (optional)</span>
              <input value={source} maxLength={140} onChange={(e) => setSource(e.target.value)} placeholder="Medical contacts, Oct 2026" /></label>
            <div className="oc-note">This is saved with your name and the time. Nothing is sent by importing.</div>
          </div>
        </>
      )}
      {saved && (
        <div className="bc-ok" role="status">
          {saved.ok}
          <div className="oc-row2">
            {saved.problemCount > 0 && <button type="button" className="btn btn-sm" onClick={savedProblems}>Download the {saved.problemCount} rows with problems (CSV)</button>}
            {!undone && <button type="button" className="btn btn-sm" onClick={undo}>Undo this import</button>}
            {undone && <b>{undone}</b>}
          </div>
        </div>
      )}
    </Modal>
  );
}
