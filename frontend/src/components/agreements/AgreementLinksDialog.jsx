// ---------------------------------------------------------------------------
// ADD AGREEMENT LINKS (MANY AT ONCE) — the signed agreements already sit in Google Drive; this attaches many
// clients' links in one go (user, 2026-10-12: "BDE ki, bulk lo agreement Drive links upload cheskuney option undali").
//
//   Step 1  Paste or upload   one line per client: Client name or ID · Drive link · Agreement date · End date · Note
//   Step 2  Check             every line matched to a client of THIS login's area; fix what is wrong, then go on
//   Step 3  Add               saves the good lines only; a result list with a Download result button
//
// Opened from the Agreements tab (many clients) or from one client's Agreement card (`client` given: one link).
// The server checks everything again (routes/agreementDriveLinkRoutes.js) and never opens a link.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import './agreementDriveLinks.css';

const MAX = 500;
const BATCH = 25;
const EXAMPLE = 'Sri Vidya School\thttps://drive.google.com/file/d/…/view\t31-03-2026\t30-03-2027\nCL-3FA9B2\thttps://drive.google.com/open?id=…';
// text/plain keeps a 500-line list under the default JSON size limit; the server reads it as JSON.
const post = (url, body) => api.post(url, JSON.stringify(body), { headers: { 'Content-Type': 'text/plain' } });
const say = (e, fallback) => e?.response?.data?.error || fallback;
const csvCell = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;

