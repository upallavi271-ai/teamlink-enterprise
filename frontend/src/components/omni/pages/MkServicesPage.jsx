import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Pill, Tag, Banner, Field, Tabs, Empty, fmtNum, fmtDate } from '../ui.jsx';

// AI MARKETING > CLIENT PLANS (2026-11-24): the services document made usable. 1 the three plans and the offers with a price calculator, 2 the clients on a plan with what has been
// delivered each month against the plan, 3 the Google profile quality audit (a score out of 100, the findings and what to do first). The audit is TeamLink's own score from what the
// team ticks; nothing is read from Google and nothing is invented. Nothing here sends or posts anything.
const rs = (n) => `₹${fmtNum(n)}`;
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const RENEW = { running: ['live', 'Running'], soon: ['warn', 'Renews within 30 days'], overdue: ['error', 'Past its end date'], ended: ['draft', 'Ended'] };
const ANSWERS = [['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']];
const blank = () => ({ clientName: '', plan: 'growth', months: 6, startDate: today(), industry: '', contactName: '', contactPhone: '', notes: '' });

export default function MkServicesPage() {
  const { toast } = useOmni();
  const [tab, setTab] = useState('plans');
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { omni.get('/gs/marketing/services/catalog').then(setCat).catch((e) => setErr(errOf(e, 'The plans could not be read.'))); }, []);
  const [pick, setPick] = useState(null); // a client plan chosen for the audit
  if (err && !cat) return <Banner tone="error">{err}</Banner>;
  if (!cat) return <div className="card panel">Loading…</div>;
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="Client plans" lead="The Basic, Growth and Premium plans, what has been delivered for each client this month, and the Google profile quality audit." />
      <Attention onOpen={() => setTab('clients')} />
      <Tabs value={tab} onChange={setTab} tabs={[['plans', 'Plans and offers'], ['clients', 'Clients on a plan'], ['audit', 'Google profile audit']]} />
      <div style={{ marginTop: 14 }}>
        {tab === 'plans' ? <PlansTab cat={cat} /> : null}
        {tab === 'clients' ? <ClientsTab cat={cat} toast={toast} onAudit={(p) => { setPick(p); setTab('audit'); }} /> : null}
        {tab === 'audit' ? <AuditTab cat={cat} toast={toast} pick={pick} /> : null}
      </div>
    </div>
  );
}

function PlansTab({ cat }) {
  const [plan, setPlan] = useState('growth'); const [months, setMonths] = useState(6); const [q, setQ] = useState(null);
  useEffect(() => { omni.get('/gs/marketing/services/quote', { plan, months }).then(setQ).catch(() => setQ(null)); }, [plan, months]);
  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12 }}>
        {cat.plans.map((p) => (
          <Panel key={p.key} title={`${p.label}: ${rs(p.price)} a month`} sub={p.suited}>
            <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 13 }}>
              {cat.items.filter((i) => p.quotas[i.key] > 0).map((i) => <li key={i.key}><b>{p.quotas[i.key]}</b> {i.label} a month</li>)}
            </ul>
            <details><summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)' }}>Everything in {p.label}</summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.5 }}>{p.includes.map((t) => <li key={t}>{t}</li>)}</ul>
            </details>
          </Panel>
        ))}
      </div>
      <Panel title="Price calculator" sub="3 months 5% off, 6 months 10% off, 9 months 15% off, 12 months for the price of 11. Paid upfront for the whole period." style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <Field label="PLAN"><select value={plan} onChange={(e) => setPlan(e.target.value)}>{cat.plans.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
          <Field label="FOR HOW LONG"><select value={months} onChange={(e) => setMonths(Number(e.target.value))}>{cat.terms.map((t) => <option key={t.months} value={t.months}>{t.label}{t.off ? `, ${t.off}% off` : t.months === 12 ? ', pay for 11' : ''}</option>)}</select></Field>
        </div>
        {q && !q.error ? (
          <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.7 }}>
            <div>Standard price: {rs(q.monthly)} × {q.months} = <b>{rs(q.gross)}</b></div>
            {q.offPercent ? <div>Offer: <b>{q.offPercent}% off</b> (you save {rs(q.saved)})</div> : null}
            {q.freeMonths ? <div>Offer: <b>{q.freeMonths} month free</b> (you save {rs(q.saved)})</div> : null}
            <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4 }}>Client pays {rs(q.total)} <small style={{ fontWeight: 500, color: 'var(--muted)' }}>before GST</small></div>
          </div>
        ) : null}
        <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)' }}>Terms of the offers</summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.5 }}>{cat.offerTerms.map((t) => <li key={t}>{t}</li>)}</ul>
        </details>
      </Panel>
      <Panel title="Every month, the same steps" style={{ marginTop: 14 }}>
        <table className="mk-table"><tbody>{cat.weeks.map(([w, t]) => <tr key={w}><td style={{ whiteSpace: 'nowrap' }}><b>{w}</b></td><td style={{ fontSize: 13 }}>{t}</td></tr>)}</tbody></table>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{cat.gstNote} Content is subject to client approval and the agreed scope. TeamLink reports measured results, not guaranteed rankings or leads.</div>
      </Panel>
    </div>
  );
}

