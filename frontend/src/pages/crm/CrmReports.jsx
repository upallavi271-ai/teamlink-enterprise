// CRM > DASHBOARD - the report tabs and the settings (2026-11-02, the full CRM):
//   TeamTargets     every BDE this month: leads added, converted, calls, meetings, won (count, ₹), open pipeline, target and
//                   how much of it is done; the BDE TL / Admin set each target right in the table. A BDE sees their own row.
//   ForecastFunnel  open deals by the month they should close (late / this month / next two / later / no date), the funnel of
//                   this month's leads, and the deals going cold (nothing logged for N days)
//   CrmSettings     lead sources, lost reasons, the probability of each stage, the "going cold" days, proposal validity
import { useEffect, useState } from 'react';
import api from '../../api';
import CrmAutoSettings from './CrmAutoSettings.jsx';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, money, moneyShort, dateOf, RecLink, istToday } from './crmShared.jsx';

const monthLabel = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const shift = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

export function useReports(month) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.get('/crm/reports', { params: { month } }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The report could not be read.')));
  useEffect(() => { setD(null); load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps
  return { d, err, load };
}

export function MonthPicker({ month, setMonth }) {
  const now = istToday().slice(0, 7);
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <button type="button" className="btn btn-sm" onClick={() => setMonth(shift(month, -1))} aria-label="Previous month">‹</button>
      <b style={{ minWidth: 130, textAlign: 'center', fontSize: 13 }}>{monthLabel(month)}</b>
      <button type="button" className="btn btn-sm" disabled={month >= now} onClick={() => setMonth(shift(month, 1))} aria-label="Next month">›</button>
    </span>
  );
}

function TargetCell({ row, month, onSaved }) {
  const { me, toast } = useCrm();
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState('');
  if (!me.canAssign || row.former) return <span>{row.target ? moneyShort(row.target) : '—'}</span>;
  async function save() {
    try { await api.put('/crm/targets', { month, ownerId: row.ownerId, amount: v || 0 }); toast(`Target saved for ${row.ownerName}.`); setEdit(false); onSaved(); } catch (e) { toast(errOf(e, 'The target could not be saved.')); }
  }
  if (!edit) return <button type="button" className="btn btn-sm" onClick={() => { setV(row.target || ''); setEdit(true); }} title="Set the target (won value this month)">{row.target ? moneyShort(row.target) : 'Set'}</button>;
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <input type="number" min={0} value={v} onChange={(e) => setV(e.target.value)} style={{ width: 110 }} aria-label={`Target for ${row.ownerName} in ₹`} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(false); }} />
      <button type="button" className="btn btn-sm btn-primary" onClick={save}>Save</button>
    </span>
  );
}

const Bar = ({ pct }) => (
  <div className="crm-bars" style={{ minWidth: 70 }}><div className="bar"><span style={{ width: `${Math.min(100, pct || 0)}%`, background: pct >= 100 ? 'var(--teal)' : undefined }} /></div></div>
);

