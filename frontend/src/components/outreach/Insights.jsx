import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import { Block } from './Dashboard.jsx';
import './omni2.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > INSIGHTS (Analytics Hub): Performance, Credits, ROI. (Reports lives in OverviewReports.jsx.)
// Every number is read from real rows; where a link cannot be proven the screen says "not linked". Servers: /api/outreach/insights/*.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const thisMonth = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
const rupee = (n) => `Rs ${(Math.round((n || 0) * 100) / 100).toLocaleString('en-IN')}`;
const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '');
const WAY = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS', call: 'Calls' };

function MonthBar({ month, setMonth, children }) {
  return <div className="oc-bar"><label className="field" style={{ margin: 0 }}><span>Month</span><input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>{children}</div>;
}
function useLoad(url, month) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => { setD(null); api.get(url, { params: { month } }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The numbers could not be loaded.'))); }, [url, month]);
  useEffect(() => { load(); }, [load]);
  return [d, err, load];
}

export function Performance({ acc }) {
  const [month, setMonth] = useState(thisMonth());
  const [d, err] = useLoad('/outreach/insights/performance', month);
  const [dl, setDl] = useState(false);
  const csv = async () => { setDl(true); try { const r = await api.get('/outreach/activity.csv', { params: { month }, responseType: 'blob' }); const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = `omni-performance-${month}.csv`; a.click(); } catch { /* not allowed */ } finally { setDl(false); } };
  return (
    <div>
      <MonthBar month={month} setMonth={setMonth}>{acc.canExportActivity && <button type="button" className="btn" disabled={dl} onClick={csv}>Download CSV</button>}{d && <span className="oc-note">{d.scopeWords}</span>}</MonthBar>
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!d && !err && <div className="oc-note">Loading…</div>}
      {d && <>
        <Block b={{ id: 't', title: 'Totals', tiles: [{ label: 'People', value: d.totals.people }, { label: 'Credits used', value: d.totals.used }, { label: 'Messages sent', value: d.totals.sent }, { label: 'Rehearsed (not real)', value: d.totals.testSent }, { label: 'Follow-ups done', value: d.totals.followUps }, { label: 'Promotions', value: d.totals.promotions }, { label: 'Joinings', value: d.totals.joinings, tone: 'g' }] }} />
        <Block b={{ id: 'p', title: 'Recruiters', head: ['Name', 'Department', 'Credits used', 'Messages', 'Follow-ups', 'Promotions', 'Joinings'], rows: d.rows.map((r) => [r.name, r.department, r.used, r.sent, r.followUps, r.promotions, r.joinings]) }} />
        <Block b={{ id: 'd', title: 'By department', head: ['Department', 'People', 'Credits used', 'Messages', 'Joinings'], rows: d.byDepartment.map((x) => [x.name, x.people, x.used, x.sent, x.joinings]) }} />
        <Block b={{ id: 'c', title: 'Campaigns (last 30 days)', head: ['Campaign', 'Sent', 'Delivered', 'Applied', 'Failed'], rows: d.topCampaigns.map((c) => [`${c.name} (${c.channel})`, c.sent, c.delivered, c.applied, c.failed]) }} />
      </>}
    </div>
  );
}

export function Roi() {
  const [month, setMonth] = useState(thisMonth());
  const [d, err] = useLoad('/outreach/insights/roi', month);
  const nl = (v) => (v === null || v === undefined ? 'not linked' : v);
  return (
    <div>
      <MonthBar month={month} setMonth={setMonth}>{d && <span className="oc-note">{d.scopeWords}</span>}</MonthBar>
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!d && !err && <div className="oc-note">Loading…</div>}
      {d && <>
        <div className="bc-warn" role="note">{d.notes.map((n) => <div key={n}>{n}</div>)}</div>
        <Block b={{ id: 'a', title: 'By person (same month)', head: ['Name', 'Department', 'Credits used', 'Cost', 'Replies', 'Interviews booked', 'Joinings', 'Cost per joining'], rows: d.persons.map((p) => [p.name, p.department, p.credits, rupee(p.cost), p.replies, p.interviews, p.joinings, p.perJoining === null ? 'no joining' : rupee(p.perJoining)]) }} />
        <Block b={{ id: 'b', title: 'By department (same month)', head: ['Department', 'People', 'Credits used', 'Cost', 'Replies', 'Interviews', 'Joinings'], rows: d.departments.map((x) => [x.name, x.people, x.credits, rupee(x.cost), x.replies, x.interviews, x.joinings]) }} />
        <Block b={{ id: 'c', title: 'By campaign (last 90 days)', head: ['Campaign', 'Way', 'Credits used', 'Cost', 'Sent', 'Opened link', 'Applied', 'Interviews', 'Joined', 'Replies'], rows: d.campaigns.map((c) => [`${c.name}${c.live ? '' : ' (rehearsal)'}`, WAY[c.channel] || c.channel, c.credits, rupee(c.cost), c.sent, c.opened, nl(c.applied), nl(c.interviews), nl(c.joined), c.replies]) }} />
      </>}
    </div>
  );
}

