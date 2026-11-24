// The "Web & engagement" tab of a lead / deal / customer (CRM wave B, 2026-11-24): email opens and clicks, calls on the office line (recording,
// what was said, a recording from your own phone to transcribe), documents the customer opened, website pages viewed, social profiles,
// an NPS / CSAT survey, the customer portal login, what they chose in the preference centre.
import { useState } from 'react';
import api from '../../../api';
import { useCrm, errOf, dateTimeOf } from '../crmShared.jsx';
import { useLoad, ago } from './bShared.jsx';
import { InviteForm } from './CrmPortalAdmin.jsx';

const Box = ({ title, children, right }) => <div className="card" style={{ padding: 12, marginBottom: 12 }}><div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}><div className="section-label" style={{ margin: 0, flex: 1 }}>{title}</div>{right}</div>{children}</div>;
const mmss = (s) => `${Math.floor((Number(s) || 0) / 60)}:${String((Number(s) || 0) % 60).padStart(2, '0')}`;

function Calls({ kind, id, canEdit }) {
  const { toast } = useCrm();
  const { data, reload } = useLoad(`/crm/b/calls/of/${kind}/${id}`);
  const [said, setSaid] = useState(null);
  const [audio, setAudio] = useState({});
  const [busy, setBusy] = useState(false);
  async function show(c) { try { const r = await api.get(`/crm/b/calls/${c.id}/transcript`); setSaid({ id: c.id, ...r.data }); } catch (e) { toast(errOf(e, 'Not available.')); } }
  async function play(c) { try { const r = await api.get(`/crm/b/calls/${c.id}/recording`, { responseType: 'blob' }); setAudio((a) => ({ ...a, [c.id]: URL.createObjectURL(r.data) })); } catch (e) { toast('There is no recording of this call.'); } }
  async function upload(e) {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    setBusy(true);
    try { await api.post(`/crm/b/calls/upload?kind=${kind}&id=${encodeURIComponent(id)}&name=${encodeURIComponent(f.name)}`, f, { headers: { 'Content-Type': 'application/octet-stream' } }); toast('Transcribed: it is on the timeline.'); reload(); } catch (err) { toast(errOf(err, 'It could not be transcribed.')); } finally { setBusy(false); }
  }
  return (
    <Box title="Calls on the office line" right={canEdit && <label className="btn btn-sm" style={{ margin: 0 }} title="A call you made from your own phone: its recording is turned into words on the timeline">{busy ? 'Transcribing…' : 'Transcribe a recording'}<input type="file" accept="audio/*,.wav,.mp3,.m4a,.amr,.ogg" onChange={upload} style={{ display: 'none' }} /></label>}>
      {data && !data.calls.length && <div className="small-muted">No calls from the browser yet. Use Call → "Call from the browser".</div>}
      {(data ? data.calls : []).map((c) => (
        <div key={c.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ flex: 1 }}>{dateTimeOf(c.at)} · {c.by} · {c.number} · {c.status}{c.talkSec ? ` · talk ${mmss(c.talkSec)}` : ''}{c.line ? ` · ${c.line}` : ''}</span>
            {data.mayListen && c.hasRecording && !audio[c.id] && <button type="button" className="btn btn-sm" onClick={() => play(c)}>▶ Play</button>}
            {data.mayListen && c.hasTranscript && <button type="button" className="btn btn-sm" onClick={() => show(c)}>What was said</button>}
          </div>
          {audio[c.id] && <audio controls src={audio[c.id]} style={{ width: '100%', marginTop: 4 }} />}
          {c.summary && <div className="small-muted" style={{ fontSize: 12.5 }}>{c.summary}</div>}
          {said && said.id === c.id && <div className="card" style={{ padding: 8, marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 12.5, maxHeight: 240, overflow: 'auto' }}>{said.transcript || 'No transcript.'}<div className="small-muted" style={{ fontSize: 11 }}>{said.source}</div></div>}
        </div>
      ))}
    </Box>
  );
}

function Survey({ kind, id }) {
  const { toast } = useCrm();
  const [busy, setBusy] = useState('');
  async function send(type) { setBusy(type); try { await api.post('/crm/b/surveys', { kind, id, type }); toast('Survey sent.'); } catch (e) { toast(errOf(e, 'Not sent.')); } finally { setBusy(''); } }
  return (
    <Box title="Ask how we did">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => send('nps')}>{busy === 'nps' ? 'Sending…' : 'Send NPS survey (0-10)'}</button>
        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => send('csat')}>{busy === 'csat' ? 'Sending…' : 'Send CSAT survey (1-5)'}</button>
      </div>
      <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>One email with a link; the answer comes on the timeline. Results: Accounts &amp; Contacts → Customer portal → Surveys.</div>
    </Box>
  );
}

