import { useCallback, useEffect, useState } from 'react';
import api from '../../../api';
import { useOmni } from '../omniContext.js';
import { Panel, Field, Btn, Banner, Pill, Empty, GsModal, ConfirmModal, fmtDateTime } from '../ui.jsx';
import { errOf } from '../omniApi.js';

// ---------------------------------------------------------------------------
// WHATSAPP > CAMPAIGNS (the AI WhatsApp Marketing Assistant): a promotion that goes ONLY to customers who agreed to promotions on WhatsApp, ONLY as a WhatsApp template Meta approved.
// Before anything is saved the screen lists every person it will go to with the exact words they will read, and every person left out with the reason. Nothing is sent until a person
// presses Send (or a time). Results are what really happened. Server: /api/omni-wa/campaign-templates, /campaigns (omniwa/campaign.js). Only logins with campaign rights see this.
// ---------------------------------------------------------------------------
const BASE = '/omni-wa';
const FIELD_WORDS = [['name', 'their first name'], ['service', 'the service they asked about'], ['business', 'our business name'], ['callback', 'the call time they gave']];
const STATUS = { ready: ['draft', 'Ready: not sent'], scheduled: ['scheduled', 'Scheduled'], sending: ['live', 'Sending'], done: ['live', 'Finished'], cancelled: ['draft', 'Stopped'] };
const R_STATUS = { queued: ['draft', 'Waiting'], sent: ['live', 'Sent'], failed: ['red', 'Failed'], skipped: ['warn', 'Not sent'] };
const BANDS = ['Hot', 'Warm', 'Cold'];
const istToMs = (v) => (v ? Date.parse(`${v}:00+05:30`) : null);
const pctWord = (n, p) => `${n}${p === null || p === undefined ? '' : ` (${p}%)`}`;

function Results({ s }) {
  if (!s) return null;
  return (
    <div className="small-muted" aria-label="Results">
      {s.sent} sent · {pctWord(s.delivered, s.deliveredPct)} delivered · {pctWord(s.read, s.readPct)} read · {pctWord(s.replied, s.repliedPct)} replied · {pctWord(s.optedOut, s.optedOutPct)} opted out · {s.failed} failed{s.queued ? ` · ${s.queued} waiting` : ''}{s.skipped ? ` · ${s.skipped} not sent` : ''}
    </div>
  );
}