// what needs a person today (plans ending within 30 days or already ended, monthly reports still empty near the month end). The same facts also arrive once as bells.
const LEVEL = { overdue: ['error', 'Ended'], soon: ['warn', 'Soon'], notice: ['draft', 'Coming up'] };
function Attention({ onOpen }) {
  const [items, setItems] = useState(null);
  useEffect(() => { let live = true; omni.get('/gs/marketing/services/attention').then((d) => { if (live) setItems(d.items || []); }).catch(() => { if (live) setItems([]); }); return () => { live = false; }; }, []);
  if (!items || !items.length) return null;
  return (
    <Panel title={`Needs attention (${items.length})`} sub="Plans that are ending or have ended, and monthly reports still empty near the month end. Each one also arrives once as a bell." style={{ marginBottom: 14 }} right={<TinyBtn onClick={onOpen}>Open clients on a plan</TinyBtn>}>
      {items.map((it) => {
        const [tone, words] = LEVEL[it.level] || LEVEL.notice;
        return (
          <div key={`${it.planId}-${it.kind}`} style={{ display: 'flex', gap: 10, alignItems: 'baseline', margin: '6px 0', fontSize: 13, flexWrap: 'wrap' }}>
            <Pill tone={tone} dot>{words}</Pill><b>{it.title}</b><span style={{ color: 'var(--muted)' }}>{it.message}</span>
          </div>
        );
      })}
    </Panel>
  );
}