function Social({ row, canEdit }) {
  const { toast } = useCrm();
  const [f, setF] = useState({ linkedinUrl: row.linkedinUrl || '', twitterUrl: row.twitterUrl || '', facebookUrl: row.facebookUrl || '' });
  async function save() { try { await api.put(`/crm/b/leads/${row.id}/social`, f); toast('Saved.'); } catch (e) { toast(errOf(e, 'Not saved.')); } }
  return (
    <Box title="Social profiles">
      <div className="grid-3">{[['linkedinUrl', 'LinkedIn'], ['twitterUrl', 'X / Twitter'], ['facebookUrl', 'Facebook']].map(([k, l]) => (
        <div key={k} className="field"><label>{l}</label>{canEdit ? <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder="https://" /> : (f[k] ? <a href={f[k]} target="_blank" rel="noopener noreferrer">{f[k]}</a> : <span className="small-muted">—</span>)}</div>
      ))}</div>
      {canEdit && <button type="button" className="btn btn-sm" onClick={save}>Save</button>}
    </Box>
  );
}

export default function RecordEngage({ kind, row, d }) {
  const id = row.id;
  const track = useLoad(`/crm/b/tracking/${kind}/${id}`);
  const visits = useLoad(kind === 'lead' ? `/crm/b/leads/${id}/visits` : null);
  const docs = useLoad(kind === 'deal' ? `/crm/b/deals/${id}/doc-views` : null);
  const portal = useLoad(kind === 'account' ? '/crm/b/portal-users' : null, { accountId: id });
  const email = kind === 'lead' ? row.email : (kind === 'contact' ? row.email : null);
  const prefs = useLoad(email ? '/crm/b/prefs' : null, { email });
  const canEdit = !!(d && d.canEdit);
  return (
    <div>
      <Box title="Emails opened">
        {track.data && !track.data.on && <div className="small-muted" style={{ fontSize: 12, marginBottom: 6 }}>Email open and click tracking is switched off (an Admin switches it on in CRM settings).</div>}
        {track.data && !track.data.mails.length && <div className="small-muted">No tracked emails yet.</div>}
        {(track.data ? track.data.mails : []).map((m, i) => (
          <div key={i} style={{ padding: '5px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ flex: 1 }}>{m.subject || '(no subject)'} <span className="small-muted">· {m.campaignId ? 'campaign · ' : ''}{dateTimeOf(m.sentAt)}</span></span>
            {m.opened ? <span className="status joined">Opened {m.openCount}× · last {ago(m.lastOpenAt)}</span> : <span className="status review">Not opened yet</span>}
            {Number(m.clickCount) > 0 && <span className="status pending">{m.clickCount} click{Number(m.clickCount) === 1 ? '' : 's'}</span>}
          </div>
        ))}
      </Box>
      <Calls kind={kind} id={id} canEdit={canEdit} />
      {kind === 'deal' && (
        <Box title="Documents the customer opened">
          {docs.data && !docs.data.docs.length && <div className="small-muted">Nothing opened yet. Proposals sent by email and files shared by link are counted.</div>}
          {(docs.data ? docs.data.docs : []).map((x, i) => <div key={i} style={{ fontSize: 13, padding: '4px 0' }}>{x.what} · <b>{x.views}×</b> <span className="small-muted">· first {dateTimeOf(x.firstAt)} · last {dateTimeOf(x.lastAt)}</span></div>)}
        </Box>
      )}
      {kind === 'lead' && (
        <Box title="Pages viewed on the website">
          {visits.data && !visits.data.on && <div className="small-muted" style={{ fontSize: 12, marginBottom: 6 }}>Website visit tracking is switched off.</div>}
          {visits.data && !visits.data.visits.length && <div className="small-muted">No visits seen for this lead.</div>}
          {(visits.data ? visits.data.visits : []).slice(0, 40).map((v, i) => <div key={i} style={{ fontSize: 12.5, padding: '3px 0', wordBreak: 'break-all' }}><span className="small-muted">{dateTimeOf(v.at)}</span> · {v.title || v.url}{v.utmCampaign ? <span className="small-muted"> · {v.utmCampaign}</span> : null}</div>)}
        </Box>
      )}
      {kind === 'lead' && <Social row={row} canEdit={canEdit} />}
      {canEdit && <Survey kind={kind} id={id} />}
      {kind === 'account' && (
        <Box title="Customer portal">
          {portal.data && portal.data.users.map((u) => <div key={u.id} style={{ fontSize: 13, padding: '3px 0' }}>{u.name || u.email} · {u.email} · <b>{u.status}</b>{u.lastLoginAt ? <span className="small-muted"> · signed in {ago(u.lastLoginAt)}</span> : null}</div>)}
          {canEdit && <InviteForm accountId={id} contacts={(d && d.contacts) || []} onDone={portal.reload} />}
        </Box>
      )}
      {prefs.data && (
        <Box title="What they want from us (preference centre)">
          <div style={{ fontSize: 13 }}>{prefs.data.prefs.unsubscribed ? <b style={{ color: 'var(--red)' }}>Unsubscribed from email. </b> : null}Topics: {prefs.data.prefs.topics.filter((t) => t.on).map((t) => t.name).join(', ') || 'none'} · Email {prefs.data.prefs.channels.email === false ? 'no' : 'yes'}, WhatsApp {prefs.data.prefs.channels.whatsapp === false ? 'no' : 'yes'}, SMS {prefs.data.prefs.channels.sms === false ? 'no' : 'yes'}</div>
        </Box>
      )}
    </div>
  );
}