function NewCampaign({ templates, onClose, onMade }) {
  const [f, setF] = useState({ name: '', templateId: '', varMap: [], bands: [] });
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const tpl = templates.find((t) => t.id === f.templateId) || null;
  const pickTemplate = (id) => {
    const t = templates.find((x) => x.id === id);
    setPv(null);
    setF((x) => ({ ...x, templateId: id, varMap: t ? FIELD_WORDS.map(([k]) => k).slice(0, t.blanks).concat(Array(Math.max(0, t.blanks - FIELD_WORDS.length)).fill('name')) : [] }));
  };
  const body = () => ({ name: f.name, templateId: f.templateId, varMap: f.varMap, audience: { bands: f.bands } });
  const preview = async () => {
    setBusy(true); setErr(''); setPv(null);
    try { const r = await api.post(`${BASE}/campaigns/preview`, body()); setPv(r.data); } catch (e) { setErr(errOf(e, 'The preview could not be made.')); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setErr('');
    try { const r = await api.post(`${BASE}/campaigns`, body()); onMade(r.data.id); } catch (e) { setErr(errOf(e, 'The campaign could not be saved.')); } finally { setBusy(false); }
  };
  const change = (fn) => (e) => { setPv(null); fn(e); };
  const skippedList = pv ? Object.entries(pv.skipped) : [];
  return (
    <GsModal title="New campaign" sub="Only people who agreed to promotions on WhatsApp are ever included." width={760} onClose={onClose} foot={<Btn primary onClick={save} disabled={busy || !pv || !pv.people.length || !f.name.trim()}>{busy ? 'Working…' : 'Save campaign (nothing is sent yet)'}</Btn>}>
      {err && <Banner tone="warn">{err}</Banner>}
      <Field label="Name"><input className="input" aria-label="Campaign name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="December offer" /></Field>
      <Field label="Approved WhatsApp template" hint="Only a template Meta approved can start a conversation with a customer.">
        <select className="input" aria-label="Template" value={f.templateId} onChange={(e) => pickTemplate(e.target.value)}>
          <option value="">Choose a template</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.metaName})</option>)}
        </select>
      </Field>
      {templates.length === 0 && <Banner tone="info">No approved WhatsApp template yet. Make one in Omni-Channel &gt; Templates and wait for Meta to approve it.</Banner>}
      {tpl && (
        <>
          <div className="small-muted" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 8px' }}>{tpl.body}</div>
          {f.varMap.map((k, i) => (
            <Field key={`blank-${i + 1}`} label={`{{${i + 1}}} is filled with`}> {/* eslint-disable-line react/no-array-index-key */}
              <select className="input" aria-label={`Blank ${i + 1}`} value={k} onChange={change((e) => setF((x) => ({ ...x, varMap: x.varMap.map((y, j) => (j === i ? e.target.value : y)) })))}>
                {FIELD_WORDS.map(([key, word]) => <option key={key} value={key}>{word}</option>)}
              </select>
            </Field>
          ))}
        </>
      )}
      <Field label="Only these (none ticked = everybody who agreed)">
        <span style={{ display: 'flex', gap: 14 }}>{BANDS.map((b) => <label key={b} style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" aria-label={`Only ${b}`} checked={f.bands.includes(b)} onChange={change((e) => setF((x) => ({ ...x, bands: e.target.checked ? [...x.bands, b] : x.bands.filter((y) => y !== b) })))} />{b}</label>)}</span>
      </Field>
      <Btn onClick={preview} disabled={busy || !f.templateId}>Show who will receive it</Btn>
      {pv && (
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }} aria-label="Preview">
          <b>{pv.people.length} {pv.people.length === 1 ? 'person' : 'people'} will receive it</b>
          {pv.people.length === 0 && <Banner tone="warn">Nobody would receive this campaign: nobody has agreed to promotions on WhatsApp yet, or all of them are left out below.</Banner>}
          {pv.people.map((p) => (
            <div key={p.leadId} style={{ border: '1px solid var(--line, #e5e7eb)', borderRadius: 8, padding: 8 }}>
              <div><b>{p.name}</b> <span className="small-muted">{p.phoneHint}{p.band ? ` · ${p.band}` : ''}</span></div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{p.text}</div>
            </div>
          ))}
          {skippedList.length > 0 && (
            <div className="small-muted" aria-label="Left out">
              <b>Left out ({skippedList.reduce((a, [, n]) => a + n, 0)}):</b>
              {skippedList.map(([why, n]) => <div key={why}>{n} · {why}{pv.samples[why] ? ` (${pv.samples[why].join(', ')}${n > pv.samples[why].length ? ', …' : ''})` : ''}</div>)}
            </div>
          )}
        </div>
      )}
    </GsModal>
  );
}