export function TeamTargets() {
  const { me } = useCrm();
  const [month, setMonth] = useState(istToday().slice(0, 7));
  const { d, err, load } = useReports(month);
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="section-label" style={{ margin: 0 }}>{me.seesAll ? 'Sales team: performance and targets' : 'My month and my target'}</div>
        <span style={{ marginLeft: 'auto' }}><MonthPicker month={month} setMonth={setMonth} /></span>
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      {!d && !err && <div className="small-muted">Loading…</div>}
      {d && (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Salesperson</th><th style={{ textAlign: 'right' }}>Leads added</th><th style={{ textAlign: 'right' }}>Converted</th><th style={{ textAlign: 'right' }}>Calls</th><th style={{ textAlign: 'right' }}>Meetings</th>
                <th style={{ textAlign: 'right' }}>Won</th><th style={{ textAlign: 'right' }}>Lost</th><th style={{ textAlign: 'right' }}>Open pipeline</th><th>Target</th><th>Done</th>
              </tr>
            </thead>
            <tbody>
              {!d.performance.length && <tr><td colSpan={10} className="small-muted">No one on the sales team yet.</td></tr>}
              {d.performance.map((r) => (
                <tr key={r.ownerId}>
                  <td><b>{r.ownerName}</b>{r.former ? <span className="small-muted"> (not on the sales team now)</span> : null}</td>
                  <td style={{ textAlign: 'right' }}>{r.leads}</td>
                  <td style={{ textAlign: 'right' }}>{r.converted}</td>
                  <td style={{ textAlign: 'right' }}>{r.calls}</td>
                  <td style={{ textAlign: 'right' }}>{r.meetings}</td>
                  <td style={{ textAlign: 'right' }}>{r.won ? <><b>{moneyShort(r.wonValue)}</b> <span className="small-muted">({r.won})</span></> : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{r.lost || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{r.openDeals ? <>{moneyShort(r.openValue)} <span className="small-muted">({r.openDeals})</span></> : '—'}</td>
                  <td><TargetCell row={r} month={month} onSaved={load} /></td>
                  <td>{r.achievement != null ? <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Bar pct={r.achievement} /><span style={{ fontSize: 12, fontWeight: 600 }}>{r.achievement}%</span></div> : <span className="small-muted">—</span>}</td>
                </tr>
              ))}
              {d.performance.length > 1 && (
                <tr style={{ background: 'var(--line-soft)' }}>
                  <td><b>Team</b></td>
                  <td style={{ textAlign: 'right' }}>{d.totals.leads}</td><td style={{ textAlign: 'right' }}>{d.totals.converted}</td><td style={{ textAlign: 'right' }}>{d.totals.calls}</td><td style={{ textAlign: 'right' }}>{d.totals.meetings}</td>
                  <td style={{ textAlign: 'right' }}><b>{moneyShort(d.totals.wonValue)}</b> <span className="small-muted">({d.totals.won})</span></td>
                  <td style={{ textAlign: 'right' }}>{d.totals.lost}</td>
                  <td style={{ textAlign: 'right' }}>{moneyShort(d.totals.openValue)}</td>
                  <td>{d.totals.target ? moneyShort(d.totals.target) : '—'}</td>
                  <td>{d.totals.achievement != null ? `${d.totals.achievement}%` : '—'}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="small-muted" style={{ marginTop: 8, fontSize: 11.5 }}>Target = the value of deals won in the month. {me.canAssign ? 'Click "Set" to give a salesperson their target.' : 'Your sales manager sets the targets.'}</div>
    </div>
  );
}

export function ForecastFunnel() {
  const { me } = useCrm();
  const month = istToday().slice(0, 7);
  const { d, err } = useReports(month);
  if (err) return <div className="notice" role="alert">{err}</div>;
  if (!d) return <div className="small-muted">Loading…</div>;
  const maxF = Math.max(1, ...d.forecast.map((f) => f.value));
  const top = Math.max(1, d.funnel[0].count);
  return (
    <div className="crm-dash">
      <div className="card">
        <div className="section-label" style={{ marginTop: 0 }}>Forecast: open deals by expected close</div>
        <div className="crm-bars">
          {d.forecast.map((f) => (
            <div className="row" key={f.key}>
              <div style={{ color: f.key === 'late' && f.count ? 'var(--red)' : undefined }}>{f.label}</div>
              <div className="bar"><span style={{ width: `${(f.value / maxF) * 100}%`, background: f.key === 'late' ? 'var(--red)' : undefined }} /></div>
              <div className="n">{f.count ? moneyShort(f.value) : '—'}</div>
            </div>
          ))}
        </div>
        <div className="small-muted" style={{ marginTop: 8, fontSize: 11.5 }}>
          Likely (value × probability): this month {moneyShort((d.forecast.find((f) => f.key === month) || {}).weighted)}, next month {moneyShort((d.forecast[2] || {}).weighted)}.
          {d.forecast[0].count ? ' Late deals: update their close date or close them.' : ''}
        </div>
      </div>
      <div className="card">
        <div className="section-label" style={{ marginTop: 0 }}>Lead funnel: leads added this month</div>
        <div className="crm-bars">
          {d.funnel.map((f, i) => (
            <div className="row" key={f.step}>
              <div>{f.step}</div>
              <div className="bar"><span style={{ width: `${(f.count / top) * 100}%` }} /></div>
              <div className="n">{f.count}{i > 0 && d.funnel[0].count ? ` · ${Math.round((f.count / d.funnel[0].count) * 100)}%` : ''}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="section-label" style={{ marginTop: 0 }}>Going cold: open deals with nothing logged for {d.staleDays}+ days</div>
        {!d.stale.length && <div className="small-muted">None. Every open deal had a call, meeting or note in the last {d.staleDays} days.</div>}
        {d.stale.map((x) => (
          <div key={x.id} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <RecLink kind="deal" id={x.id}>{x.title}</RecLink>
              <div className="small-muted" style={{ fontSize: 11.5 }}>{[x.accountName, x.stage, me.seesAll ? x.ownerName : null].filter(Boolean).join(' · ')}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 600 }}>{money(x.value)}</div>
              <div className="small-muted" style={{ fontSize: 11.5, color: 'var(--red)' }}>{x.days} days quiet{x.lastActivityAt ? ` · last ${dateOf(x.lastActivityAt)}` : ''}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Sample data to try every screen (crm/sample.js): load / remove, a sales manager or Admin
function SampleData() {
  const { toast } = useCrm();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/crm/sample').then((r) => setSt(r.data)).catch(() => setSt(null));
  useEffect(() => { load(); }, []);
  async function act(on) {
    setBusy(true);
    try {
      const r = on ? await api.post('/crm/sample') : await api.delete('/crm/sample');
      toast(on ? `Sample data loaded: ${r.data.counts.leads} leads, ${r.data.counts.deals} deals, ${r.data.counts.tickets} tickets.` : 'Sample data removed.');
      setTimeout(() => window.location.reload(), 900);
    } catch (e) { toast(errOf(e, 'This did not work.')); setBusy(false); }
  }
  if (!st) return null;
  return (
    <div className="card" style={{ padding: 12, marginBottom: 14, background: 'var(--line-soft)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <b>Sample data</b>
          <div className="small-muted" style={{ fontSize: 12.5 }}>
            {st.loaded
              ? `Loaded by ${st.by || '—'}: ${st.counts.leads} leads, ${st.counts.accounts} accounts, ${st.counts.deals} deals, ${st.counts.tickets} tickets. Every name starts with "Sample ·".`
              : 'Fill the CRM with a small sample sales book (leads, accounts, deals in every stage, calls, follow-ups, tickets, a target, a proposal) to try every screen. No message is sent for it; remove it in one click.'}
          </div>
        </div>
        {st.loaded
          ? <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => act(false)}>{busy ? 'Removing…' : 'Remove sample data'}</button>
          : <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(true)}>{busy ? 'Loading…' : 'Load sample data'}</button>}
      </div>
    </div>
  );
}

// The form for the company's website: the key, round-robin owners, and the code to paste on the site (POST /api/crm/leads/public).
function WebsiteForm() {
  const { toast } = useCrm();
  const [w, setW] = useState(null);
  useEffect(() => { api.get('/crm/website').then((r) => setW(r.data)).catch(() => setW(null)); }, []);
  if (!w) return null;
  const url = `${window.location.origin}/api/crm/leads/public`;
  const code = [
    '<form id="tl-lead-form">',
    '  <input name="name" placeholder="Your name" required>',
    '  <input name="company" placeholder="Company">',
    '  <input name="phone" placeholder="Phone">',
    '  <input name="email" type="email" placeholder="Email">',
    '  <textarea name="message" placeholder="How can we help?"></textarea>',
    '  <input name="website_url" style="display:none" tabindex="-1" autocomplete="off">',
    '  <button type="submit">Send</button>',
    '</form>',
    '<script>',
    "document.getElementById('tl-lead-form').addEventListener('submit', function (e) {",
    '  e.preventDefault();',
    '  var f = e.target, b = Object.fromEntries(new FormData(f)), q = new URLSearchParams(location.search);',
    "  b.utm_source = q.get('utm_source') || ''; b.utm_medium = q.get('utm_medium') || ''; b.utm_campaign = q.get('utm_campaign') || ''; b.page_url = location.href;",
    `  fetch('${url}', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': '${w.key}' }, body: JSON.stringify(b) })`,
    "    .then(function (r) { if (!r.ok) throw 0; f.reset(); alert('Thank you, we will contact you soon.'); })",
    "    .catch(function () { alert('Sorry, this could not be sent. Please try again.'); });",
    '});',
    '</script>',
  ].join('\n');
  async function auto(v) {
    try { const r = await api.put('/crm/website', { autoAssign: v }); setW(r.data); toast('Saved.'); } catch (e) { toast(errOf(e, 'This could not be saved.')); }
  }
  async function renew() {
    if (!window.confirm('Make a new key? Forms already on your website stop working until you paste the new code.')) return;
    try { const r = await api.post('/crm/website/key'); setW({ ...w, key: r.data.key }); toast('A new key is ready.'); } catch (e) { toast(errOf(e, 'This could not be changed.')); }
  }
  return (
    <>
      <div className="section-label">Website form</div>
      <p className="small-muted" style={{ marginTop: 0 }}>Paste this on your website. Leads come in with Source = Website, and with the page and the campaign (UTM) they came from. The same phone or email again is added as a note on the lead already here.</p>
      <label style={{ display: 'block', marginBottom: 8 }}><input type="checkbox" checked={w.autoAssign} onChange={(e) => auto(e.target.checked)} style={{ width: 'auto' }} /> Give new website leads to the sales team in turn (otherwise they wait with no owner)</label>
      <textarea readOnly rows={8} value={code} aria-label="The website form code" style={{ fontFamily: 'monospace', fontSize: 11.5 }} />
      <div style={{ display: 'flex', gap: 6, margin: '6px 0 14px' }}>
        <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard.writeText(code).then(() => toast('Copied.')).catch(() => toast('Please select the text and copy it.'))}>Copy code</button>
        <button type="button" className="btn btn-sm" onClick={renew}>Make a new key</button>
      </div>
    </>
  );
}

export function CrmSettings({ onClose, onSaved }) {
  const { me, toast } = useCrm();
  const L = me.lists;
  const [f, setF] = useState({ sources: L.sources.join('\n'), lostReasons: L.lostReasons.join('\n'), stageProbability: { ...L.stageProbability }, staleDays: L.staleDays, proposalValidityDays: L.proposalValidityDays, discountApprovalLimit: me.discountApprovalLimit ?? 10, salesTeam: (me.salesTeam || []).map((m) => ({ ...m, rights: { ...(m.rights || {}) } })),
    invoiceFrom: { ...(me.invoiceFrom || {}) }, invoiceTaxPercent: me.invoiceTaxPercent ?? 18, invoiceDueDays: me.invoiceDueDays ?? 15, meetingLink: me.meetingLink || '', bookingHours: { ...(me.bookingHours || { from: '10:00', to: '18:00', minutes: 30 }) } });
  const RIGHT_WORDS = { create: 'Add', edit: 'Change', delete: 'Delete', import: 'Import', export: 'Download', reports: 'Team reports' };
  const roleRights = (me.team && me.team.roleRights) || {};
  const setMember = (i, patchM) => setF((x) => ({ ...x, salesTeam: x.salesTeam.map((y, j) => (j === i ? { ...y, ...patchM } : y)) }));
  const setInv = (k, v) => setF((x) => ({ ...x, invoiceFrom: { ...x.invoiceFrom, [k]: v } }));
  // the people picker for the sales team
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return undefined; }
    const t = setTimeout(() => api.get('/crm/people', { params: { q } }).then((r) => setFound(r.data.people)).catch(() => setFound([])), 300);
    return () => clearTimeout(t);
  }, [q]);
  const addMember = (p) => { setF((x) => (x.salesTeam.some((m) => m.userId === p.id) ? x : { ...x, salesTeam: [...x.salesTeam, { userId: p.id, name: p.name, role: 'rep', seeAll: false, rights: { ...(roleRights.rep || {}) } }] })); setQ(''); setFound([]); };
  const [stages, setStages] = useState(L.leadStages.map((s) => ({ ...s })));
  const [before, setBefore] = useState(String(L.defaultRemindBefore));
  const open = stages.filter((s) => !['Won', 'Lost'].includes(s.name));
  const setOpen = (list) => setStages([...list, ...stages.filter((s) => ['Won', 'Lost'].includes(s.name))]);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.put('/crm/settings', { ...f, sources: f.sources.split('\n'), lostReasons: f.lostReasons.split('\n'), leadStages: stages, defaultRemindBefore: Number(before) });
      toast('CRM settings saved.'); onSaved();
    } catch (e) { toast(errOf(e, 'The settings could not be saved.')); } finally { setBusy(false); }
  }
  return (
    <Modal title="CRM settings" size="wide" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <SampleData />
      <div className="section-label" style={{ marginTop: 0 }}>Sales team and rights</div>
      <p className="small-muted" style={{ marginTop: 0 }}>Only the people listed here open the CRM (with Super Admin / Admin) - nothing comes from ATS roles. A <b>Sales manager</b> has every right and gives records to others; a <b>Salesperson</b> works their own records (tick &quot;Sees everyone&#39;s&quot; to let them read the team&#39;s); a <b>Viewer</b> reads only. Untick a right to take it away from one person.</p>
      {f.salesTeam.map((m, i) => (
        <div key={m.userId} className="crm-member">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, fontSize: 13, minWidth: 140 }}><b>{m.name || m.userId}</b></span>
            <select value={m.role} onChange={(e) => setMember(i, { role: e.target.value, rights: { ...(roleRights[e.target.value] || {}) }, seeAll: e.target.value !== 'rep' })} style={{ width: 150 }} aria-label={`Role of ${m.name}`}>
              <option value="rep">Salesperson</option><option value="manager">Sales manager</option><option value="viewer">Viewer (read only)</option>
            </select>
            {m.role === 'rep' && <label className="crm-right"><input type="checkbox" checked={!!m.seeAll} onChange={(e) => setMember(i, { seeAll: e.target.checked })} /> Sees everyone&#39;s</label>}
            <button type="button" className="btn btn-sm" onClick={() => setF((x) => ({ ...x, salesTeam: x.salesTeam.filter((_, j) => j !== i) }))} aria-label={`Remove ${m.name}`}>Remove</button>
          </div>
          {m.role !== 'manager' && (
            <div className="crm-rights">
              {Object.keys(RIGHT_WORDS).map((k) => {
                const locked = m.role === 'viewer' && ['create', 'edit', 'delete', 'import'].includes(k);
                return <label key={k} className="crm-right" title={locked ? 'A viewer only reads' : undefined}><input type="checkbox" disabled={locked} checked={!locked && !!(m.rights || {})[k]} onChange={(e) => setMember(i, { rights: { ...(m.rights || {}), [k]: e.target.checked } })} /> {RIGHT_WORDS[k]}</label>;
              })}
            </div>
          )}
        </div>
      ))}
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <input type="text" placeholder="Add a person: type a name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Add a person to the sales team" />
        {found.length > 0 && (
          <div className="card" style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, padding: 4, maxHeight: 220, overflow: 'auto' }}>
            {found.map((p) => (
              <button key={p.id} type="button" className="btn btn-sm" style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', marginBottom: 2 }} onClick={() => addMember(p)}>
                {p.name} <span className="small-muted">{p.email}{p.role ? ` · ${p.role}` : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="section-label">Invoices</div>
      <p className="small-muted" style={{ marginTop: 0 }}>What every CRM invoice says about us. The CRM keeps its own invoices; nothing goes to Accounts.</p>
      <div className="grid-2">
        <div className="field"><label>Company name</label><input type="text" value={f.invoiceFrom.name || ''} onChange={(e) => setInv('name', e.target.value)} /></div>
        <div className="field"><label>GSTIN</label><input type="text" value={f.invoiceFrom.gstin || ''} onChange={(e) => setInv('gstin', e.target.value)} /></div>
        <div className="field"><label>Address</label><textarea rows={2} value={f.invoiceFrom.address || ''} onChange={(e) => setInv('address', e.target.value)} /></div>
        <div className="field"><label>Bank details (shown on the invoice)</label><textarea rows={2} value={f.invoiceFrom.bank || ''} onChange={(e) => setInv('bank', e.target.value)} /></div>
        <div className="field"><label>Email</label><input type="email" value={f.invoiceFrom.email || ''} onChange={(e) => setInv('email', e.target.value)} /></div>
        <div className="field"><label>Phone</label><input type="text" value={f.invoiceFrom.phone || ''} onChange={(e) => setInv('phone', e.target.value)} /></div>
        <div className="field"><label>Tax % (GST)</label><input type="number" min={0} max={50} value={f.invoiceTaxPercent} onChange={(e) => setF({ ...f, invoiceTaxPercent: e.target.value })} /></div>
        <div className="field"><label>Payment due after (days)</label><input type="number" min={0} max={180} value={f.invoiceDueDays} onChange={(e) => setF({ ...f, invoiceDueDays: e.target.value })} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Payment terms</label><input type="text" value={f.invoiceFrom.terms || ''} onChange={(e) => setInv('terms', e.target.value)} /></div>
      </div>
      <div className="section-label">Meetings a lead books</div>
      <div className="grid-2">
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Meeting link (Google Meet / Zoom)</label><input type="url" placeholder="https://meet.google.com/..." value={f.meetingLink} onChange={(e) => setF({ ...f, meetingLink: e.target.value })} /></div>
        <div className="field"><label>Slots from</label><input type="time" value={f.bookingHours.from} onChange={(e) => setF({ ...f, bookingHours: { ...f.bookingHours, from: e.target.value } })} /></div>
        <div className="field"><label>Slots until</label><input type="time" value={f.bookingHours.to} onChange={(e) => setF({ ...f, bookingHours: { ...f.bookingHours, to: e.target.value } })} /></div>
        <div className="field"><label>Each meeting</label><select value={f.bookingHours.minutes} onChange={(e) => setF({ ...f, bookingHours: { ...f.bookingHours, minutes: Number(e.target.value) } })}><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={45}>45 minutes</option><option value={60}>1 hour</option></select></div>
      </div>
      <div className="grid-2">
        <div className="field"><label>Lead sources (one per line)</label><textarea rows={8} value={f.sources} onChange={(e) => setF({ ...f, sources: e.target.value })} /></div>
        <div className="field"><label>Reasons a deal is lost (one per line)</label><textarea rows={8} value={f.lostReasons} onChange={(e) => setF({ ...f, lostReasons: e.target.value })} /></div>
      </div>
      <div className="section-label">Lead stages</div>
      <p className="small-muted" style={{ marginTop: 0 }}>The columns of the Leads board. Won and Lost always stay, last. A lead on a stage you remove goes back to the first stage.</p>
      {open.map((s, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>{/* eslint-disable-line react/no-array-index-key */}
          <input type="color" value={s.color} onChange={(e) => setOpen(open.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} aria-label={`Colour of ${s.name}`} style={{ width: 38, padding: 2 }} />
          <input type="text" value={s.name} maxLength={40} onChange={(e) => setOpen(open.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Stage name" style={{ flex: 1 }} />
          <button type="button" className="btn btn-sm" disabled={i === 0} aria-label={`Move ${s.name} up`} onClick={() => { const n = [...open]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setOpen(n); }}>↑</button>
          <button type="button" className="btn btn-sm" disabled={i === open.length - 1} aria-label={`Move ${s.name} down`} onClick={() => { const n = [...open]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setOpen(n); }}>↓</button>
          <button type="button" className="btn btn-sm" disabled={open.length === 1} aria-label={`Remove ${s.name}`} onClick={() => setOpen(open.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" style={{ marginBottom: 14 }} onClick={() => setOpen([...open, { name: '', color: '#64748b' }])}>+ Stage</button>
      <div className="field" style={{ maxWidth: 260 }}><label>Default reminder for a new follow-up</label><select value={before} onChange={(e) => setBefore(e.target.value)}><option value="0">At the time</option><option value="15">15 minutes before</option><option value="60">1 hour before</option><option value="1440">1 day before</option></select></div>
      <WebsiteForm />
      <CrmAutoSettings />
      <div className="section-label">Probability of each stage (%)</div>
      <div className="grid-3">
        {L.stages.filter((s) => s !== 'Won' && s !== 'Lost').map((s) => (
          <div className="field" key={s}><label>{s}</label><input type="number" min={0} max={100} value={f.stageProbability[s]} onChange={(e) => setF({ ...f, stageProbability: { ...f.stageProbability, [s]: e.target.value } })} /></div>
        ))}
      </div>
      <div className="grid-2">
        <div className="field"><label>A deal is "going cold" after this many days with nothing logged</label><input type="number" min={1} max={365} value={f.staleDays} onChange={(e) => setF({ ...f, staleDays: e.target.value })} /></div>
        <div className="field"><label>A proposal is valid for (days)</label><input type="number" min={1} max={365} value={f.proposalValidityDays} onChange={(e) => setF({ ...f, proposalValidityDays: e.target.value })} /></div>
        <div className="field"><label>A deal discount above this % needs a manager&#39;s approval</label><input type="number" min={0} max={100} value={f.discountApprovalLimit} onChange={(e) => setF({ ...f, discountApprovalLimit: e.target.value })} /></div>
      </div>
      <div className="small-muted">"Other" is always kept in both lists. The deal stages stay as they are, so the board and the reports keep working. A new probability applies the next time a deal moves.</div>
    </Modal>
  );
}
