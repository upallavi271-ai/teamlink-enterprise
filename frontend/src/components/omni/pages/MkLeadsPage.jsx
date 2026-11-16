import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../../api';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Kpi, Kpis, Panel, Banner, Field, Empty, GsModal, Pill, Tag, ConfirmModal, fmtNum, fmtDateTime } from '../ui.jsx';
import '../marketing/marketing.css';

// AI MARKETING > LEAD GENERATION TO THE CRM. Every NEW lead (website form, an ad-lead file, by hand) is scored Hot / Warm / Cold with the reasons shown, given an owner in turn when nobody has it, and the owner is
// told. The first reply is the CRM Autopilot's (Sales CRM > Autopilot): this page shows whether it is on and what it did for each lead. Nothing here messages anyone. Server: marketing/leadgen.js.
const BAND = { Hot: 'red', Warm: 'warn', Cold: 'draft' };
const REPLY_TONE = { sent: 'live', waiting: 'warn', failed: 'red', skipped: 'draft', none: 'draft' };

function ImportModal({ sources, canAssign, owners, onClose, onDone, toast }) {
  const [source, setSource] = useState(sources[0]);
  const [file, setFile] = useState(null);
  const [owner, setOwner] = useState('');
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const run = async (dry) => {
    setBusy(dry ? 'check' : 'go'); setErr('');
    try {
      const r = await api.post('/outreach/gs/marketing/leads/import', file, { headers: { 'Content-Type': 'application/octet-stream' }, params: { name: file.name, source, ownerId: owner, ...(dry ? { dryRun: 1 } : {}) }, timeout: 120000 });
      if (dry) setCheck(r.data); else { toast(r.data.ok || 'Imported'); onDone(); }
    } catch (e) { setErr(errOf(e, 'The file could not be read.')); } finally { setBusy(''); }
  };
  return (
    <GsModal title="Import ad leads" sub="The file you download from Facebook / Instagram Lead Ads or Google Ads (CSV or Excel). People already in the CRM are skipped." width={600} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn disabled={!file || !!busy} onClick={() => run(true)}>{busy === 'check' ? 'Checking…' : 'Check the file first'}</Btn><Btn primary disabled={!file || !check || !check.ready || !!busy} onClick={() => run(false)} title={!check ? 'Check the file first' : ''}>{busy === 'go' ? 'Importing…' : `Import ${check ? check.ready : ''} leads`}</Btn></>}>
      {err ? <Banner tone="error">{err}</Banner> : null}
      <div className="form-grid">
        <Field label="WHERE THEY CAME FROM"><select value={source} onChange={(e) => setSource(e.target.value)}>{sources.map((s) => <option key={s}>{s}</option>)}</select></Field>
        {canAssign ? <Field label="GIVE THEM TO (OPTIONAL)"><select value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Me (then scoring gives them out in turn if it is on)</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}{o.tl ? ' (manager)' : ''}</option>)}</select></Field> : null}
        <Field label="THE FILE" full hint="Needs a Company (or Name) column; Phone, Email, City, Notes and Designation are used when they are there.">
          <input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => { setFile(e.target.files && e.target.files[0]); setCheck(null); }} />
        </Field>
      </div>
      {check ? (
        <div style={{ fontSize: 12.5, lineHeight: 1.6, marginTop: 8 }}>
          <b>{check.rows}</b> rows read: <b style={{ color: '#166534' }}>{check.ready} can be added</b>{check.skipped && check.skipped.length ? `, ${check.skipped.length} skipped` : ''}.
          {check.skipped && check.skipped.length ? <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: 'var(--muted)', fontSize: 11.5 }}>{check.skipped.slice(0, 6).map((x) => <li key={x.row}>Row {x.row}{x.company ? ` (${x.company})` : ''}: {x.reason}</li>)}{check.skipped.length > 6 ? <li>… and {check.skipped.length - 6} more</li> : null}</ul> : null}
        </div>
      ) : null}
    </GsModal>
  );
}