function Detail({ id, canSend, onBack, onChanged }) {
  const { toast } = useOmni();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null);
  const [when, setWhen] = useState('');
  const load = useCallback(() => api.get(`${BASE}/campaigns/${id}`).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The campaign could not be opened.'))), [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (what, body) => {
    setBusy(true); setErr(''); setAsk(null);
    try { await api.post(`${BASE}/campaigns/${id}/${what}`, body || {}); toast(what === 'cancel' ? 'Stopped.' : (body && body.at ? 'Scheduled.' : 'Sending has started.')); await load(); onChanged(); } catch (e) { setErr(errOf(e, 'That did not work.')); } finally { setBusy(false); }
  };
  if (!d) return err ? <Banner tone="warn">{err}</Banner> : <div className="small-muted">Loading…</div>;
  const c = d.campaign; const [tone, word] = STATUS[c.status] || ['draft', c.status];
  const n = d.people.filter((p) => p.status === 'queued').length;
  return (
    <Panel title={c.name} sub={`Template ${c.templateName}${c.createdByName ? ` · made by ${c.createdByName}` : ''}${c.approvedByName ? ` · sent by ${c.approvedByName}` : ''}`} right={<Btn small ghost onClick={onBack}>Back</Btn>}>
      {err && <Banner tone="warn">{err}</Banner>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Pill tone={tone}>{word}</Pill>{c.scheduledAt && c.status === 'scheduled' && <span className="small-muted">goes {fmtDateTime(c.scheduledAt)}</span>}</div>
      {c.note && <Banner tone="info">Waiting: {c.note}</Banner>}
      <Results s={d.stats} />
      {c.status === 'ready' && canSend && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '10px 0' }}>
          <Btn primary disabled={busy} onClick={() => setAsk('now')}>Send now</Btn>
          <input type="datetime-local" className="input" style={{ maxWidth: 220 }} aria-label="Send at (India time)" value={when} onChange={(e) => setWhen(e.target.value)} />
          <Btn disabled={busy || !when} onClick={() => setAsk('later')}>Schedule</Btn>
          <Btn danger disabled={busy} onClick={() => setAsk('stop')}>Stop it</Btn>
        </div>
      )}
      {['scheduled', 'sending'].includes(c.status) && canSend && <div style={{ margin: '10px 0' }}><Btn danger disabled={busy} onClick={() => setAsk('stop')}>Stop it</Btn></div>}
      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
        {d.people.map((p) => { const [t, w] = R_STATUS[p.status] || ['draft', p.status]; return (
          <div key={p.id} style={{ borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: 6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b>{p.name}</b><span className="small-muted">{p.phoneHint}</span><Pill tone={t}>{w}</Pill>{p.sentAt && <span className="small-muted">{fmtDateTime(p.sentAt)}</span>}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{p.text}</div>
            {p.reason && <div className="small-muted">{p.reason}</div>}
          </div>
        ); })}
      </div>
      {ask === 'now' && <ConfirmModal title={`Send to ${n} ${n === 1 ? 'person' : 'people'} now?`} text={`Each person gets the approved template ${c.templateName} with their own details, exactly as listed here. Anyone who stopped or withdrew their consent before the moment of sending is skipped. This cannot be undone.`} yes="Send now" onYes={() => act('send')} onNo={() => setAsk(null)} />}
      {ask === 'later' && <ConfirmModal title="Schedule this campaign?" text={`It goes at ${when.replace('T', ' ')} India time, to the people listed here, with the same checks at that moment.`} yes="Schedule" onYes={() => act('send', { at: istToMs(when) })} onNo={() => setAsk(null)} />}
      {ask === 'stop' && <ConfirmModal title="Stop this campaign?" text="Nobody who has not received it yet will be sent to." yes="Stop it" danger onYes={() => act('cancel')} onNo={() => setAsk(null)} />}
    </Panel>
  );
}

export default function WaMktCampaigns({ canCreate = true }) {
  const [d, setD] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [making, setMaking] = useState(false);
  const [open, setOpen] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get(`${BASE}/campaigns`).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The campaigns could not be loaded.'))), []);
  useEffect(() => { load(); api.get(`${BASE}/campaign-templates`).then((r) => setTemplates(r.data.templates)).catch(() => setTemplates([])); }, [load]);
  if (err) return <Banner tone="warn">{err}</Banner>;
  if (!d) return <div className="small-muted">Loading…</div>;
  if (!d.canManage) return <Banner tone="info">Only people with campaign rights can make or send a WhatsApp promotion.</Banner>;
  if (open) return <Detail id={open} canSend={canCreate} onBack={() => { setOpen(null); load(); }} onChanged={load} />;
  return (
    <>
      <Panel title="WhatsApp campaigns" sub="A promotion goes only to customers who agreed to promotions on WhatsApp, and only as a template Meta approved. You see every person and the exact words before anything is saved, and nothing is sent until you press Send." right={canCreate ? <Btn primary small onClick={() => setMaking(true)}>New campaign</Btn> : null}>
        {!d.enabled && <Banner tone="warn">WhatsApp promotions are switched off. An Admin switches them on in Settings &gt; WhatsApp AI &gt; Marketing assistant.</Banner>}
        {d.rows.length === 0 && <Empty title="No campaigns yet">Customers agree to promotions when the assistant asks them after their details (switch it on in Settings), or when your team records their consent in the CRM.</Empty>}
        {d.rows.map((r) => { const [tone, word] = STATUS[r.status] || ['draft', r.status]; return (
          <button type="button" key={r.id} className="tiny-btn" style={{ width: '100%', textAlign: 'left', display: 'grid', gap: 4, padding: '8px 4px', borderTop: '1px solid var(--line, #e5e7eb)' }} onClick={() => setOpen(r.id)}>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b>{r.name}</b><Pill tone={tone}>{word}</Pill><span className="small-muted">{r.templateName} · {fmtDateTime(r.createdAt)}</span></span>
            <Results s={r.stats} />
          </button>
        ); })}
      </Panel>
      {making && <NewCampaign templates={templates} onClose={() => setMaking(false)} onMade={(id) => { setMaking(false); load(); setOpen(id); }} />}
    </>
  );
}