export function CreditsHub({ acc }) {
  const [month, setMonth] = useState(thisMonth());
  const [d, err, load] = useLoad('/outreach/insights/credits', month);
  const [rc, setRc] = useState({ channel: 'whatsapp', amount: '', costRupees: '', note: '' });
  const [unit, setUnit] = useState(null);
  const [msg, setMsg] = useState('');
  const [e2, setE2] = useState('');
  useEffect(() => { if (d && !unit) setUnit({ ...d.unitCost }); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async () => { setE2(''); setMsg(''); try { await api.post('/outreach/insights/credits/recharge', { ...rc, amount: Number(rc.amount), costRupees: Number(rc.costRupees || 0) }); setRc({ ...rc, amount: '', costRupees: '', note: '' }); setMsg('Recharge saved.'); load(); } catch (e) { setE2(errOf(e, 'It could not be saved.')); } };
  const saveUnit = async () => { setE2(''); setMsg(''); try { await api.put('/outreach/credits/settings', { unitCost: Object.fromEntries(Object.entries(unit).map(([k, v]) => [k, Number(v) || 0])) }); setMsg('Unit costs saved.'); load(); } catch (e) { setE2(errOf(e, 'It could not be saved.')); } };
  return (
    <div>
      <MonthBar month={month} setMonth={setMonth} />
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!d && !err && <div className="oc-note">Loading…</div>}
      {d && <>
        <Block b={{ id: 'u', title: 'Usage this month', tiles: d.channels.map((c) => ({ label: `${WAY[c.channel]}: ${c.channel === 'call' ? 'calls logged' : 'messages sent'}${c.testMessages ? ` (+${c.testMessages} rehearsed)` : ''}`, value: c.messages })).concat([{ label: 'Messaging cost', value: rupee(d.totalCost), tone: 'o' }]) }} />
        <Block b={{ id: 'b', title: 'Credits bought, used and left (all time)', head: ['Way', 'Bought', 'Used', 'Left', 'Paid'], rows: d.balance.map((b) => [WAY[b.channel], b.bought, b.channel === 'call' ? 'minutes not tracked' : b.used, b.channel === 'call' ? b.bought : b.left, rupee(b.spent)]), note: 'Left = what you recorded as bought minus what the app counted as used. Record every recharge below.' }} />
        <Block b={{ id: 'c', title: 'Consumption by department', head: ['Department', 'Messages', 'Credits', 'Cost'], rows: d.byDepartment.map((x) => [x.name, x.messages, x.credits, rupee(x.cost)]) }} />
        <Block b={{ id: 'p', title: 'Top people by credits used', head: ['Name', 'Messages', 'Credits'], rows: d.byPerson.map((x) => [x.name, x.messages, x.credits]) }} />
        <section className="oc2-block"><h3 className="oc2-h">Cost per message</h3>
          {acc.isAdmin && unit ? (
            <>
              <div className="oc2-rule">{['email', 'whatsapp', 'sms', 'callPerMinute'].map((k) => <label className="field" key={k}><span>{{ email: 'One email (Rs)', whatsapp: 'One WhatsApp message (Rs)', sms: 'One SMS (Rs)', callPerMinute: 'One calling minute (Rs)' }[k]}</span><input inputMode="decimal" value={unit[k]} onChange={(e) => setUnit({ ...unit, [k]: e.target.value.replace(/[^\d.]/g, '') })} /></label>)}</div>
              <div className="oc-row2"><button type="button" className="btn" onClick={saveUnit}>Save unit costs</button><span className="oc-note">They start at 0. Type what each way really costs you.</span></div>
            </>
          ) : <div className="oc-note">Unit costs: email {rupee(d.unitCost.email)}, WhatsApp {rupee(d.unitCost.whatsapp)}, SMS {rupee(d.unitCost.sms)}, calling minute {rupee(d.unitCost.callPerMinute)}. An Admin changes them.</div>}
        </section>
        <section className="oc2-block"><h3 className="oc2-h">Recharge history</h3>
          {acc.isAdmin && (
            <div className="oc2-rule">
              <div className="field"><span>Which way</span><Combo value={rc.channel} onChange={(e) => setRc({ ...rc, channel: e.target.value })}><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="email">Email</option><option value="call">Calls (minutes)</option></Combo></div>
              <label className="field"><span>Credits added</span><input inputMode="numeric" value={rc.amount} onChange={(e) => setRc({ ...rc, amount: e.target.value.replace(/[^\d]/g, '') })} /></label>
              <label className="field"><span>Paid (Rs)</span><input inputMode="decimal" value={rc.costRupees} onChange={(e) => setRc({ ...rc, costRupees: e.target.value.replace(/[^\d.]/g, '') })} /></label>
              <label className="field"><span>Note</span><input value={rc.note} maxLength={200} onChange={(e) => setRc({ ...rc, note: e.target.value })} placeholder="Invoice number, provider" /></label>
              <div className="field"><span>&nbsp;</span><button type="button" className="btn btn-primary" disabled={!rc.amount} onClick={add}>Add recharge</button></div>
            </div>
          )}
          {msg && <div className="bc-ok" role="status">{msg}</div>}
          {e2 && <div className="bc-err" role="alert">{e2}</div>}
          {d.recharges.length === 0 ? <div className="oc-note">No recharge recorded yet.</div> : <div className="oc-scroll oc2-act"><table className="oc2-table"><thead><tr><th>Date</th><th>Way</th><th className="num">Credits</th><th className="num">Paid</th><th>Note</th><th>By</th></tr></thead><tbody>{d.recharges.map((r) => <tr key={r.id}><td>{fmt(r.at)}</td><td>{WAY[r.channel]}</td><td className="num">{r.amount}</td><td className="num">{rupee(r.costRupees)}</td><td>{r.note}</td><td>{r.byName}</td></tr>)}</tbody></table></div>}
        </section>
        <div className="oc-note">{d.notes.map((n) => <div key={n}>{n}</div>)}</div>
      </>}
    </div>
  );
}