function ClientsTab({ cat, toast, onAudit }) {
  const [month, setMonth] = useState(new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7));
  const [rows, setRows] = useState(null); const [err, setErr] = useState(''); const [form, setForm] = useState(null); const [busy, setBusy] = useState(false); const [rep, setRep] = useState(null);
  const load = useCallback(() => omni.get('/gs/marketing/services/plans', { month }).then((d) => { setRows(d.items); setErr(''); }).catch((e) => setErr(errOf(e, 'The clients could not be read.'))), [month]);
  useEffect(() => { load(); }, [load]);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const add = async () => { setBusy(true); try { await omni.post('/gs/marketing/services/plans', { ...form, months: Number(form.months) }); setForm(null); toast('Client added'); await load(); } catch (e) { toast(errOf(e, 'It could not be saved.')); } finally { setBusy(false); } };
  const count = async (r, item, delta) => { try { await omni.post(`/gs/marketing/services/plans/${r.id}/delivery`, { month, item, delta }); await load(); } catch (e) { toast(errOf(e, 'It could not be counted.')); } };
  const setStatus = async (r, status) => { try { await omni.put(`/gs/marketing/services/plans/${r.id}`, { status }); await load(); } catch (e) { toast(errOf(e, 'It could not be changed.')); } };
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap', marginBottom: 12 }}>
        <Field label="MONTH SHOWN"><input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
        <Btn primary onClick={() => setForm(blank())}>＋ Add a client on a plan</Btn>
      </div>
      {form ? (
        <Panel title="A client on a plan" style={{ marginBottom: 12 }} right={<Btn primary disabled={busy || !form.clientName.trim()} onClick={add}>Save</Btn>}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10 }}>
            <Field label="CLIENT NAME"><input value={form.clientName} maxLength={120} onChange={set('clientName')} /></Field>
            <Field label="PLAN"><select value={form.plan} onChange={set('plan')}>{cat.plans.map((p) => <option key={p.key} value={p.key}>{p.label} ({rs(p.price)} a month)</option>)}</select></Field>
            <Field label="MONTHS PAID FOR"><select value={form.months} onChange={set('months')}>{cat.terms.map((t) => <option key={t.months} value={t.months}>{t.label}</option>)}</select></Field>
            <Field label="STARTS ON"><input type="date" value={form.startDate} onChange={set('startDate')} /></Field>
            <Field label="KIND OF BUSINESS"><input value={form.industry} maxLength={60} placeholder="Hospital, clinic, school…" onChange={set('industry')} /></Field>
            <Field label="CONTACT PERSON"><input value={form.contactName} maxLength={100} onChange={set('contactName')} /></Field>
            <Field label="CONTACT PHONE"><input value={form.contactPhone} maxLength={30} onChange={set('contactPhone')} /></Field>
            <Field label="NOTES (WHAT WAS AGREED)" full><input value={form.notes} maxLength={1000} onChange={set('notes')} /></Field>
          </div>
          <Banner>The price is kept as it was at the start. Healthcare clients: medical content is reviewed by a doctor or a qualified medical reviewer before it is published.</Banner>
        </Panel>
      ) : null}
      {rep ? <ReportPanel plan={rep} month={month} toast={toast} onClose={() => setRep(null)} /> : null}
      {err ? <Banner tone="error">{err}</Banner> : null}
      {rows && !rows.length ? <Empty title="No client on a plan yet">Add the first one: the plan, how many months were paid for, and the start date. Then count what is delivered each month.</Empty> : null}
      {(rows || []).map((r) => {
        const [tone, words] = RENEW[r.renewal] || RENEW.running;
        return (
          <Panel key={r.id} title={`${r.clientName} · ${r.planLabel}`} sub={`${r.months} month(s) from ${fmtDate(r.startDate)} to ${fmtDate(r.endDate)} · paid ${rs(r.pricePaid)}${r.industry ? ` · ${r.industry}` : ''}`} style={{ marginBottom: 12 }}
            right={<span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><Pill tone={tone} dot>{words}{r.renewal === 'soon' ? ` (${r.daysLeft} days)` : ''}</Pill><TinyBtn onClick={() => onAudit(r)}>Google profile audit</TinyBtn><TinyBtn onClick={() => setRep(r)}>Monthly report</TinyBtn>{r.status === 'active' ? <TinyBtn onClick={() => setStatus(r, 'ended')}>End plan</TinyBtn> : <TinyBtn onClick={() => setStatus(r, 'active')}>Reopen</TinyBtn>}</span>}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Delivered in {month}: {r.deliveredPct}% of the plan. Posts, Reels and stories are counted by themselves from the work approved for {r.clientName} in Client projects; the + and − buttons add work made outside TeamLink. GBP posts and blogs are counted by hand.</div>
            {r.progress.map((p) => (
              <div key={p.item} style={{ display: 'grid', gridTemplateColumns: 'minmax(150px,1.2fr) 3fr auto', gap: 10, alignItems: 'center', margin: '5px 0', fontSize: 13 }}>
                <span>{p.label}{p.counted === 'work' ? <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>{p.auto} from approved work · {p.manual} added by hand</span> : <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>counted by hand</span>}</span>
                <div style={{ background: '#e2e8f0', borderRadius: 6, height: 12, overflow: 'hidden' }}><div style={{ width: `${p.pct}%`, height: '100%', background: p.done >= p.quota ? '#15803d' : '#0f766e' }} /></div>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}><TinyBtn aria-label={`one less ${p.label}`} disabled={p.manual <= 0} title={p.manual <= 0 ? 'Nothing was added by hand to take away' : undefined} onClick={() => count(r, p.item, -1)}>−</TinyBtn><b>{p.done}</b> of {p.quota}<TinyBtn aria-label={`one more ${p.label}`} onClick={() => count(r, p.item, 1)}>＋</TinyBtn>{p.over ? <Tag title="More than the plan">+{p.over} extra</Tag> : null}</span>
              </div>
            ))}
            {(r.autoItems || []).length ? (
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12.5 }}>Work counted by itself in {month} ({r.progress.reduce((a, p) => a + (p.auto || 0), 0)}{r.autoItems.length < r.progress.reduce((a, p) => a + (p.auto || 0), 0) ? `, the first ${r.autoItems.length} listed` : ''})</summary>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.5 }}>{r.autoItems.map((a) => <li key={a.id}>{a.title || 'Untitled'} <Tag>{a.kind === 'reels' ? 'Reel' : a.kind === 'stories' ? 'Story' : 'Post'}</Tag> <span style={{ color: 'var(--muted)' }}>approved {fmtDate(a.at)}</span></li>)}</ul>
              </details>
            ) : null}
          </Panel>
        );
      })}
    </div>
  );
}

