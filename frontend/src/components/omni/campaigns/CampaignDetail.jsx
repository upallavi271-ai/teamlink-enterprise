import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Banner, Btn, ConfirmModal, DataTable, Field, GsModal, PageHead, Panel, Pill } from '../ui.jsx';
import CallTasks from './CallTasks.jsx';
import { CH_WORD, PromptModal, fmtWhen, n0 } from './shared.jsx';

const TABS = [['overview', 'Overview'], ['content', 'Content'], ['audience', 'Audience'], ['channels', 'Channels'], ['activity', 'Activity'], ['replies', 'Replies'], ['conversions', 'Conversions']];
const CHIP = { whatsapp: ['wa', 'WA'], sms: ['mail', 'SM'], email: ['mail', '@'], call: ['ig', '☎'] };

const Metric = ({ label, value, meta, up = true }) => <div className="card metric"><small>{label}</small><b>{value}</b>{meta ? <span className={`kpi-meta ${up ? 'up' : ''}`}>{meta}</span> : null}</div>;

// the Schedule send modal: date + time in India time
function ScheduleModal({ onCancel, onSubmit, busy }) {
  const tomorrow = new Date(Date.now() + 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
  const [date, setDate] = useState(tomorrow);
  const [time, setTime] = useState('10:00');
  const [err, setErr] = useState('');
  const go = () => { if (!date || !time) { setErr('Pick a date and time first'); return; } onSubmit(`${date}T${time}:00+05:30`); };
  return (
    <GsModal title="Schedule send" sub="Pick a date and time to send this campaign." width={420} onClose={onCancel} foot={<><Btn onClick={onCancel}>Cancel</Btn><Btn primary disabled={busy} onClick={go}>📅 Schedule send</Btn></>}>
      <div className="form-grid"><Field label="DATE"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field><Field label="TIME (IST)"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field></div>
      <p style={{ fontSize: 10.5, color: 'var(--muted)' }}>All times are in India Standard Time (Asia/Kolkata). A time inside quiet hours moves to when quiet hours end.</p>
      {err && <div className="cmp-err">{err}</div>}
    </GsModal>
  );
}
function NoteModal({ title, label, okLabel, onCancel, onSubmit, busy }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  return (
    <GsModal title={title} width={460} onClose={onCancel} foot={<><Btn onClick={onCancel}>Cancel</Btn><Btn primary disabled={busy} onClick={() => { if (v.trim().length < 5) { setErr('Write a few words so the person knows what to change.'); return; } onSubmit(v.trim()); }}>{okLabel}</Btn></>}>
      <div className="field"><label>{label}</label><textarea autoFocus rows={4} value={v} maxLength={300} onChange={(e) => { setV(e.target.value); setErr(''); }} />{err && <small style={{ color: '#b3261e' }}>{err}</small>}</div>
    </GsModal>
  );
}

// the campaign command center: seven tabs of real data
export default function CampaignDetail({ campaignKey, onBack, onAnalytics, onEdit, onLogs, onOpen }) {
  const { go, toast } = useOmni();
  const [sp, setSp] = useSearchParams();
  const tab = TABS.some(([t]) => t === sp.get('dt')) ? sp.get('dt') : 'overview';
  const setTab = (t) => { const n = new URLSearchParams(sp); n.set('dt', t); setSp(n, { replace: true }); };
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState(null);
  const [master, setMaster] = useState('');
  const [aud, setAud] = useState(null); const [audPage, setAudPage] = useState(1); const [audPs, setAudPs] = useState(10); const [audQ, setAudQ] = useState('');
  const [rep, setRep] = useState(null);

  const load = useCallback(async () => {
    try { const x = await omni.get(`/gs/campaigns/campaign/${campaignKey}`); setD(x); setMaster((m) => (m === '' ? x.content.masterMessage : m)); setErr(''); } catch (e) { setErr(errOf(e, 'This campaign could not be opened.')); }
  }, [campaignKey]);
  useEffect(() => { setD(null); setMaster(''); load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    if (tab !== 'audience') return undefined;
    let on = true;
    omni.get(`/gs/campaigns/campaign/${campaignKey}/audience`, { page: audPage, pageSize: audPs, q: audQ }).then((x) => { if (on) setAud(x); }).catch(() => { if (on) setAud({ people: [], total: 0, page: 1, pageSize: audPs }); });
    return () => { on = false; };
  }, [tab, campaignKey, audPage, audPs, audQ]);
  useEffect(() => {
    if (tab !== 'replies') return;
    omni.get(`/gs/campaigns/campaign/${campaignKey}/replies`).then(setRep).catch(() => setRep({ total: 0, replies: [] }));
  }, [tab, campaignKey]);

  const run = async (fn, okText) => { setBusy(true); try { const r = await fn(); toast(okText || r.ok || r.message || 'Done'); await load(); return r; } catch (e) { toast(errOf(e, 'That did not work.')); return null; } finally { setBusy(false); setDlg(null); } };
  if (err) return <div><Btn onClick={onBack}>← Campaigns</Btn><Banner tone="error">{err}</Banner></div>;
  if (!d) return <div className="card panel">Loading…</div>;
  const c = d.campaign; const can = c.can; const base = `/gs/campaigns/campaign/${campaignKey}`;
  const hasChannel = (ch) => c.channels.some((x) => x.channel === ch);

  const send = (when, at) => run(() => omni.post(`${base}/${when === 'at' ? 'schedule' : 'send'}`, { when, at }));
  const headButtons = (
    <>
      <Btn onClick={onBack}>← Campaigns</Btn>
      {can.duplicate && <Btn onClick={() => setDlg({ t: 'dup' })}>Duplicate</Btn>}
      {can.edit && <Btn onClick={() => onEdit(campaignKey)}>Edit</Btn>}
      <Btn onClick={() => onAnalytics(campaignKey)}>Analytics</Btn>
      {can.approve && <Btn primary disabled={busy} onClick={() => run(() => omni.post(`${base}/approve`, { note: '' }))}>Approve</Btn>}
      {can.reject && <Btn danger disabled={busy} onClick={() => setDlg({ t: 'reject' })}>Send back</Btn>}
      {can.submit && <Btn primary disabled={busy} onClick={() => run(() => omni.post(`${base}/submit`))}>Ask for approval</Btn>}
      {can.send && <Btn primary disabled={busy} onClick={() => setDlg({ t: 'send' })}>Send now</Btn>}
      {can.send && <Btn disabled={busy} onClick={() => setDlg({ t: 'schedule' })}>Schedule send</Btn>}
      {can.pause && <Btn primary={!can.send} disabled={busy} onClick={() => run(() => omni.post(`${base}/pause`))}>Pause campaign</Btn>}
      {can.resume && !can.pause && <Btn primary disabled={busy} onClick={() => run(() => omni.post(`${base}/resume`))}>Resume campaign</Btn>}
    </>
  );
  const o = d.overview;
  return (
    <div>
      <PageHead eyebrow="Campaign command center" title={c.name} lead="Live campaign overview, content, audience, delivery and conversion performance.">{headButtons}</PageHead>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '-4px 0 10px' }}>
        <Pill tone={c.statusTone} dot>{c.statusWords}</Pill>
        <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{c.objective}{c.job ? ` · ${c.job.title}${c.job.reqCode ? ` (${c.job.reqCode})` : ''}` : ''} · made by {c.createdByName || '—'}</span>
        {c.channels.map((x) => <span key={x.id} className="tag">{x.words}</span>)}
        {can.sendBlocked && <span style={{ fontSize: 10.5, color: '#8a6410' }}>Send is blocked: {can.sendBlocked}</span>}
      </div>
      {d.testMode && <Banner tone="test"><b>Test mode is ON.</b> Anything sent from here is a rehearsal: made and logged, but not really sent.</Banner>}
      {c.approval === 'waiting' && <Banner tone="warn"><b>Waiting for approval.</b> A Team Lead has to approve this before it can be sent.</Banner>}
      {c.approval === 'changes' && <Banner tone="error"><b>Changes needed.</b> {c.approvalBy} sent it back{c.approvalNote ? `: ${c.approvalNote}` : '.'} Change it, then ask for approval again.</Banner>}
      {c.approval === 'approved' && c.status === 'notsent' && <Banner tone="ok"><b>Approved</b>{c.approvalBy ? ` by ${c.approvalBy}` : ''}. It can be sent now.</Banner>}
      <div className="steps">{d.steps.map((s) => <div key={s.n} className={`step ${s.state}`} data-n={s.n}><b>{s.title}</b><small>{s.small}</small></div>)}</div>
      <div className="cd-tabs" role="tablist">{TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={`cd-tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>{label}</button>)}</div>

      {tab === 'overview' && (
        <div>
          <div className="grid metric-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
            <Metric label={c.hasCall && !c.channels.some((x) => x.channel !== 'call') ? 'Calls made' : 'Reach'} value={n0(c.hasCall && !c.channels.some((x) => x.channel !== 'call') ? o.called : o.reach)} meta={o.reachNote} up={false} />
            <Metric label="Delivered" value={n0(o.delivered)} meta={o.deliveredNote} up={o.delivered > 0} />
            <Metric label="Engagement" value={n0(o.engaged)} meta={o.engagementNote} up={o.engaged > 0} />
            <Metric label="Conversions" value={n0(o.conversions)} meta={o.conversionsNote} up={o.conversions > 0} />
          </div>
          {o.rehearsal && <p style={{ fontSize: 10.5, color: '#8a6410', marginTop: 10 }}>These numbers come from a rehearsal: nothing was really sent.</p>}
          {c.hasCall && o.toCall > 0 && <p style={{ fontSize: 11, marginTop: 10 }}>{o.toCall} {o.toCall === 1 ? 'call is' : 'calls are'} still waiting. <button type="button" className="link-btn" onClick={() => setTab('channels')}>Open the call list →</button></p>}
          {d.channels.filter((x) => x.why).map((x) => <Banner key={x.campaignId} tone={x.why.level === 'stop' ? 'error' : 'warn'}><b>{x.words}:</b> {x.why.words}{x.why.fix ? ` ${x.why.fix}` : ''}</Banner>)}
          {can.resend && <div style={{ marginTop: 12 }}><Btn disabled={busy} onClick={() => run(() => omni.post(`${base}/resend`))}>Send the failed ones again</Btn></div>}
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}><Btn onClick={() => onLogs(campaignKey)}>☰ View Detailed Logs</Btn>{can.stop && c.status !== 'notsent' && <Btn danger disabled={busy} onClick={() => setDlg({ t: 'stop' })}>Stop campaign</Btn>}{can.remove && <Btn danger disabled={busy} onClick={() => setDlg({ t: 'del' })}>Delete campaign</Btn>}</div>
        </div>
      )}

      {tab === 'content' && (
        <div className="grid detail-layout">
          <div>
            <div className="card detail-card" style={{ padding: 18 }}>
              <div className="panel-top"><div><div className="panel-title">Master content</div><div className="panel-sub">One source message, adapted to every channel.</div></div><Btn onClick={() => go('studio')}>Open Content Studio</Btn></div>
              <div className="editor">
                <div className="editor-top"><strong>{c.name} • Source message</strong>{d.content.editable && <div className="toolbar-icons"><button type="button" className="tool" title="Save source message" onClick={() => run(() => omni.put(`${base}/master`, { text: master }), 'Source message saved')}>💾</button></div>}</div>
                {d.content.editable
                  ? <textarea rows={6} style={{ width: '100%', border: 0, padding: 12, font: 'inherit', fontSize: 11 }} value={master} onChange={(e) => setMaster(e.target.value)} aria-label="Source message" />
                  : <div className="cmp-msg" style={{ padding: 12 }}>{d.content.masterMessage || 'No master message was written. Each channel sends its own message (below).'}{d.content.cta ? `\n\nCTA: ${d.content.cta}` : ''}</div>}
              </div>
              <div className="grid preview-grid" style={{ marginTop: 14 }}>
                {d.content.versions.map((v) => (
                  <div key={v.campaignId} className="preview">
                    <div className="preview-head"><i className={CHIP[v.channel] ? CHIP[v.channel][0] : 'mail'}>{CHIP[v.channel] ? CHIP[v.channel][1] : '?'}</i> {v.words} version</div>
                    <div className="preview-body"><div className="cmp-msg">{v.subject ? <b>{v.subject}{'\n\n'}</b> : null}{v.body || 'No message picked yet.'}</div>{v.templateName && <span className="cmp-sub" style={{ marginTop: 8 }}>Message: {v.templateName}{v.waTemplateName ? ` · Meta template ${v.waTemplateName}` : ''} · shown with a sample name</span>}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <aside>
            <div className="card sidebar-card"><div className="panel-title">Delivery</div><div className="panel-sub">Channel-level execution</div>
              <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
                {d.content.delivery.map((x) => <div key={x.channel}><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, fontWeight: 850 }}><span>{x.words}</span><span>{x.pct == null ? '—' : `${x.pct}%`}</span></div><div className="bar" style={{ marginTop: 5 }}><span style={{ width: `${x.pct || 0}%` }} /></div><small style={{ fontSize: 8, color: 'var(--muted)' }}>{x.basis === 'called' ? 'called' : x.basis} · {x.sent} done · {x.failed} failed · {x.waiting} waiting</small></div>)}
              </div>
            </div>
            <div className="card sidebar-card" style={{ marginTop: 16 }}><div className="panel-title">Campaign activity</div>
              <div className="timeline">{d.content.activity.length ? d.content.activity.map((a, i) => <div key={i} className="timeline-row"><i className="timeline-dot" /><div><b>{a.title}</b><small>{fmtWhen(a.at)}{a.detail ? ` · ${a.detail}` : ''}</small></div></div>) : <small style={{ color: 'var(--muted)' }}>Nothing has happened yet.</small>}</div>
            </div>
            <div className="card sidebar-card" style={{ marginTop: 16 }}><div className="panel-title">Quick actions</div><div className="actions" style={{ marginTop: 11 }}><Btn onClick={() => setTab('replies')}>View replies</Btn><Btn onClick={() => onAnalytics(campaignKey)}>Open analytics</Btn></div></div>
          </aside>
        </div>
      )}

      {tab === 'audience' && (
        <Panel title="Audience" sub={aud && aud.resolved ? 'Who this campaign was resolved against when it launched.' : 'Who is in the groups right now (the campaign is not sent yet).'} right={<Btn onClick={() => go('segments')}>Manage segments →</Btn>}>
          <DataTable
            columns={[{ id: 'name', label: 'Contact', render: (r) => <b>{r.name}</b> }, { id: 'phone', label: 'Phone', render: (r) => <span className="cmp-phone">{r.phone || '—'}</span> }, { id: 'source', label: 'Source', render: (r) => r.source || '—' }, { id: 'stage', label: 'Stage', render: (r) => r.stage || '—' }]}
            rows={aud ? aud.people : []} rowKey={(r) => r.id || r.name} empty="No contacts resolved." loading={!aud} searchPlaceholder="Search by name..."
            server={{ total: aud ? aud.total : 0, page: audPage, pageSize: audPs, onPage: setAudPage, onPageSize: (n) => { setAudPs(n); setAudPage(1); }, query: audQ, onQuery: (v) => { setAudQ(v); setAudPage(1); } }} />
          {aud && aud.masked && <p style={{ fontSize: 10, color: 'var(--muted)' }}>Phone numbers are hidden for your login.</p>}
        </Panel>
      )}

      {tab === 'channels' && (
        <div>
          <Panel title="Channel delivery" sub="Per-channel execution for this campaign.">
            <div className="table-scroll" style={{ marginTop: 12 }}>
              <table className="table cmp-table-small">
                <thead><tr><th>Channel</th><th>Template</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Status</th></tr></thead>
                <tbody>
                  {d.channels.map((x) => (
                    <tr key={x.campaignId}>
                      <td><b>{x.words}</b>{x.mode === 'rehearsal' && <span className="cmp-test">Test</span>}{x.perMinute ? <span className="cmp-sub">{x.perMinute} a minute</span> : null}</td>
                      <td style={{ overflowWrap: 'anywhere' }}>{x.templateName || '—'}</td>
                      <td>{n0(x.channel === 'call' ? x.called : x.sent)}{x.failed ? <span className="cmp-sub" style={{ color: 'var(--red)' }}>{x.failed} {x.channel === 'call' ? 'no answer' : 'failed'}</span> : null}{x.waiting ? <span className="cmp-sub">{x.waiting} {x.channel === 'call' ? 'to call' : 'waiting'}</span> : null}</td>
                      <td>{x.channel === 'call' ? '—' : n0(x.delivered)}</td><td>{x.channel === 'call' ? '—' : n0(x.read)}</td>
                      <td><Pill tone={x.statusTone}>{x.statusWords}</Pill>{x.why && <span className="cmp-sub">{x.why.words}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          {hasChannel('call') && <CallTasks campaignKey={campaignKey} onChanged={load} />}
        </div>
      )}

      {tab === 'activity' && (
        <Panel title="Activity" sub="Everything this campaign has done, newest last.">
          <div className="cd-timeline">{d.activity.length ? d.activity.map((a, i) => <div key={i} className="cd-ev"><b>{a.title}</b><small>{fmtWhen(a.at)}</small>{a.detail && <p>{a.detail}</p>}</div>) : <div className="rcs-none">Nothing has happened yet.</div>}</div>
        </Panel>
      )}

      {tab === 'replies' && (
        <Panel title="Replies" sub="Inbound messages attributed to this campaign." right={<Btn onClick={() => go('inbox')}>Open inbox →</Btn>}>
          <div className="cd-replies">
            {!rep && <div className="rcs-none">Loading…</div>}
            {rep && rep.replies.map((r) => (
              <div key={r.id} className="cd-reply"><div className="avatar2">{(r.name || '?').slice(0, 2).toUpperCase()}</div><div><b>{r.name}</b><p>{r.text || `Replied on ${r.words}${r.at ? ` · ${fmtWhen(r.at)}` : ''}`}</p></div><button type="button" className="tiny-btn" style={{ marginLeft: 'auto' }} onClick={() => go('inbox')}>Reply</button></div>
            ))}
            {rep && !rep.replies.length && <div className="rcs-none">No replies yet. When people answer a message of this campaign they show here and in the inbox.</div>}
          </div>
        </Panel>
      )}

      {tab === 'conversions' && (
        <div>
          <div className="grid metric-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
            <Metric label="Conversions (applied)" value={n0(o.conversions)} meta={o.conversionsNote} up={o.conversions > 0} />
            <Metric label="Replies" value={n0(c.numbers.replied)} />
            <Metric label="Link clicks" value={n0(c.numbers.clicked)} />
            <Metric label="People reached" value={n0(o.reach)} up={false} />
          </div>
          <Panel title="Attribution by channel" sub="Who applied after a message of this campaign, per channel." style={{ marginTop: 14 }}>
            <div className="table-scroll" style={{ marginTop: 12 }}>
              <table className="table">
                <thead><tr><th>Channel</th><th>Conversions</th><th>Link clicks</th><th>Share</th></tr></thead>
                <tbody>
                  {d.channels.map((x) => <tr key={x.campaignId}><td><b>{x.words}</b></td><td>{n0(x.applied)}</td><td>{n0(x.clicked)}</td><td>{o.conversions ? `${Math.round((x.applied / o.conversions) * 100)}%` : '—'}</td></tr>)}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 8 }}>Revenue and cost per conversion are not tracked here, so they are not shown.</p>
          </Panel>
        </div>
      )}

      {dlg && dlg.t === 'dup' && <PromptModal title="Duplicate campaign" label="New campaign name" initial={`${c.name} copy`} okLabel="Duplicate" busy={busy} validate={(v) => (!v.trim() ? 'Give the campaign a name.' : '')} onCancel={() => setDlg(null)} onSubmit={async (name) => { const r = await run(() => omni.post(`${base}/duplicate`, { name }), `"${name}" created as not sent yet`); if (r && r.key) onOpen(r.key); }} />}
      {dlg && dlg.t === 'send' && <ConfirmModal title={`Send "${c.name}" now?`} yes={d.testMode ? 'Send as a rehearsal' : 'Send now'} text={d.testMode ? 'Test mode is ON, so this is a rehearsal: everything is made and logged, nothing is really sent.' : `Real people will get a message on ${c.channels.map((x) => x.words).join(', ')}.`} onNo={() => setDlg(null)} onYes={() => send('now')} />}
      {dlg && dlg.t === 'schedule' && <ScheduleModal busy={busy} onCancel={() => setDlg(null)} onSubmit={(at) => send('at', at)} />}
      {dlg && dlg.t === 'stop' && <ConfirmModal title={`Stop "${c.name}"?`} yes="Stop campaign" danger text="People who were not messaged yet will not get it. A stopped campaign cannot start again." onNo={() => setDlg(null)} onYes={() => run(() => omni.post(`${base}/stop`))} />}
      {dlg && dlg.t === 'del' && <ConfirmModal title={`Delete "${c.name}"?`} yes="Delete campaign" danger text="This campaign was never sent, so nobody was messaged. The campaign is removed." onNo={() => setDlg(null)} onYes={async () => { const r = await run(() => omni.del(base), `"${c.name}" deleted`); if (r) onBack(); }} />}
      {dlg && dlg.t === 'reject' && <NoteModal title="Send back for changes" label="What should be changed?" okLabel="Send back" busy={busy} onCancel={() => setDlg(null)} onSubmit={(note) => run(() => omni.post(`${base}/reject`, { note }))} />}
    </div>
  );
}