export default function MkLeadsPage() {
  const { toast } = useOmni();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState('');
  const [imp, setImp] = useState(false);
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState('');
  const [f, setF] = useState(null); // the settings being edited
  const [filter, setFilter] = useState('');
  const timer = useRef(null);
  const load = useCallback(() => omni.get('/gs/marketing/leads').then((x) => { setD(x); setF((cur) => cur || { hot: x.settings.hot, warm: x.settings.warm, assign: x.settings.assign, hotOwnerId: x.settings.hotOwnerId, notifyHot: x.settings.notifyHot }); setErr(''); }).catch((e) => setErr(errOf(e, 'The leads could not be read.'))), []);
  useEffect(() => { load(); timer.current = setInterval(load, 60000); return () => clearInterval(timer.current); }, [load]);
  if (err && !d) return <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={load}>Try again</button></Banner>;
  if (!d || !f) return <div className="card panel">Loading…</div>;
  const st = d.settings; const ap = d.autopilot; const c = d.counts;
  const save = async (extra) => {
    setBusy('save'); setErr('');
    try { const r = await omni.put('/gs/marketing/leads/settings', { ...f, ...(extra || {}) }); toast(r.ok); setF(null); await load(); } catch (e) { const m = errOf(e, 'It could not be saved.'); setErr(m); toast(m); } finally { setBusy(''); }
  };
  const score = async (body) => {
    setBusy('score'); setErr('');
    try { const r = await omni.post('/gs/marketing/leads/score', body); toast(r.ok); await load(); } catch (e) { const m = errOf(e, 'It could not be scored.'); setErr(m); toast(m); } finally { setBusy(''); }
  };
  const shown = d.leads.filter((l) => (filter === 'new' ? !l.band : filter ? l.band === filter : true));
  const firstReplyWords = ap.firstReply.length ? ap.firstReply.filter((x) => x.on).map((x) => `${x.channel === 'email' ? 'an email' : 'an SMS'}${x.afterHours ? ` after ${x.afterHours} h` : ' at once'}`).join(' and ') : 'a mail and an SMS';
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Lead generation" lead="Every new lead from your website form, an ad-lead file or typed in by hand is scored Hot, Warm or Cold with the reasons, given an owner in turn, and the owner is told. Nothing here messages anyone: the first reply is the CRM Autopilot.">
        <Btn onClick={() => setImp(true)}>⬆ Import ad leads</Btn>
        {d.canManage ? <Btn onClick={() => setAsk('all')} disabled={busy === 'score'} title="Score every open lead already in the CRM (the Hot / Warm / Cold rating is filled only where it is empty)">Score the leads already in the CRM</Btn> : null}
      </PageHead>
      {err ? <Banner tone="error">{err} <button type="button" className="tiny-btn" style={{ marginLeft: 8 }} onClick={() => setErr('')}>Close</button></Banner> : null}
      <Panel title="How it works" sub="Scoring and owners are done here. The first reply is done by the CRM Autopilot." right={d.canManage ? <Btn small primary={!st.on} onClick={() => save({ on: !st.on })} disabled={busy === 'save'}>{st.on ? 'Switch scoring off' : 'Switch scoring on'}</Btn> : <Pill tone={st.on ? 'live' : 'draft'} dot>{st.on ? 'On' : 'Off'}</Pill>}>
        <div className="mk-prov">
          <div><b>Scoring and owners {st.on ? <Pill tone="live" dot>On</Pill> : <Pill tone="warn" dot>Off</Pill>}</b><span>{st.on ? `New leads that arrive are scored within a minute (since ${fmtDateTime(st.armedAt)}). Old leads are not touched unless a manager presses “Score the leads already in the CRM”.` : 'Off. A Sales manager or an Admin switches it on; then only leads that arrive after that are scored by themselves.'}</span></div>
          <div><b>First reply (CRM Autopilot) {ap.on ? <Pill tone="live" dot>On</Pill> : <Pill tone="warn" dot>Off</Pill>}</b><span>{ap.on ? `Each new lead gets ${firstReplyWords}, then a short follow-up over the week. It stops when they reply, opt out or a person takes over.` : 'Off. When a Sales manager switches the Autopilot on (Sales CRM), each new lead gets a first mail and SMS at once.'}</span></div>
          <div><b>What a score is</b><span>Points for a real phone and email, a business email, a decision maker, a message about hiring or a price, a referral or the website form, a kind of company you serve. Points off for fake numbers, test entries and no way to reach them. Hot from {st.hot}, Warm from {st.warm}. Every reason is shown.</span></div>
        </div>
        {d.canManage ? (
          <div className="form-grid" style={{ marginTop: 10 }}>
            <Field label="HOT FROM (POINTS)"><input type="number" min={10} max={100} value={f.hot} onChange={(e) => setF({ ...f, hot: e.target.value })} /></Field>
            <Field label="WARM FROM (POINTS)"><input type="number" min={5} max={99} value={f.warm} onChange={(e) => setF({ ...f, warm: e.target.value })} /></Field>
            <Field label="GIVE A LEAD NOBODY OWNS TO"><select value={f.assign ? 'turn' : 'none'} onChange={(e) => setF({ ...f, assign: e.target.value === 'turn' })}><option value="turn">The next salesperson in turn</option><option value="none">Nobody: leave it for a manager</option></select></Field>
            <Field label="HOT LEADS GO TO"><select value={f.hotOwnerId} onChange={(e) => setF({ ...f, hotOwnerId: e.target.value })}><option value="">The next in turn, like the rest</option>{d.owners.map((o) => <option key={o.id} value={o.id}>{o.name}{o.tl ? ' (manager)' : ''}</option>)}</select></Field>
            <label style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}><input type="checkbox" checked={f.notifyHot} onChange={(e) => setF({ ...f, notifyHot: e.target.checked })} />Tell the owner in the app when a lead is given to them, or a Hot lead is scored</label>
            <div style={{ gridColumn: '1 / -1' }}><Btn small primary disabled={busy === 'save'} onClick={() => save()}>Save these settings</Btn></div>
          </div>
        ) : null}
      </Panel>
      <Kpis>
        <Kpi label="Leads, last 30 days" icon="◎" value={fmtNum(c.total)} meta={`${c.notScored} not scored yet`} />
        <Kpi label="Hot" icon="▲" value={fmtNum(c.hot)} tone={c.hot ? 'warn' : 'neutral'} meta={`${st.hot}+ points`} />
        <Kpi label="Warm" icon="●" value={fmtNum(c.warm)} meta={`${st.warm} to ${st.hot - 1} points`} />
        <Kpi label="Cold" icon="▼" value={fmtNum(c.cold)} meta={`under ${st.warm} points`} />
        <Kpi label="Nobody owns" icon="?" value={fmtNum(c.noOwner)} tone={c.noOwner ? 'warn' : 'neutral'} meta="needs an owner" />
        <Kpi label="Replied to" icon="✉" value={fmtNum(c.replied)} meta="by the Autopilot" />
      </Kpis>
      {d.bySource.length ? <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0 0', fontSize: 11.5, alignItems: 'center' }}><span style={{ color: 'var(--muted)' }}>Where they came from:</span>{d.bySource.map((s) => <Tag key={s.source}>{s.source} · {s.n}</Tag>)}</div> : null}
      <Panel title="Your leads" sub="Newest first. Press a lead to see why it got its score." style={{ marginTop: 14 }} right={<select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show"><option value="">All</option><option value="Hot">Hot</option><option value="Warm">Warm</option><option value="Cold">Cold</option><option value="new">Not scored yet</option></select>}>
        {shown.length === 0 ? <Empty title="No leads here yet">A lead that fills your website form, or comes in an ad-lead file, appears here with its score.</Empty> : shown.map((l) => (
          <div className="mk-row" key={l.id} style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <button type="button" onClick={() => setOpen(open === l.id ? '' : l.id)} style={{ all: 'unset', cursor: 'pointer', fontWeight: 700 }}>{l.company}</button> {l.band ? <Pill tone={BAND[l.band]} dot>{l.band} · {l.score}</Pill> : <Pill tone="draft">Not scored yet</Pill>} <Tag>{l.source}</Tag>
              <small>{[l.contactName, l.designation, l.city].filter(Boolean).join(' · ') || 'No contact name'} · {l.phone || 'no phone'} · {l.email || 'no email'} · added {fmtDateTime(l.createdAt)}</small>
              <small>Owner: {l.ownerName || <b style={{ color: '#b45309' }}>nobody yet</b>} · Stage: {l.stage || l.status} · <span style={{ color: l.reply.state === 'failed' ? '#b91c1c' : undefined }}>{l.reply.words}</span></small>
              {open === l.id ? (
                <div style={{ marginTop: 6, background: '#f6f8f7', borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.6 }}>
                  {l.why && l.why.length ? l.why.map((w, i) => <div key={i} style={{ color: w.pts > 0 ? '#166534' : '#b91c1c' }}>{w.pts > 0 ? '+' : ''}{w.pts} {w.why}</div>) : <div style={{ color: 'var(--muted)' }}>{l.band ? 'No reasons were kept for this one.' : 'It has not been scored yet.'}</div>}
                  {l.scoredAt ? <div style={{ color: 'var(--muted)', marginTop: 4 }}>Scored {fmtDateTime(l.scoredAt)}. The CRM rating is {l.rating || 'empty'}.</div> : null}
                </div>
              ) : null}
            </div>
            <div className="mk-acts" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 130 }}>
              <Btn small onClick={() => window.open(`/crm/leads?open=lead:${l.id}`, '_blank', 'noopener')}>Open in CRM ↗</Btn>
              {l.canEdit ? <TinyBtn disabled={busy === 'score'} onClick={() => score({ ids: [l.id], assignEmpty: true })}>{l.band ? 'Score again' : 'Score now'}</TinyBtn> : null}
            </div>
          </div>
        ))}
      </Panel>
      {imp ? <ImportModal sources={d.sources} canAssign={d.canManage} owners={d.owners} toast={toast} onClose={() => setImp(false)} onDone={() => { setImp(false); load(); }} /> : null}
      {ask ? <ConfirmModal title="Score the leads already in the CRM?" text="Every open lead gets a score and reasons. The CRM's Hot / Warm / Cold rating is filled only where it is empty: nobody's own rating is changed. Owners are given only to leads that have none." yes="Score them" onNo={() => setAsk(null)} onYes={() => { setAsk(null); score({ all: true, assignEmpty: true }); }} /> : null}
    </div>
  );
}
