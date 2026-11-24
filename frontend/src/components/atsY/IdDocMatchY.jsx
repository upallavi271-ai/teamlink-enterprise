import { useState } from 'react';
import api from '../../api';
import { Flash, Empty, useGet, useRun, when } from '../mktb/kit.jsx';

// ---------------------------------------------------------------------------
// 15.14 ID DOCUMENT MATCH (ATS wave 2 Y) inside "IDs & consent": an ID document (a saved one, an upload, or the words typed off the card)
// read against the profile: name, date of birth, PAN / Aadhaar (vs IDs & consent). Every number is shown masked; the text is never kept.
// ---------------------------------------------------------------------------
const Y = '/ats/y';
const tone = (v) => (/^match|year matches/.test(v || '') ? 'good' : (/no match/.test(v || '') ? 'bad' : 'new'));

function Result({ r }) {
  return (
    <div className="mkb-q" data-testid="atsy-idmatch-result">
      <div className="mkb-row"><b>{r.docKind}</b><span className={`mkb-score ${/^Matches/.test(r.verdict) ? 'good' : (/^Does not/.test(r.verdict) ? 'bad' : '')}`}>{`${r.verdict} (${r.score})`}</span><span className="small-muted">{`read from ${r.readBy}`}</span></div>
      <ul className="mkb-list">
        <li><b>Name</b><span className="mkb-grow small-muted">{r.name.found || ''}</span><span className={`mkb-chip ${tone(r.name.verdict)}`}>{r.name.verdict}</span></li>
        <li><b>Date of birth</b><span className="mkb-grow small-muted">{`on the document: ${r.dob.document}`}</span><span className={`mkb-chip ${tone(r.dob.verdict)}`}>{r.dob.verdict}</span></li>
        {(r.ids || []).map((i) => <li key={i.kind + i.document}><b>{i.kind}</b><span className="mkb-grow small-muted">{`${i.document}${i.saved ? ` · saved ${i.saved}` : ''}`}</span><span className={`mkb-chip ${tone(i.verdict)}`}>{i.verdict}</span></li>)}
        {!(r.ids || []).length && <li className="small-muted">No ID number was found on the document.</li>}
      </ul>
    </div>
  );
}

export default function IdDocMatchY({ c }) {
  const h = useGet(`${Y}/candidates/${c.id}/id-match`);
  const [doc, setDoc] = useState('');
  const [typed, setTyped] = useState('');
  const [needsText, setNeedsText] = useState(false);
  const [last, setLast] = useState(null);
  const { busy, msg, run } = useRun();
  const done = (r) => { if (r) { setLast(r.data); h.reload(); } };
  const fail = (p) => p.catch((e) => { if (e && e.response && e.response.data && e.response.data.needsText) setNeedsText(true); throw e; });
  const upload = (file) => run(() => { const fd = new FormData(); fd.append('file', file); return fail(api.post(`${Y}/candidates/${c.id}/id-match`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })); }, 'Checked.').then(done);
  const d = h.data;
  if (h.error) return null;
  return (
    <div style={{ margin: '10px 0' }} data-testid="atsy-idmatch">
      <b>ID document check</b>
      <div className="small-muted">Name, date of birth and the PAN / Aadhaar on an ID document compared with this profile. Numbers are shown masked and the document text is not kept.</div>
      {!d && <Empty>Loading…</Empty>}
      {d && d.canRun && (
        <div className="mkb-row" style={{ flexWrap: 'wrap', margin: '6px 0' }}>
          {d.documents.length > 0 && (
            <>
              <select value={doc} onChange={(e) => setDoc(e.target.value)} aria-label="Saved document"><option value="">A saved document…</option>{d.documents.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
              <button type="button" className="btn btn-sm" disabled={busy || !doc} onClick={() => run(() => fail(api.post(`${Y}/candidates/${c.id}/id-match`, { documentId: doc })), 'Checked.').then(done)}>Check it</button>
            </>
          )}
          <label className="btn btn-sm">Upload an ID<input type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(e) => e.target.files[0] && upload(e.target.files[0])} /></label>
          <button type="button" className="mkb-link" onClick={() => setNeedsText(true)}>Type what the card says</button>
        </div>
      )}
      {d && d.canRun && needsText && (
        <div>
          <textarea rows={3} style={{ width: '100%' }} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="The name, date of birth and number as printed on the card" aria-label="Words on the card" />
          <button type="button" className="btn btn-sm" disabled={busy || typed.trim().length < 6} onClick={() => run(() => api.post(`${Y}/candidates/${c.id}/id-match`, { text: typed }), 'Checked.').then((r) => { done(r); if (r) setTyped(''); })}>Check the typed words</button>
        </div>
      )}
      <Flash msg={msg} />
      {last && <Result r={last} />}
      {d && d.history.length > 0 && (
        <ul className="mkb-list">{d.history.slice(0, 6).map((x) => <li key={x.id}><span className="mkb-grow">{`${x.docKind}: ${x.verdict} (${x.score})`}</span><span className="small-muted">{`${x.byName} · ${when(x.at)}`}</span></li>)}</ul>
      )}
    </div>
  );
}
