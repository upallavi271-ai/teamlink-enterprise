import { useRef, useState } from 'react';
import Combo from '../../Combo.jsx';
import MultiPick from '../../MultiPick.jsx';
import { Btn, GsModal, Banner } from '../ui.jsx';
import omni from '../omniApi.js';
import { csvOf, saveBlob, errText } from './crmUtil.js';

// Import Customers, 3 steps (the prototype's wizard) on the real import engine (/api/outreach/import/check and /save):
//   1 Download Sample File + Upload Your File   2 Match the columns (every box incl. language, preferred channel, notes, custom fields), check, duplicates, kind
//   3 Review & Import: the permission tick + where the people come from (both are kept), "rows with problems" file, undo for 7 days.
// Nothing is sent by importing. Anyone who opted out stays opted out, whatever is chosen.
const MODES = [['skip', 'Skip people already here'], ['merge', 'Update them: fill their empty boxes only'], ['overwrite', 'Update them: replace their details with the file']];
const Tile = ({ n, l, tone }) => <div style={{ flex: '1 1 120px', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 12px', background: tone === 'red' ? '#fff5f5' : (tone === 'green' ? 'var(--green-3)' : '#fafbfa') }}><div style={{ fontSize: 18, fontWeight: 900 }}>{Number(n).toLocaleString('en-IN')}</div><div style={{ fontSize: 9.5, color: 'var(--muted)' }}>{l}</div></div>;

export default function ImportModal({ type, meta, onClose, onDone, go }) {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [check, setCheck] = useState(null);
  const [mapping, setMapping] = useState({});
  const [kinds, setKinds] = useState([]);
  const [mode, setMode] = useState('skip');
  const [confirmOw, setConfirmOw] = useState(false);
  const [perm, setPerm] = useState(false);
  const [basis, setBasis] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(null);
  const [undone, setUndone] = useState('');
  const input = useRef(null);
  const [drag, setDrag] = useState(false);

  const post = (path, f, map, k, m, extra = {}) => omni.post(`${path}?${new URLSearchParams({ type, dupMode: m, industries: k.join('|'), mapping: JSON.stringify(map || {}), ...extra }).toString()}`, f, { headers: { 'Content-Type': 'application/octet-stream' }, transformRequest: [(x) => x] });
  async function run(f, map, k = kinds, m = mode) {
    setBusy('check'); setErr('');
    try { const r = await post('/import/check', f, map, k, m); setCheck(r); setMapping(r.mapping || {}); return r; } catch (e) { setErr(errText(e, 'That file could not be read.')); setCheck(null); return null; } finally { setBusy(''); }
  }
  const pick = (f) => { if (!f) return; setFile(f); setCheck(null); setSaved(null); setPerm(false); setConfirmOw(false); run(f, null, kinds, mode); };
  const sample = async () => { try { saveBlob(await omni.blob('/gs/crm/import/sample.csv', { type }), 'customer_import_sample.csv'); } catch { setErr('The sample file could not be made.'); } };
  const t = check && check.totals;
  const mapped = check && !check.needsMapping;
  const toNext = () => {
    if (step === 1) { if (!file) { setErr('Choose a file first.'); return; } if (busy) return; setErr(''); setStep(2); return; }
    if (step === 2) { if (!mapped) { setErr('Choose the column that has the phone number or the email first.'); return; } setErr(''); setStep(3); }
  };
  const canSave = mapped && perm && basis.trim().length >= 5 && !busy && (t.new > 0 || (t.duplicate > 0 && mode !== 'skip')) && (mode !== 'overwrite' || confirmOw);
  const save = async () => {
    setBusy('save'); setErr('');
    try { const r = await post('/import/save', file, mapping, kinds, mode, { permission: '1', basis, source, filename: file.name, ...(mode === 'overwrite' && confirmOw ? { confirmOverwrite: '1' } : {}) }); setSaved(r); onDone(r); } catch (e) { setErr(errText(e, 'It could not be saved.')); } finally { setBusy(''); }
  };
  const undo = async () => { try { const r = await omni.post(`/imports/${saved.importId}/undo`); setUndone(r.ok); onDone(r); } catch (e) { setErr(errText(e, 'It could not be taken back.')); } };
  const problemsCsv = () => saveBlob(new Blob([csvOf([['Row', 'Name', 'Phone', 'Email', 'Problem', 'Why', 'Notes'], ...(check.problems || []).map((p) => [p.i, p.name, p.phone, p.email, p.statusWords, p.why, (p.notes || []).join('; ')])])], { type: 'text/csv' }), 'rows-with-problems.csv');
  const savedProblems = async () => {
    if (saved.rowsSaved) { try { saveBlob(await omni.blob(`/imports/${saved.importId}/rows.csv`), 'rows-with-problems.csv'); return; } catch { /* fall back */ } }
    saveBlob(new Blob([csvOf([['Row', 'Name', 'Result', 'Why'], ...(saved.problems || []).map((p) => [p.line, p.name, p.result, p.why])])], { type: 'text/csv' }), 'rows-with-problems.csv');
  };
  const colOptions = check ? check.headers.map((h, i) => <option key={i} value={String(i)}>{h || `Column ${i + 1}`}</option>) : null;
  const setMap = (key, v) => { const m = { ...mapping }; if (v === '') delete m[key]; else m[key] = Number(v); setMapping(m); run(file, m); };

  const foot = saved ? <Btn primary onClick={onClose}>Done</Btn> : (
    <>
      {step > 1 ? <Btn onClick={() => { setErr(''); setStep(step - 1); }}>← Back</Btn> : <Btn onClick={onClose}>Cancel</Btn>}
      {step < 3 && <Btn primary onClick={toNext} disabled={(step === 1 && !file) || !!busy}>→ Next</Btn>}
      {step === 3 && <Btn primary onClick={save} disabled={!canSave}>{busy === 'save' ? 'Saving…' : `✓ Import ${(t ? t.new : 0).toLocaleString('en-IN')} Customers`}</Btn>}
    </>
  );
  return (
    <GsModal title={`Import Customers (${saved ? 3 : step}/3)`} width={680} onClose={onClose} foot={foot} bodyStyle={{ maxHeight: '66vh', minHeight: 260 }}>
      {saved ? (
        <div>
          <Banner tone="ok">{saved.ok}</Banner>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
            <Tile n={saved.counts.created} l="Added" tone="green" /><Tile n={saved.counts.updated} l="Changed" /><Tile n={saved.counts.duplicates} l="Already here / repeated" /><Tile n={saved.counts.invalid} l="No usable phone or email" tone={saved.counts.invalid ? 'red' : undefined} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {saved.problemCount > 0 && <Btn small onClick={savedProblems}>⬇ Download the {saved.problemCount} rows with problems (CSV)</Btn>}
            {!undone && <Btn small onClick={undo}>Undo this import</Btn>}
            {undone && <b style={{ fontSize: 11 }}>{undone}</b>}
          </div>
          <p style={{ fontSize: 10, color: 'var(--muted)' }}>You can take back a whole import within 7 days from the Imports tab.</p>
        </div>
      ) : (
        <>
          {step === 1 && (
            <div>
              <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Download Sample File</h4>
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 10px' }}>Download our sample file to ensure your data is formatted correctly.</p>
              <Btn onClick={sample}>⬇ Download Sample .csv</Btn>
              <h4 style={{ margin: '18px 0 8px', fontSize: 13 }}>Upload Your File</h4>
              <div role="button" tabIndex={0} onClick={() => input.current && input.current.click()} onKeyDown={(e) => { if (e.key === 'Enter') input.current.click(); }}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files && e.dataTransfer.files[0]); }}
                style={{ border: `2px dashed ${drag ? 'var(--green)' : 'var(--line)'}`, borderRadius: 12, padding: '26px 14px', textAlign: 'center', cursor: 'pointer', background: drag ? 'var(--green-3)' : '#fafbfa' }}>
                <div style={{ fontSize: 22 }}>⬆</div>
                <div style={{ fontSize: 12, fontWeight: 800 }}>{file ? `${file.name} selected ✓` : 'Click to upload or drag and drop'}</div>
                <div style={{ fontSize: 10, color: 'var(--muted)' }}>.csv or Excel, up to 5,000 rows. Columns: Name, Phone, Email, Language, Preferred channel, Notes, Platform ID and your own fields.</div>
              </div>
              <input ref={input} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} aria-label="Customer file" onChange={(e) => pick(e.target.files && e.target.files[0])} />
              {busy === 'check' && <p style={{ fontSize: 11, color: 'var(--muted)' }}>Reading and checking every row…</p>}
            </div>
          )}
          {step === 2 && (
            <div>
              {busy === 'check' && <p style={{ fontSize: 11, color: 'var(--muted)' }}>Checking every row…</p>}
              {check && (
                <>
                  {check.needsMapping && <Banner tone="warn">{check.message || 'Choose the column that has the phone number or the email.'}</Banner>}
                  {t && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0 12px' }}>
                      <Tile n={t.new} l="Will be added" tone="green" /><Tile n={t.duplicate} l="Already here" /><Tile n={t.invalid} l="No usable phone or email" tone={t.invalid ? 'red' : undefined} /><Tile n={t.dup_in_file + t.opted_out + t.conflict} l="Repeated in file, opted out, or need a look" />
                    </div>
                  )}
                  <h4 style={{ margin: '4px 0 6px', fontSize: 13 }}>Match your columns</h4>
                  <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: '0 0 8px' }}>{check.rowCount.toLocaleString('en-IN')} rows read. We guessed the columns by their names; change any that are wrong. A person is found by their phone OR their email, however the number is written.</p>
                  <div className="table-scroll" style={{ border: '1px solid var(--line)', borderRadius: 10, maxHeight: 250 }}>
                    <table className="table" style={{ minWidth: 0 }}>
                      <thead><tr><th>Box in Customers</th><th>Column in your file</th></tr></thead>
                      <tbody>
                        {Object.entries(check.fields).map(([key, words]) => (
                          <tr key={key}><td style={{ fontSize: 11 }}>{words}</td>
                            <td style={{ minWidth: 200 }}><Combo value={mapping[key] === undefined ? '' : String(mapping[key])} onChange={(e) => setMap(key, e.target.value)}><option value="">-- not in my file --</option>{colOptions}</Combo></td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="field" style={{ marginTop: 12 }}><label>KIND FOR EVERY PERSON IN THIS FILE</label>
                    <MultiPick options={meta.kinds.map((k) => ({ value: k, label: k }))} value={kinds} onChange={(v) => { setKinds(v); run(file, mapping, v, mode); }} placeholder="Use the Kind column of the file" />
                  </div>
                  <div className="field" style={{ marginTop: 12 }}><label>IF A PERSON IS ALREADY HERE</label>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{MODES.map(([k, w]) => <button type="button" key={k} className={`tiny-btn${mode === k ? ' sel' : ''}`} style={mode === k ? { background: 'var(--green-3)', borderColor: 'var(--green)', color: 'var(--green-2)' } : undefined} onClick={() => { setMode(k); setConfirmOw(false); run(file, mapping, kinds, k); }}>{w}</button>)}</div>
                    <small style={{ fontSize: 9.5, color: 'var(--muted)' }}>Anyone who opted out stays opted out, whatever you choose. Phone and email are only ever added to an empty box.</small>
                  </div>
                  {t && t.unknownIndustry > 0 && <Banner tone="warn">{t.unknownIndustry} kind(s) in the file are not in the list ({check.unknownIndustries.join(', ')}). They are ignored. An Admin can add new kinds.</Banner>}
                </>
              )}
            </div>
          )}
          {step === 3 && check && t && (
            <div>
              <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>Review &amp; Import</h4>
              <div className="kv-grid" style={{ marginTop: 6 }}>
                <div className="kv-item"><small>File</small><b>{file.name}</b></div>
                <div className="kv-item"><small>Rows detected</small><b>{check.rowCount.toLocaleString('en-IN')}</b></div>
                <div className="kv-item"><small>Will be added</small><b>{t.new.toLocaleString('en-IN')}</b></div>
                <div className="kv-item"><small>Already here</small><b>{t.duplicate.toLocaleString('en-IN')} — {MODES.find((m) => m[0] === mode)[1].toLowerCase()}</b></div>
              </div>
              <p style={{ fontSize: 10.5, color: 'var(--muted)' }}>Each row will be added as a new customer on the Default view. {Object.keys(mapping).length} columns are used.</p>
              {mode === 'overwrite' && <label style={{ display: 'flex', gap: 8, fontSize: 11, margin: '8px 0' }}><input type="checkbox" checked={confirmOw} onChange={(e) => setConfirmOw(e.target.checked)} /> Yes, replace their details with what is in the file</label>}
              {check.problemCount > 0 && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '8px 0' }}><b style={{ fontSize: 11 }}>{check.problemCount} rows need a look</b><Btn small onClick={problemsCsv}>⬇ Download the rows with problems (CSV)</Btn></div>}
              <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, background: '#fafbfa' }}>
                <label style={{ display: 'flex', gap: 8, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}><input type="checkbox" checked={perm} onChange={(e) => setPerm(e.target.checked)} /> I have permission to message these people</label>
                <div className="field" style={{ marginTop: 10 }}><label>WHERE DO THESE CONTACTS COME FROM?</label><input value={basis} maxLength={400} onChange={(e) => setBasis(e.target.value)} placeholder="Our own past candidates who shared their number" /></div>
                <div className="field" style={{ marginTop: 8 }}><label>NAME FOR THIS FILE (OPTIONAL)</label><input value={source} maxLength={140} onChange={(e) => setSource(e.target.value)} placeholder="Medical contacts, Oct 2026" /></div>
                <small style={{ fontSize: 9.5, color: 'var(--muted)' }}>This is saved with your name and the time. Nothing is sent by importing.</small>
              </div>
            </div>
          )}
        </>
      )}
      {err && <Banner tone="error">{err}</Banner>}
    </GsModal>
  );
}
