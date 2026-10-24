import { useEffect, useRef, useState } from 'react';
import MultiPick from '../../MultiPick.jsx';
import { Btn, GsModal, Banner } from '../ui.jsx';
import omni from '../omniApi.js';
import { errText } from './crmUtil.js';

// Import from ATS: an explicit copy of ATS candidates into Customers (Admin and Team Lead). Pick Job, Stage, Department (all searchable), see the counts first,
// then press the button. Only name, phone, email, city, skills and experience are copied: never salary. Every way of contact starts "Not asked".
const Tile = ({ n, l, tone }) => <div style={{ flex: '1 1 130px', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 12px', background: tone === 'green' ? 'var(--green-3)' : '#fafbfa' }}><div style={{ fontSize: 18, fontWeight: 900 }}>{Number(n).toLocaleString('en-IN')}</div><div style={{ fontSize: 9.5, color: 'var(--muted)' }}>{l}</div></div>;

export default function AtsImportModal({ onClose, onDone, toast }) {
  const [opts, setOpts] = useState(null);
  const [jobIds, setJobIds] = useState([]);
  const [stages, setStages] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const seq = useRef(0);
  useEffect(() => { omni.get('/gs/crm/ats/options').then(setOpts).catch((e) => setErr(errText(e, 'The lists could not be loaded.'))); }, []);
  useEffect(() => {
    if (!opts) return undefined;
    const n = seq.current + 1; seq.current = n;
    setBusy('preview');
    const t = setTimeout(() => {
      omni.post('/gs/crm/ats/preview', { jobIds, stages, departments }).then((r) => { if (seq.current === n) { setPv(r); setErr(''); } }).catch((e) => { if (seq.current === n) setErr(errText(e, 'The counts could not be made.')); }).finally(() => { if (seq.current === n) setBusy(''); });
    }, 300);
    return () => clearTimeout(t);
  }, [opts, jobIds, stages, departments]);
  const run = async () => {
    setBusy('run'); setErr('');
    try { const r = await omni.post('/gs/crm/ats/import', { jobIds, stages, departments }); setDone(r); toast(r.ok); onDone(r); } catch (e) { setErr(errText(e, 'The copy failed.')); } finally { setBusy(''); }
  };
  const jobOpts = opts ? opts.jobs.map((j) => ({ value: j.id, label: j.title, sub: [j.client, j.department, j.open ? '' : 'Closed'].filter(Boolean).join(' · ') })) : [];
  return (
    <GsModal title="Import from ATS" sub="Copy candidates we already have in the ATS into Customers. Nothing is sent." width={640} onClose={onClose}
      foot={done ? <Btn primary onClick={onClose}>Done</Btn> : <><Btn onClick={onClose}>Cancel</Btn><Btn primary onClick={run} disabled={!pv || !pv.willAdd || busy === 'run'}>{busy === 'run' ? 'Copying…' : `Add ${pv ? pv.willAddNow.toLocaleString('en-IN') : 0} people`}</Btn></>}>
      {!opts && !err && <p>Loading…</p>}
      {opts && !done && (
        <>
          <div className="field"><label>REQUIREMENT</label><MultiPick options={jobOpts} value={jobIds} onChange={setJobIds} placeholder="Any requirement" emptyText="No requirements." /></div>
          <div className="field" style={{ marginTop: 10 }}><label>STAGE</label><MultiPick options={opts.stages.map((s) => ({ value: s.id, label: s.label }))} value={stages} onChange={setStages} placeholder="Any stage" /></div>
          <div className="field" style={{ marginTop: 10 }}><label>DEPARTMENT</label><MultiPick options={opts.departments.map((d) => ({ value: d, label: d }))} value={departments} onChange={setDepartments} placeholder="Any department" /></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0 8px', opacity: busy === 'preview' ? 0.6 : 1 }}>
            <Tile n={pv ? pv.found : 0} l="Candidates found" /><Tile n={pv ? pv.alreadyInContacts : 0} l="Already in Customers" /><Tile n={pv ? pv.noPhoneOrEmail : 0} l="No phone or email" /><Tile n={pv ? pv.willAdd : 0} l="Will be added" tone="green" />
          </div>
          {pv && pv.doNotContact > 0 && <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: '0 0 6px' }}>{pv.doNotContact} asked not to be contacted, so they are left out.</p>}
          {pv && pv.willAdd > pv.willAddNow && <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: '0 0 6px' }}>One press adds {pv.perRun.toLocaleString('en-IN')} people at most. Press again for the rest.</p>}
          {pv && pv.capped && <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: '0 0 6px' }}>Only the newest applications were looked at. Narrow the Requirement or Stage to see everyone.</p>}
          {pv && pv.sample.length > 0 && <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: '0 0 6px' }}>For example: {pv.sample.slice(0, 5).map((s) => s.name).join(', ')}{pv.willAdd > 5 ? '…' : ''}</p>}
          <Banner>Only name, phone, email, city, skills and experience are copied. Salary is never copied. Every way of contact starts as &quot;Not asked&quot;: you cannot message them until permission is recorded{' '}(or an Admin allows job messages for people who applied to our jobs).</Banner>
        </>
      )}
      {done && (
        <div>
          <Banner tone="ok">{done.ok}</Banner>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Tile n={done.created} l="Added" tone="green" /><Tile n={done.alreadyInContacts} l="Already in Customers" /><Tile n={done.noPhoneOrEmail} l="No phone or email" /></div>
          <p style={{ fontSize: 10, color: 'var(--muted)' }}>You can take this copy back for 7 days from the Imports tab.</p>
        </div>
      )}
      {err && <Banner tone="error">{err}</Banner>}
    </GsModal>
  );
}