function saveText(name, text, type = 'text/csv;charset=utf-8') {
  const href = URL.createObjectURL(new Blob([`﻿${text}`], { type }));
  const a = document.createElement('a');
  a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

export default function AgreementLinksDialog({ client = null, onClose, onDone }) {
  const [step, setStep] = useState(1);
  const [rights, setRights] = useState(null);
  const [text, setText] = useState('');
  const [one, setOne] = useState({ link: '', agreementDate: '', endDate: '', note: '' });
  const [lines, setLines] = useState([]); // the lines being checked (inputs)
  const [rows, setRows] = useState([]); // the server's answer for each line
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [fix, setFix] = useState(null); // index of the line being fixed
  const [fixDraft, setFixDraft] = useState(null);
  const [results, setResults] = useState([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [runId] = useState(() => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  const cancelled = useRef(false);
  const fileRef = useRef(null);

  useEffect(() => {
    cancelled.current = false; // (React's dev double-mount runs the cleanup once: it must not leave a stop sign behind)
    api.get('/clients/agreement-links/rights').then((r) => setRights(r.data)).catch(() => setRights({ canAdd: false, why: 'Could not load your rights. Please try again.' }));
    return () => { cancelled.current = true; };
  }, []);

  const lineCount = useMemo(() => text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length, [text]);

  async function runCheck(payload) {
    setBusy('check'); setErr('');
    try {
      const res = await post('/clients/agreement-links/check', payload);
      setRows(res.data.rows || []);
      setLines((res.data.rows || []).map((r) => ({ ...r.input })));
      setStep(2);
    } catch (e) { setErr(say(e, 'Could not check the list. Please try again.')); }
    setBusy('');
  }
  const checkPasted = () => {
    if (client) {
      if (!one.link.trim()) { setErr('Paste the Google Drive link first.'); return; }
      runCheck({ lines: [{ row: 1, clientId: client.id, ref: client.name, ...one, onExisting: 'keep' }] });
      return;
    }
    if (!text.trim()) { setErr('Paste at least one line: the client name (or ID) and its Drive link.'); return; }
    if (lineCount > MAX) { setErr(`You can add up to ${MAX} lines at a time. You have ${lineCount}. Split the list into smaller parts.`); return; }
    runCheck({ text });
  };
  const recheck = (next) => runCheck({ lines: next });

  async function upload(file) {
    if (!file) return;
    setBusy('file'); setErr('');
    try {
      const fd = new FormData(); fd.append('file', file, file.name);
      const res = await api.post('/clients/agreement-links/read-file', fd);
      setText(res.data.text || '');
    } catch (e) { setErr(say(e, 'That file could not be read.')); }
    setBusy('');
    if (fileRef.current) fileRef.current.value = '';
  }
  async function template(format) {
    try {
      const res = await api.get('/clients/agreement-links/template', { params: { format }, responseType: 'blob' });
      const href = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = href; a.download = `agreement-links-template.${format}`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
    } catch (e) { setErr('Could not download the template. Please try again.'); }
  }

  // ---- step 2 edits ----
  const setLine = (i, patch) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const pick = (i, clientId) => { const next = lines.map((l, k) => (k === i ? { ...l, clientId } : l)); recheck(next); };
  const choose = (i, onExisting) => { setLine(i, { onExisting }); setRows((rs) => rs.map((r, k) => (k === i ? { ...r, will: onExisting === 'replace' ? 'replace' : 'keep' } : r))); };
  const drop = (i) => { const next = lines.filter((_, k) => k !== i); setLines(next); setRows((rs) => rs.filter((_, k) => k !== i)); };
  const startFix = (i) => { setFix(i); setFixDraft({ ...lines[i], clientId: null }); };
  const saveFix = () => { const next = lines.map((l, k) => (k === fix ? { ...fixDraft } : l)); setFix(null); recheck(next); };

  const toAdd = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.ready && r.will !== 'keep');
  const counts = useMemo(() => {
    const c = {};
    rows.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }, [rows]);

  async function addAll() {
    const send = toAdd.map(({ r, i }) => ({ ...lines[i], row: r.row, clientId: r.client ? r.client.id : lines[i].clientId, onExisting: lines[i].onExisting }));
    setStep(3); setBusy('add'); setErr(''); setResults([]);
    setProgress({ done: 0, total: send.length });
    const all = [];
    try {
      for (let at = 0; at < send.length; at += BATCH) {
        if (cancelled.current) break;
        // eslint-disable-next-line no-await-in-loop
        const res = await post('/clients/agreement-links/apply', { runId, lines: send.slice(at, at + BATCH) });
        all.push(...(res.data.results || []));
        setResults([...all]); setProgress({ done: Math.min(at + BATCH, send.length), total: send.length });
      }
    } catch (e) {
      setErr(`${say(e, 'Stopped.')} The lines already saved are listed below.`);
    }
    // lines that were not sent (Kept / problems) are listed as skipped, so the result is the whole list
    const sentRows = new Set(send.map((s) => s.row));
    rows.forEach((r) => {
      if (!sentRows.has(r.row)) all.push({ row: r.row, client: r.client ? r.client.name : r.input.ref, outcome: 'Skipped', reason: r.will === 'keep' ? 'Kept the link the client already has.' : (r.message || r.chip) });
    });
    all.sort((a, b) => a.row - b.row);
    setResults(all); setBusy('');
    if (onDone) onDone();
  }
  const downloadResult = () => {
    const head = ['Line', 'Client', 'Result', 'Reason'].map(csvCell).join(',');
    saveText(`agreement-links-result-${new Date().toISOString().slice(0, 10)}.csv`, [head, ...results.map((x) => [x.row, x.client, x.outcome, x.reason].map(csvCell).join(','))].join('\r\n'));
  };
  const added = results.filter((x) => x.outcome === 'Added').length;
  const replaced = results.filter((x) => x.outcome === 'Replaced').length;
  const skipped = results.filter((x) => x.outcome === 'Skipped').length;

  // ---- screens ----
  const steps = (
    <ol className="adl-steps" aria-label="Steps">
      {['Paste or upload', 'Check', 'Add'].map((t, i) => (
        <li key={t} className={step === i + 1 ? 'on' : (step > i + 1 ? 'done' : '')}><span>{i + 1}</span>{t}</li>
      ))}
    </ol>
  );
  const tip = (
    <div className="adl-tip">
      <b>Before you add:</b> in Google Drive open the file, press <b>Share</b> and choose <b>Anyone with the link</b> (Viewer) or your company. Then Copy link.
      The app only saves the link; it cannot check who can open it.
    </div>
  );

  let body; let foot;
  if (rights && !rights.canAdd) {
    body = <div className="notice red">{rights.why || 'You cannot add agreement links.'}</div>;
    foot = <button type="button" className="btn" onClick={onClose}>Close</button>;
  } else if (step === 1) {
    body = (
      <>
        {steps}
        {client ? (
          <>
            <p className="adl-lead">{`Add the signed agreement of ${client.name}. Paste its Google Drive link.`}</p>
            <label className="adl-field"><span>Drive link</span><input value={one.link} placeholder="https://drive.google.com/file/d/…" onChange={(e) => setOne({ ...one, link: e.target.value })} /></label>
            <div className="adl-two">
              <label className="adl-field"><span>Agreement date</span><input value={one.agreementDate} placeholder="31-03-2026" onChange={(e) => setOne({ ...one, agreementDate: e.target.value })} /></label>
              <label className="adl-field"><span>End date</span><input value={one.endDate} placeholder="30-03-2027" onChange={(e) => setOne({ ...one, endDate: e.target.value })} /></label>
            </div>
            <label className="adl-field"><span>Note (optional)</span><input value={one.note} onChange={(e) => setOne({ ...one, note: e.target.value })} /></label>
          </>
        ) : (
          <>
            <p className="adl-lead">One line for each client: the <b>client name</b> (or Client ID), then its <b>Drive link</b>. Agreement date, end date and a note are optional. You can paste straight from Excel or Google Sheets.</p>
            <textarea
              className="adl-box" rows={9} value={text} spellCheck={false} aria-label="Client names and Drive links, one line each"
              placeholder={EXAMPLE} onChange={(e) => setText(e.target.value)}
            />
            <div className="adl-bar">
              <span className={`adl-count${lineCount > MAX ? ' bad' : ''}`}>{lineCount ? `${lineCount} line${lineCount === 1 ? '' : 's'} (up to ${MAX})` : `Up to ${MAX} lines at a time`}</span>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,text/csv" hidden onChange={(e) => upload(e.target.files[0])} />
              <button type="button" className="btn btn-sm" disabled={busy === 'file'} onClick={() => fileRef.current && fileRef.current.click()}>{busy === 'file' ? 'Reading…' : '⬆ Upload Excel or CSV'}</button>
              <button type="button" className="btn btn-sm" onClick={() => template('xlsx')}>⬇ Download template</button>
            </div>
          </>
        )}
        {tip}
        {err && <div className="notice red" role="alert">{err}</div>}
      </>
    );
    foot = (
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy === 'check' || !rights} onClick={checkPasted}>{busy === 'check' ? 'Checking…' : 'Check the list →'}</button>
      </>
    );
  } else if (step === 2) {
    const chips = [['ok', 'green', 'matched'], ['exists', 'orange', 'already have a link'], ['close', 'orange', 'to confirm'], ['duplicate', 'orange', 'duplicate'], ['notfound', 'red', 'not found'], ['notyours', 'red', 'not yours'], ['badlink', 'red', 'bad link'], ['baddate', 'red', 'bad date']]
      .filter(([k]) => counts[k]);
    body = (
      <>
        {steps}
        <p className="adl-lead">{rows.length ? `${rows.length} line${rows.length === 1 ? '' : 's'} checked. Fix the red and orange ones, or leave them out: only the good lines are added.` : 'No lines left.'}</p>
        <div className="adl-sum">{chips.map(([k, tone, label]) => <span key={k} className={`adl-chip ${tone}`}>{`${counts[k]} ${label}`}</span>)}</div>
        <div className="adl-list" role="table" aria-label="Checked lines">
          {rows.map((r, i) => (
            <div className={`adl-row ${r.tone}`} role="row" key={`${r.row}-${i}`}>
              <div className="adl-cell adl-no" data-l="Line">{r.row}</div>
              <div className="adl-cell adl-who" data-l="Client">
                <b>{r.client ? r.client.name : (r.input.ref || '—')}</b>
                {r.client && <span className="adl-sub">{[r.client.code, r.client.bdeOwner].filter(Boolean).join(' · ')}</span>}
                {r.client && r.input.ref && r.input.ref !== r.client.name && <span className="adl-sub">{`You wrote: ${r.input.ref}`}</span>}
              </div>
              <div className="adl-cell adl-link" data-l="Link">
                {r.link ? <span>{r.link.label}<span className="adl-sub">{[r.agreementDate, r.endDate && `to ${r.endDate}`].filter(Boolean).join(' ')}</span></span> : <span className="adl-sub">{r.input.link ? 'Not a Drive link' : 'No link'}</span>}
              </div>
              <div className="adl-cell adl-state" data-l="Check">
                <span className={`adl-chip ${r.tone}`}>{r.chip}</span>
                <span className="adl-msg">{r.message}</span>
                {r.extra && r.extra.map((t) => <span className="adl-msg" key={t}>{t}</span>)}
                {r.warnings && r.warnings.map((t) => <span className="adl-msg warn" key={t}>{t}</span>)}
                {r.status === 'close' && (
                  <span className="adl-pick">
                    {(r.suggestions || []).map((s) => (
                      <button type="button" key={s.id} className="btn btn-sm" onClick={() => pick(i, s.id)}>{`Yes, ${s.name}`}</button>
                    ))}
                  </span>
                )}
                {r.status === 'exists' && (
                  <span className="adl-pick" role="group" aria-label="Old link">
                    <button type="button" className={`btn btn-sm${lines[i] && lines[i].onExisting === 'replace' ? ' btn-primary' : ''}`} onClick={() => choose(i, 'replace')}>Replace</button>
                    <button type="button" className={`btn btn-sm${!lines[i] || lines[i].onExisting !== 'replace' ? ' btn-primary' : ''}`} onClick={() => choose(i, 'keep')}>Keep old</button>
                    <span className="adl-sub">{r.existing ? `Now: ${r.existing.label}${r.existing.addedByName ? `, added by ${r.existing.addedByName}` : ''}` : ''}</span>
                  </span>
                )}
                {rights && rights.canMarkSigned && r.ready && (
                  <label className="adl-mark"><input type="checkbox" checked={!!(lines[i] && lines[i].markSigned)} onChange={(e) => setLine(i, { markSigned: e.target.checked })} /> Mark as signed copy on file</label>
                )}
              </div>
              <div className="adl-cell adl-act" data-l="">
                <button type="button" className="btn btn-sm" onClick={() => startFix(i)}>Fix</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => drop(i)} aria-label={`Leave out line ${r.row}`}>Leave out</button>
              </div>
              {fix === i && fixDraft && (
                <div className="adl-fix">
                  <label className="adl-field"><span>Client name or ID</span><input value={fixDraft.ref} onChange={(e) => setFixDraft({ ...fixDraft, ref: e.target.value })} /></label>
                  <label className="adl-field"><span>Drive link</span><input value={fixDraft.link} onChange={(e) => setFixDraft({ ...fixDraft, link: e.target.value })} /></label>
                  <div className="adl-two">
                    <label className="adl-field"><span>Agreement date</span><input value={fixDraft.agreementDate} onChange={(e) => setFixDraft({ ...fixDraft, agreementDate: e.target.value })} /></label>
                    <label className="adl-field"><span>End date</span><input value={fixDraft.endDate} onChange={(e) => setFixDraft({ ...fixDraft, endDate: e.target.value })} /></label>
                  </div>
                  <div className="adl-fixbtns">
                    <button type="button" className="btn btn-sm btn-primary" onClick={saveFix}>Save and check again</button>
                    <button type="button" className="btn btn-sm" onClick={() => setFix(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        {tip}
        {err && <div className="notice red" role="alert">{err}</div>}
      </>
    );
    foot = (
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" onClick={() => setStep(1)}>← Back</button>
        <button type="button" className="btn btn-primary" disabled={!toAdd.length || busy === 'check'} onClick={addAll}>
          {toAdd.length ? `Add ${toAdd.length} agreement link${toAdd.length === 1 ? '' : 's'}` : 'Nothing to add yet'}
        </button>
      </>
    );
  } else {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 100;
    body = (
      <>
        {steps}
        {busy === 'add' ? (
          <>
            <p className="adl-lead">{`Adding… ${progress.done} of ${progress.total}`}</p>
            <div className="adl-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
          </>
        ) : (
          <>
            <p className="adl-lead"><b>{`${added + replaced} link${added + replaced === 1 ? '' : 's'} saved`}</b>{skipped ? `, ${skipped} left out.` : '.'} The agreements themselves were not changed: the Drive link is saved next to each client.</p>
            <div className="adl-sum">
              {added > 0 && <span className="adl-chip green">{`${added} added`}</span>}
              {replaced > 0 && <span className="adl-chip blue">{`${replaced} replaced`}</span>}
              {skipped > 0 && <span className="adl-chip orange">{`${skipped} skipped`}</span>}
            </div>
          </>
        )}
        {err && <div className="notice red" role="alert">{err}</div>}
        <div className="adl-list">
          {results.map((x, i) => (
            <div className={`adl-row ${x.outcome === 'Skipped' ? 'orange' : 'green'}`} key={`${x.row}-${i}`}>
              <div className="adl-cell adl-no" data-l="Line">{x.row}</div>
              <div className="adl-cell adl-who" data-l="Client"><b>{x.client || '—'}</b></div>
              <div className="adl-cell adl-state" data-l="Result">
                <span className={`adl-chip ${x.outcome === 'Skipped' ? 'orange' : (x.outcome === 'Replaced' ? 'blue' : 'green')}`}>{x.outcome}</span>
                {x.reason && <span className="adl-msg">{x.reason}</span>}
              </div>
            </div>
          ))}
        </div>
      </>
    );
    foot = busy === 'add' ? (
      <button type="button" className="btn" onClick={() => { cancelled.current = true; }}>Stop</button>
    ) : (
      <>
        <button type="button" className="btn" onClick={downloadResult} disabled={!results.length}>⬇ Download result</button>
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </>
    );
  }

  return (
    <Modal title={client ? `Drive link · ${client.name}` : 'Add agreement links (many at once)'} size="wide" onClose={busy === 'add' ? undefined : onClose} footer={foot}>
      <div className="adl">{body}</div>
    </Modal>
  );
}
