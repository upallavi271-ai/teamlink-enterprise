import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Panel, Btn, Pill, Field, DataTable, fmtNum, fmtDateTime } from '../ui.jsx';
import Combo from '../../Combo.jsx';
import { useLoad, Err, SwitchRow, downloadFile } from './adminUtil.jsx';

const WHAT = [['', 'All events'], ['opt_in', 'Opted in'], ['opt_out', 'Opted out'], ['unsubscribe', 'Unsubscribed (link)'], ['stop', 'Replied STOP'], ['erasure', 'Removed at their request']];
const WAYS = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };

function Dlt({ toast }) {
  const sd = useLoad(() => omni.get('/sender-details'), []);
  const [f, setF] = useState(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (sd.data) setF({ smsSenderId: sd.data.details.smsSenderId, smsDltEntityId: sd.data.details.smsDltEntityId }); }, [sd.data]);
  const save = async () => { setBusy(true); setErr(''); try { await omni.put('/settings', f); toast('DLT details saved'); sd.reload(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); } };
  if (!f) return <div className="card panel">{sd.err || 'Loading…'}</div>;
  return (
    <Panel title="DLT registration" sub="TRAI requires every SMS header and template to be registered before it can send." right={<Btn primary onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save DLT details'}</Btn>}>
      <div className="adm-form">
        <Field label="SENDER HEADER (6 LETTERS)" hint="For example TEAMLK, exactly as registered on DLT."><input maxLength={6} value={f.smsSenderId} onChange={(e) => setF({ ...f, smsSenderId: e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase() })} placeholder="TEAMLK" /></Field>
        <Field label="ENTITY ID (PE ID)" hint="10 to 25 digits."><input inputMode="numeric" maxLength={25} value={f.smsDltEntityId} onChange={(e) => setF({ ...f, smsDltEntityId: e.target.value.replace(/\D/g, '') })} placeholder="1201159876543" /></Field>
      </div>
      <Err text={err} />
      <div className="adm-note">One header is saved here. Unregistered headers are blocked by the operator, not by TeamLink. A list of several headers with their approval status is Planned.</div>
    </Panel>
  );
}

function Consent({ toast }) {
  const oo = useLoad(() => omni.get('/gs/admin/settings/optouts'), []);
  const sw = useLoad(() => omni.get('/gs/admin/switches'), []);
  const [err, setErr] = useState('');
  const put = async (v) => { setErr(''); try { await omni.put('/gs/admin/switches', { atsAppliedMeansJobAllowed: v }); toast(v ? 'The rule is ON' : 'The rule is OFF'); sw.reload(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } };
  const exp = async () => { try { await downloadFile('/gs/admin/settings/optouts.csv', {}, 'omni-opt-outs.csv'); toast('Opt-out list exported'); } catch { toast('You cannot download this.'); } };
  const o = oo.data;
  return (
    <Panel title="Consent and opt-out" sub={o && o.ready ? `${fmtNum(o.people)} ${o.people === 1 ? 'contact has' : 'contacts have'} opted out. They are left out when an audience is made, not filtered at import.` : 'Loading…'}
      right={<Btn onClick={exp}>⬇ Export opt-out list</Btn>}>
      <Err text={err || oo.err} />
      {o && o.ready && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {Object.keys(WAYS).map((k) => <Pill key={k} tone="draft">{WAYS[k]}: {fmtNum(o.byChannel[k] || 0)} opted out</Pill>)}
          <Pill tone="draft">Do-not-contact list: {fmtNum(o.doNotContact)}</Pill>
        </div>
      )}
      <div className="adm-row"><div className="adm-row-main"><b>Honour STOP replies and unsubscribe links</b><small>An inbound STOP or UNSUBSCRIBE marks the person and leaves them out of every later send. Built in: it cannot be switched off.</small></div><Pill tone="live" dot>Always on</Pill></div>
      <div className="adm-row"><div className="adm-row-main"><b>A recorded yes before a message</b><small>A person needs a recorded permission for that way before a campaign can message them. Built in.</small></div><Pill tone="live" dot>Always on</Pill></div>
      <div className="adm-row"><div className="adm-row-main"><b>Quiet hours</b><small>Never send at night. Set under Settings &gt; Channels &amp; sending.</small></div><Pill tone="scheduled" dot>See Channels &amp; sending</Pill></div>
      {sw.data && (
        <SwitchRow label="Applied to our requirement = promotion messages allowed" on={sw.data.atsAppliedMeansJobAllowed} onChange={put}
          note="ON: a person copied from the ATS who applied to OUR requirement may get messages about it even though no yes was recorded yet.">
          <div className="adm-warn"><b>Warning.</b> This lets you message people who never agreed to promotions. Opt-outs and the do-not-contact list still win, and staff messages and every other kind of contact still need a recorded yes. Leave it OFF unless you are sure it is right for your business. Every change is written to the audit log.</div>
        </SwitchRow>
      )}
    </Panel>
  );
}

