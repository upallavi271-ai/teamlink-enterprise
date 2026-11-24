import { useState } from 'react';
import api from '../../../api';
import { Notice, Section, Table, useLoad, useAction, Field, when, row } from '../kit.jsx';

// ---------------------------------------------------------------------------
// ATS settings -> Privacy & security -> Region & SLA evidence (15.11 / IN-14 / 15.16, ATS wave 2 Z). Where the data really is and what
// uptime is promised are the founder's decisions. This page holds what proves them: the region stated beside what the server itself
// sees (flagged when they disagree), the documents (provider invoice / console page, backup storage region, signed SLA, DPA), the
// founder's confirmation and the month-by-month uptime against the target. "Download the evidence pack" = one page for a client's
// security questionnaire. Backend: utils/atsPlus/evidenceZ.js.
// ---------------------------------------------------------------------------
export default function EvidenceZ() {
  const { data, err, reload } = useLoad('/ats-plus/evidencez');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState({ kind: 'Hosting region', title: '', link: '', docDate: '', note: '' });
  const download = () => run(async () => {
    const r = await api.get('/ats-plus/evidencez/pack', { responseType: 'blob' });
    const u = URL.createObjectURL(r.data); const a = document.createElement('a'); a.href = u; a.download = `teamlink-region-sla-evidence-${new Date().toISOString().slice(0, 10)}.html`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000);
    return r;
  }, 'Downloaded.');
  if (!data) return <Notice tone="red">{err}</Notice>;
  const s = data.seen;
  const conf = data.confirmed;
  return (
    <>
      <Section title="Data region: stated and seen" note="The region is stated by the company (Where data is stored); the right column is read on this server, never typed. A difference is listed under To check." right={<button type="button" className="btn btn-sm" disabled={busy} onClick={download}>Download the evidence pack</button>}>
        <Notice tone="red">{err}</Notice>{flash}
        <Table rows={[
          { id: 'r', k: 'Data region', a: data.stated.region, b: s.hostingRegionEnv ? `HOSTING_REGION = ${s.hostingRegionEnv}` : 'not set on the server' },
          { id: 't', k: 'Time zone', a: '—', b: `${s.timeZone} (UTC${s.utcOffsetMinutes >= 0 ? '+' : ''}${s.utcOffsetMinutes / 60})` },
          { id: 'd', k: 'Database', a: [data.stated.provider, data.stated.city].filter(Boolean).join(', ') || '—', b: `${s.database.engine}${s.database.onThisServer ? " on this server's own disk" : ''}` },
          { id: 'b', k: 'Backups', a: data.stated.backupLocation, b: `${s.backupSets} copy set(s) on this server${s.backup.latestAt ? `, newest ${when(s.backup.latestAt)}` : ''}` },
          { id: 'o', k: 'Off-site copy', a: data.stated.backupProvider || '—', b: s.offsite.set ? `encrypted, ${s.offsite.storageHost || ''}${s.offsite.region ? ` (${s.offsite.region})` : ''}` : 'not set up' },
        ]} cols={[{ key: 'k', label: '' }, { key: 'a', label: 'Stated' }, { key: 'b', label: 'Seen on the server' }]} />
        {data.flags.length > 0 && <Notice tone="amber"><b>To check:</b><ul style={{ margin: '4px 0 0 18px' }} data-testid="evidence-flags">{data.flags.map((x) => <li key={x}>{x}</li>)}</ul></Notice>}
        <div style={{ ...row, marginTop: 6 }} data-testid="evidence-confirm">
          <span>Founder confirmation: region <b>{conf.residency ? `${conf.residency.by}, ${when(conf.residency.at)}` : 'not yet'}</b> · SLA <b>{conf.sla ? `${conf.sla.by}, ${when(conf.sla.at)}` : 'not yet'}</b></span>
          {data.canConfirm && <><button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post('/ats-plus/evidencez/confirm', { what: 'residency' }), 'Region confirmed.')}>Confirm the region</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post('/ats-plus/evidencez/confirm', { what: 'sla' }), 'SLA confirmed.')}>Confirm the SLA</button></>}
        </div>
      </Section>
      <Section title="Uptime against the target, month by month" note={`Target ${data.sla.uptimeTarget}% · support ${data.sla.supportHours} · P1 ${data.sla.response.P1}, P2 ${data.sla.response.P2}, P3 ${data.sla.response.P3}. Measured from this server's own health samples and the outside check's outages.`}>
        <Table rows={data.sla.months} rowKey={(r) => r.month} cols={[{ key: 'month', label: 'Month' }, { key: 'uptimePct', label: 'Uptime', render: (r) => (r.uptimePct === null ? 'not measured' : `${r.uptimePct}%`) }, { key: 'outageMinutes', label: 'Minutes down' }, { key: 'met', label: 'Target met', render: (r) => (r.met === null ? '—' : r.met ? 'Yes' : 'No') }]} />
      </Section>
      <Section title="Evidence documents" note={data.missing.length ? `Still missing: ${data.missing.join(', ')}.` : 'The hosting region, the backup location and the SLA contract each have a document.'}>
        <Table rows={data.items} empty="No document yet." cols={[{ key: 'kind', label: 'Kind' }, { key: 'title', label: 'Document', render: (r) => (r.link ? <a href={r.link} target="_blank" rel="noreferrer">{r.title}</a> : r.title) }, { key: 'docDate', label: 'Dated', render: (r) => r.docDate || '—' }, { key: 'by', label: 'Added by', render: (r) => `${r.by || '—'}, ${when(r.at)}` },
          { key: 'x', label: '', render: (r) => (data.canEdit ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => run(() => api.delete(`/ats-plus/evidencez/items/${r.id}`), 'Removed.')}>Remove</button> : null) }]} />
        {data.canEdit && (
          <div className="card" style={{ padding: 10, marginTop: 8 }}>
            <div className="grid-2">
              <Field label="Kind"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{data.kinds.map((k) => <option key={k}>{k}</option>)}</select></Field>
              <Field label="What it is"><input value={f.title} placeholder="e.g. Hosting invoice, data centre Mumbai" onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
              <Field label="Link (https://)"><input value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} /></Field>
              <Field label="Dated"><input type="date" value={f.docDate} onChange={(e) => setF({ ...f, docDate: e.target.value })} /></Field>
            </div>
            <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || f.title.length < 3} onClick={() => run(() => api.post('/ats-plus/evidencez/items', f), 'Added.').then((d) => { if (d) setF({ ...f, title: '', link: '', note: '' }); })}>Add the document</button>
          </div>
        )}
      </Section>
    </>
  );
}