function AuditTab({ cat, toast, pick }) {
  const [clientName, setClientName] = useState(pick ? pick.clientName : ''); const planId = pick ? pick.id : null;
  const [answers, setAnswers] = useState({}); const [rep, setRep] = useState(null); const [past, setPast] = useState([]); const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => { const my = (seq.current += 1); const t = setTimeout(() => omni.post('/gs/marketing/services/gbp/score', { answers }).then((r) => { if (my === seq.current) setRep(r); }).catch(() => {}), 250); return () => clearTimeout(t); }, [answers]);
  const loadPast = useCallback(() => { if (!clientName.trim()) { setPast([]); return Promise.resolve(); } return omni.get('/gs/marketing/services/gbp/audits', { clientName: clientName.trim() }).then((d) => setPast(d.items || [])).catch(() => setPast([])); }, [clientName]);
  useEffect(() => { loadPast(); }, [loadPast]);
  const setA = (k, v) => setAnswers((a) => ({ ...a, [k]: v }));
  const fill = (v) => setAnswers(Object.fromEntries(cat.gbp.areas.flatMap((a) => a.checks.map((c) => [c.key, v]))));
  const save = async () => { setBusy(true); try { await omni.post('/gs/marketing/services/gbp/audits', { clientName, planId, answers }); toast('Audit saved'); await loadPast(); } catch (e) { toast(errOf(e, 'It could not be saved.')); } finally { setBusy(false); } };
  const text = useMemo(() => !rep ? '' : [`Google Business Profile quality audit: ${clientName || 'client'}`, `Profile quality score: ${rep.score}/${rep.outOf} (${rep.band})`, ...(rep.findings.length ? ['', 'What we found:', ...rep.findings.map((f) => `- ${f}`)] : []), '', rep.recommendation, '', rep.disclaimer].join('\n'), [rep, clientName]);
  const copy = () => { try { navigator.clipboard.writeText(text).then(() => toast('Report copied'), () => toast('Select the text and copy it.')); } catch { toast('Select the text and copy it.'); } };
  const asked = Object.keys(answers).length; const total = cat.gbp.areas.reduce((n, a) => n + a.checks.length, 0); // counted here so the numbers are right before the server answers
  return (
    <div>
      <Banner>{cat.gbp.disclaimer}</Banner>
      <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap', margin: '10px 0' }}>
        <Field label="CLIENT"><input value={clientName} maxLength={120} placeholder="Client or business name" onChange={(e) => setClientName(e.target.value)} /></Field>
        <TinyBtn onClick={() => fill('no')}>Start again (all No)</TinyBtn>
        <Btn primary disabled={busy || !clientName.trim() || !asked} onClick={save}>Save this audit</Btn>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,3fr) minmax(260px,2fr)', gap: 14, alignItems: 'start' }}>
        <div>
          {cat.gbp.areas.map((a) => {
            const got = rep ? (rep.areas.find((x) => x.key === a.key) || {}).got : 0;
            return (
              <Panel key={a.key} title={`${a.label}`} right={<Tag>{got || 0} of {a.marks} marks</Tag>} style={{ marginBottom: 10 }}>
                {a.checks.map((c) => (
                  <div key={c.key} style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderTop: '1px solid #f1f5f9', fontSize: 13 }}>
                    <span>{c.ask} <small style={{ color: 'var(--muted)' }}>({c.pts})</small></span>
                    <span style={{ display: 'flex', gap: 4 }}>{ANSWERS.map(([k, w]) => <button key={k} type="button" className={`tiny-btn${answers[c.key] === k ? ' on' : ''}`} aria-pressed={answers[c.key] === k} style={answers[c.key] === k ? { background: '#0f766e', color: '#fff' } : undefined} onClick={() => setA(c.key, k)}>{w}</button>)}</span>
                  </div>
                ))}
              </Panel>
            );
          })}
        </div>
        <div style={{ position: 'sticky', top: 8 }}>
          <Panel title="Profile quality score" right={<Btn small onClick={copy} disabled={!asked}>Copy report</Btn>}>
            <div style={{ fontSize: 42, fontWeight: 900, color: '#0f766e', lineHeight: 1 }}>{rep ? rep.score : 0}<small style={{ fontSize: 18, color: 'var(--muted)' }}> / 100</small></div>
            <div style={{ fontSize: 13, margin: '4px 0 8px' }}>{rep ? rep.band : ''} · {asked} of {total} checks answered{rep && !rep.complete && asked ? ' (the rest score nothing until you answer them)' : ''}</div>
            {rep && rep.findings.length ? <><b style={{ fontSize: 12.5 }}>What we found</b><ul style={{ margin: '4px 0 8px', paddingLeft: 18, fontSize: 12.5 }}>{rep.findings.map((f) => <li key={f}>{f}</li>)}</ul></> : null}
            {rep && rep.actions.filter((x) => !x.unchecked).length ? <><b style={{ fontSize: 12.5 }}>Do these first</b><ol style={{ margin: '4px 0 8px', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.45 }}>{rep.actions.filter((x) => !x.unchecked).slice(0, 6).map((x) => <li key={x.key}><b>{x.area}:</b> {x.fix} <small style={{ color: 'var(--muted)' }}>(+{x.lost} marks)</small></li>)}</ol></> : null}
            {rep ? <div style={{ fontSize: 12.5 }}>{rep.recommendation}</div> : null}
          </Panel>
          {past.length ? (
            <Panel title={`Earlier audits: ${clientName.trim()}`} style={{ marginTop: 10 }}>
              <table className="mk-table"><tbody>{past.slice(0, 8).map((p) => <tr key={p.id}><td style={{ fontSize: 12.5 }}>{fmtDate(p.createdAt)}</td><td><b>{p.score}/100</b></td><td style={{ fontSize: 12 }}>{p.band}</td></tr>)}</tbody></table>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// the monthly client report of one client: type or import the real numbers, read a Search Console CSV, save, preview, print or copy. A number left empty shows "Not provided" in the report; nothing is invented.
function ReportPanel({ plan, month, toast, onClose }) {
  const [d, setD] = useState(null); const [m, setM] = useState({}); const [notes, setNotes] = useState(''); const [csv, setCsv] = useState(''); const [busy, setBusy] = useState(false);
  const take = (x) => { setD(x); setM(x.metrics || {}); setNotes(x.notes || ''); };
  useEffect(() => { omni.get(`/gs/marketing/services/plans/${plan.id}/report`, { month }).then(take).catch((e) => toast(errOf(e, 'The report could not be opened.'))); }, [plan.id, month]); // eslint-disable-line react-hooks/exhaustive-deps
  const setV = (g, k, v) => setM({ ...m, [g]: { ...(m[g] || {}), [k]: v } });
  const readCsv = async () => { try { const r = await omni.post(`/gs/marketing/services/plans/${plan.id}/report/csv`, { text: csv }); setM({ ...m, seo: r.seo }); toast(`Search Console file read: ${r.seo.rowsRead} rows`); } catch (e) { toast(errOf(e, 'The file could not be read.')); } };
  const save = async () => { setBusy(true); try { take(await omni.put(`/gs/marketing/services/plans/${plan.id}/report`, { month, metrics: m, notes })); toast('Report saved'); } catch (e) { toast(errOf(e, 'It could not be saved.')); } finally { setBusy(false); } };
  const print = () => { if (!d) return; const w = window.open('', '_blank'); if (!w) { toast('Allow pop-ups to print, or copy the text.'); return; } w.document.write(d.report.html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300); };
  const copyText = () => { try { navigator.clipboard.writeText(d.report.text).then(() => toast('Report text copied'), () => toast('Select the text and copy it.')); } catch { toast('Select the text and copy it.'); } };
  if (!d) return <div className="card panel" style={{ marginBottom: 12 }}>Opening the report…</div>;
  return (
    <Panel title={`Monthly report: ${plan.clientName} · ${month}`} sub="Type only numbers you can see in the real source (Instagram, Facebook, Google Business Profile, the website). Leave a box empty if you do not have it: the report says Not provided." style={{ marginBottom: 12 }} right={<span style={{ display: 'flex', gap: 6 }}><Btn primary disabled={busy} onClick={save}>Save and make the report</Btn><TinyBtn onClick={onClose}>Close</TinyBtn></span>}>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12 }}>
        {Object.entries(d.fields).map(([g, def]) => (
          <div key={g}><b style={{ fontSize: 12.5 }}>{def.label}</b>
            {def.items.map(([k, label]) => <Field key={k} label={label.toUpperCase()}><input inputMode="decimal" value={m[g] && m[g][k] != null ? m[g][k] : ''} onChange={(e) => setV(g, k, e.target.value)} /></Field>)}
          </div>
        ))}
      </div>
      <Field label="GOOGLE SEARCH CONSOLE EXPORT (PASTE THE CSV OF QUERIES OR PAGES)" full><textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} placeholder={'Top queries,Clicks,Impressions,CTR,Position\nbest hospital in …,120,4000,3%,8.2'} /></Field>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}><TinyBtn disabled={!csv.trim()} onClick={readCsv}>Read the file</TinyBtn>{m.seo ? <Tag green>{m.seo.clicks} clicks · {m.seo.impressions} impressions read</Tag> : null}</div>
      <Field label="NOTE FROM THE TEAM" full><textarea rows={3} maxLength={1500} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: '100%' }} /></Field>
      <iframe title="Monthly report preview" srcDoc={d.report.html} sandbox="" style={{ width: '100%', height: 520, border: '1px solid #e2e8f0', borderRadius: 8, marginTop: 8 }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><Btn onClick={print}>Print or save as PDF</Btn><Btn onClick={copyText}>Copy as text</Btn></div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>The preview shows what is saved: press "Save and make the report" after changing a number. The report is not sent anywhere.</div>
    </Panel>
  );
}