function ConsentLog({ toast }) {
  const [q, setQ] = useState(''); const [qLive, setQLive] = useState('');
  const [action, setAction] = useState(''); const [channel, setChannel] = useState('');
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(25);
  useEffect(() => { const t = setTimeout(() => { setQLive(q); setPage(1); }, 250); return () => clearTimeout(t); }, [q]);
  const p = { q: qLive || undefined, action: action || undefined, channel: channel || undefined };
  const { data, err, loading } = useLoad(() => omni.get('/consent-log', { ...p, page, pageSize }), [qLive, action, channel, page, pageSize]);
  const cols = [
    { id: 'at', label: 'When', render: (r) => fmtDateTime(r.at) },
    { id: 'what', label: 'What happened', render: (r) => <Pill tone={r.action === 'opt_in' ? 'live' : 'red'}>{r.actionWords}</Pill> },
    { id: 'ch', label: 'Way', render: (r) => r.channelWords },
    { id: 'person', label: 'Person', render: (r) => <div><b>{r.name}</b><div style={{ fontSize: 9, color: 'var(--muted)' }}>{[r.contact, r.kind].filter(Boolean).join(' · ')}</div></div> },
    { id: 'who', label: 'Who did it', hide: true, render: (r) => r.who },
    { id: 'src', label: 'Source', hide: true, render: (r) => r.sourceWords },
    { id: 'why', label: 'Why', render: (r) => r.why || '—' },
  ];
  const exp = async () => { try { await downloadFile('/consent-log/export', p, 'outreach-consent-log.csv'); toast('Consent log exported'); } catch { toast('You cannot download the consent log.'); } };
  const n = (k) => (data && data.counts && data.counts[k]) || 0;
  return (
    <Panel title="Consent log" sub="Every time someone said yes or no to a message. It is a record: nothing here can be changed or deleted." right={data && data.canExport ? <Btn onClick={exp}>⬇ Export CSV</Btn> : null}>
      <Err text={err} />
      <DataTable columns={cols} rows={(data && data.events) || []} rowKey={(r) => r.id} loading={loading} emptyText="No events match. When people opt in, opt out or reply STOP, they show here." pageSizes={[10, 25, 50, 100]} searchPlaceholder="Search a name, a source or a reason"
        toolbar={<>
          <Combo className="select" aria-label="What happened" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>{WHAT.map(([v, l]) => <option key={v} value={v}>{v ? `${l} (${n(v)})` : l}</option>)}</Combo>
          <select className="select" aria-label="Way" value={channel} onChange={(e) => { setChannel(e.target.value); setPage(1); }}><option value="">All ways</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></select>
        </>}
        server={{ total: data ? data.total : 0, page, pageSize, onPage: setPage, onPageSize: (v) => { setPageSize(v); setPage(1); }, onQuery: setQ, query: q }} />
    </Panel>
  );
}

export default function SetCompliance({ toast }) { return (<><Dlt toast={toast} /><Consent toast={toast} /><ConsentLog toast={toast} /></>); }
