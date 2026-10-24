import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Panel, Kpis, Kpi, Btn, TinyBtn, DataTable, GsModal, Field, Planned, Banner, fmtNum, fmtDateTime } from '../ui.jsx';
import { SwitchRow, Err, rupees, monthWords } from './adminUtil.jsx';

const WAYS = [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['call', 'Calls (minutes)']];
const wayWord = (c) => (WAYS.find((w) => w[0] === c) || [c, c])[1];

// Add credits = RECORD a recharge (no payment gateway: no card is charged). Admin only.
export function RechargeModal({ onClose, onSaved }) {
  const [f, setF] = useState({ channel: 'whatsapp', amount: '', costRupees: '', note: '', at: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => {
    setErr('');
    if (!(Number(f.amount) > 0)) { setErr('Type how many credits (or minutes) were added.'); return; }
    setBusy(true);
    try { await omni.post('/insights/credits/recharge', { channel: f.channel, amount: Number(f.amount), costRupees: f.costRupees === '' ? 0 : Number(f.costRupees), note: f.note, at: f.at || undefined }); onSaved(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); setBusy(false); }
  };
  return (
    <GsModal title="Add credits" sub="Recorded manually" width={480} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Record the recharge'}</Btn></>}>
      <Banner tone="info">There is no payment gateway here: nothing is charged and no card is used. Buy the credits from your provider, then write the purchase down here so the balance stays true.</Banner>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <Field label="WHICH WAY"><select className="select" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{WAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="CREDITS ADDED" hint={f.channel === 'call' ? 'Minutes added' : 'Number of messages'}><input inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/\D/g, '') })} placeholder="5000" /></Field>
        <Field label="AMOUNT PAID (₹)" hint="Optional"><input inputMode="decimal" value={f.costRupees} onChange={(e) => setF({ ...f, costRupees: e.target.value.replace(/[^\d.]/g, '') })} placeholder="3500" /></Field>
        <Field label="DATE" hint="Empty = today"><input type="date" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} /></Field>
        <Field label="NOTE" full><input value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="For example: Meta top-up, invoice number" /></Field>
      </div>
      <Err text={err} />
    </GsModal>
  );
}

// one person's own monthly credits (Admin)
function AllowanceModal({ person, defaultAllowance, onClose, onSaved }) {
  const [v, setV] = useState(person.ownAllowance === null || person.ownAllowance === undefined ? '' : String(person.ownAllowance));
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const put = async (allowance) => {
    setBusy(true); setErr('');
    try { await omni.put(`/credits/allowance/${person.userId}`, { allowance, note: 'Set in Billing' }); onSaved(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); setBusy(false); }
  };
  return (
    <GsModal title={`Credits for ${person.name}`} sub="Monthly credits for this person" width={440} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn onClick={() => put(null)} disabled={busy}>Back to the default ({fmtNum(defaultAllowance)})</Btn><Btn primary disabled={busy || v === ''} onClick={() => put(Number(v))}>Save</Btn></>}>
      <Field label="CREDITS EVERY MONTH" hint={`Everybody else gets ${fmtNum(defaultAllowance)} unless you give them their own number.`}><input inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ''))} placeholder={String(defaultAllowance)} /></Field>
      <Err text={err} />
    </GsModal>
  );
}

// Credit rules: allowance per person, credits per message, who has no limit, whether sending stops at zero, and the cost of a message (₹, starts at 0)
function Rules({ settings, canEdit, onSaved }) {
  const [s, setS] = useState(settings);
  const [roles, setRoles] = useState((settings.exemptRoles || []).join(', '));
  const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { setS(settings); setRoles((settings.exemptRoles || []).join(', ')); }, [settings]);
  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      await omni.put('/credits/settings', { enforce: s.enforce, allowance: Number(s.allowance), cost: s.cost, unitCost: s.unitCost, exemptRoles: roles.split(/[,\s]+/).filter(Boolean) });
      setMsg('Saved.'); onSaved();
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  const num = (path, k, v) => setS({ ...s, [path]: { ...s[path], [k]: v.replace(/[^\d.]/g, '') } });
  return (
    <Panel title="Credit rules" sub={canEdit ? 'The rules for every person. Only an Admin can change them.' : 'The rules for every person. Only an Admin can change them, so you can only look.'} right={canEdit ? <Btn primary onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save rules'}</Btn> : null}>
      <div className="adm-form">
        <Field label="CREDITS EACH PERSON GETS EVERY MONTH"><input inputMode="numeric" disabled={!canEdit} value={s.allowance} onChange={(e) => setS({ ...s, allowance: e.target.value.replace(/\D/g, '') })} /></Field>
        {[['email', 'CREDITS FOR ONE EMAIL'], ['whatsapp', 'CREDITS FOR ONE WHATSAPP'], ['sms', 'CREDITS FOR ONE SMS'], ['call', 'CREDITS FOR ONE LOGGED CALL']].map(([k, l]) => <Field key={k} label={l}><input inputMode="numeric" disabled={!canEdit} value={s.cost[k]} onChange={(e) => num('cost', k, e.target.value)} /></Field>)}
        <Field label="LOGINS WITH NO LIMIT" hint="Role names, separated by commas (for example SUPER_ADMIN, ADMIN)"><input disabled={!canEdit} value={roles} onChange={(e) => setRoles(e.target.value)} /></Field>
      </div>
      <SwitchRow label="Stop real sending when a person's credits reach zero" note="ON: the person sees a plain message and must ask an Admin. OFF: credits are only counted." on={s.enforce} disabled={!canEdit} onChange={(v) => setS({ ...s, enforce: v })} />
      <div className="panel-title" style={{ marginTop: 14 }}>Cost of one message (₹)</div>
      <div className="adm-note">What one message really costs you at your provider. It starts at ₹0: nothing is invented. Type the price to see the cost in the tables above.</div>
      <div className="adm-form">
        {[['email', 'EMAIL'], ['whatsapp', 'WHATSAPP'], ['sms', 'SMS'], ['callPerMinute', 'CALL, PER MINUTE']].map(([k, l]) => <Field key={k} label={l}><input inputMode="decimal" disabled={!canEdit} value={s.unitCost[k]} onChange={(e) => num('unitCost', k, e.target.value)} /></Field>)}
      </div>
      <Err text={err} />{msg && <Banner tone="ok">{msg}</Banner>}
    </Panel>
  );
}

// the company view: Admin (everything) and Finance (read only except the export)
export default function BillingCompany({ co, canRecharge, canEditRules, reload, toast, onAdd }) {
  const [edit, setEdit] = useState(null);
  const totalMsgs = co.channels.reduce((n, c) => n + c.messages, 0) || 0;
  const unitZero = Object.values(co.unitCost).every((v) => !v);
  const peopleCols = [
    { id: 'name', label: 'Person', sort: (r) => r.name, render: (r) => <b>{r.name}</b> },
    { id: 'department', label: 'Department', sort: (r) => r.department || '', render: (r) => r.department || '—' },
    { id: 'given', label: 'Given', className: 'num', sort: (r) => (r.given === null ? 1e12 : r.given), render: (r) => (r.given === null ? 'No limit' : fmtNum(r.given)) },
    { id: 'used', label: 'Used', className: 'num', sort: (r) => r.used, render: (r) => fmtNum(r.used) },
    { id: 'left', label: 'Left', className: 'num', sort: (r) => (r.left === null ? 1e12 : r.left), render: (r) => (r.left === null ? 'No limit' : <span className={r.left === 0 ? 'sa-over' : ''}>{fmtNum(r.left)}</span>) },
    ...(canEditRules ? [{ id: 'edit', label: '', render: (r) => (r.exempt ? <span className="adm-note">No limit</span> : <TinyBtn onClick={() => setEdit(r)}>Edit credits</TinyBtn>) }] : []),
  ];
  return (
    <>
      <Kpis>
        <Kpi label="Credit balance" icon="✦" value={co.balanceKnown ? fmtNum(co.balanceLeft) : 'Not recorded'} tone={co.balanceKnown && co.balanceLeft <= 0 ? 'down' : 'up'} meta={co.balanceKnown ? 'Bought minus used (without calls)' : 'No recharge is recorded yet'} />
        <Kpi label="Current plan" icon="▤" value="Included in TeamLink" meta="No monthly fee" />
        <Kpi label="Messages this month" icon="✉" value={fmtNum(co.messages)} meta={monthWords(co.month)} />
        <Kpi label="Usage cost" icon="₹" value={rupees(co.totalCost)} meta={unitZero ? 'Type the cost of a message below' : 'Messages x the cost you typed'} />
      </Kpis>

      <Panel title="Credits" sub="Every message spends credits. A person cannot send when their own credits are used up." right={canRecharge ? <Btn primary onClick={onAdd}>＋ Add credits</Btn> : null}>
        <div className="card table-card"><div className="table-scroll"><table className="table">
          <thead><tr><th>Way</th><th className="num">Bought</th><th className="num">Used</th><th className="num">Left</th><th className="num">Paid (₹)</th></tr></thead>
          <tbody>{co.balance.map((b) => (
            <tr key={b.channel}><td><b>{wayWord(b.channel)}</b></td><td className="num">{fmtNum(b.bought)}{b.channel === 'call' ? ' min' : ''}</td><td className="num">{b.channel === 'call' ? 'Not recorded' : fmtNum(b.used)}</td><td className="num">{b.bought ? fmtNum(b.left) : '—'}</td><td className="num">{b.spent ? rupees(b.spent) : '—'}</td></tr>
          ))}</tbody>
        </table></div></div>
        <div className="adm-row" style={{ marginTop: 12 }}><div className="adm-row-main"><b>Top up automatically when credits run low</b><small>There is no payment gateway, so credits cannot be bought here.</small></div><span className="tag">Planned</span></div>
      </Panel>

      <Panel title="Usage this month" sub="Per way: what really went, what was only a test, and what it cost.">
        <div className="card table-card"><div className="table-scroll"><table className="table">
          <thead><tr><th>Way</th><th className="num">Messages sent</th><th className="num">Test messages</th><th className="num">Credits</th><th className="num">Cost per message</th><th className="num">Cost</th><th>Share</th></tr></thead>
          <tbody>{co.channels.map((c) => {
            const unit = (c.channel === 'call' ? co.unitCost.callPerMinute : co.unitCost[c.channel]) || 0;
            const share = totalMsgs ? Math.round((c.messages / totalMsgs) * 100) : 0;
            return <tr key={c.channel}><td><b>{wayWord(c.channel).replace(' (minutes)', '')}</b></td><td className="num">{fmtNum(c.messages)}</td><td className="num">{fmtNum(c.testMessages)}</td><td className="num">{fmtNum(c.credits)}</td><td className="num">{rupees(unit)}{c.channel === 'call' ? ' / min' : ''}</td><td className="num">{rupees(c.cost)}</td><td><span className="adm-bar"><span style={{ width: `${share}%` }} /></span>{share}%</td></tr>;
          })}</tbody>
          <tfoot><tr><td><b>Total</b></td><td className="num"><b>{fmtNum(co.messages)}</b></td><td className="num">{fmtNum(co.channels.reduce((n, c) => n + c.testMessages, 0))}</td><td className="num"><b>{fmtNum(co.creditsUsed)}</b></td><td /><td className="num"><b>{rupees(co.totalCost)}</b></td><td /></tr></tfoot>
        </table></div></div>
        <div className="adm-note">{co.calls.recorded ? `Calling minutes this month: ${fmtNum(co.calls.total)}.` : 'Calling minutes: Not recorded. The calling link does not report minutes yet, so only calls logged by people are counted (they cost no credits).'}</div>
      </Panel>

      <div className="adm-two">
        <Panel title="Usage by department" sub="Real messages this month.">
          <div className="card table-card"><div className="table-scroll"><table className="table"><thead><tr><th>Department</th><th className="num">Messages</th><th className="num">Credits</th><th className="num">Cost</th></tr></thead>
            <tbody>{co.byDepartment.map((d) => <tr key={d.name}><td><b>{d.name}</b></td><td className="num">{fmtNum(d.messages)}</td><td className="num">{fmtNum(d.credits)}</td><td className="num">{rupees(d.cost)}</td></tr>)}{!co.byDepartment.length && <tr><td colSpan={4} className="adm-note">No real message this month.</td></tr>}</tbody></table></div></div>
        </Panel>
        <Panel title="Usage by person" sub="The top fifteen this month.">
          <div className="card table-card"><div className="table-scroll"><table className="table"><thead><tr><th>Person</th><th className="num">Messages</th><th className="num">Credits</th></tr></thead>
            <tbody>{co.byPerson.map((d, i) => <tr key={`${d.name}${i}`}><td><b>{d.name}</b></td><td className="num">{fmtNum(d.messages)}</td><td className="num">{fmtNum(d.credits)}</td></tr>)}{!co.byPerson.length && <tr><td colSpan={3} className="adm-note">No real message this month.</td></tr>}</tbody></table></div></div>
          {co.calls.recorded && <div className="adm-note">Call minutes: {co.calls.rows.map((r) => `${r.name} ${fmtNum(r.minutes)}`).join(' · ')}</div>}
        </Panel>
      </div>

      <Rules settings={co.settings} canEdit={canEditRules} onSaved={reload} />

      <Panel title="Credits of each person" sub="What each person was given this month and has left. An Admin can give one person a different number.">
        <DataTable columns={peopleCols} rows={co.people} rowKey={(r) => r.userId} persistKey="adm_bill_people" searchPlaceholder="Search a person or a department" emptyText="No person with a login yet." pageSizes={[10, 25, 50]} />
      </Panel>

      <Panel title="Recharge history" sub="Every purchase written down by an Admin (Recorded manually).">
        <div className="card table-card"><div className="table-scroll"><table className="table"><thead><tr><th>When</th><th>Way</th><th className="num">Credits added</th><th className="num">Paid (₹)</th><th>Note</th><th>Recorded by</th></tr></thead>
          <tbody>{co.recharges.map((r) => <tr key={r.id}><td>{fmtDateTime(r.at)}</td><td>{wayWord(r.channel)}</td><td className="num">{fmtNum(r.amount)}</td><td className="num">{r.costRupees ? rupees(r.costRupees) : '—'}</td><td>{r.note || '—'}</td><td>{r.byName || '—'}</td></tr>)}{!co.recharges.length && <tr><td colSpan={6} className="adm-note" style={{ textAlign: 'center', padding: 22 }}>No recharge written down yet.</td></tr>}</tbody></table></div></div>
      </Panel>

      <div className="adm-two">
        <Panel title="Plan" sub="TeamLink has no paid plan."><div className="plan-card on" style={{ marginTop: 6 }}><div className="plan-tag">Your plan</div><h3>Included in TeamLink</h3><p>Omni-Channel is part of your TeamLink. There is no monthly fee and nothing to upgrade. You only pay your providers for the messages themselves.</p><ul><li>Email, WhatsApp, SMS and call logging</li><li>Credits you control per person</li><li>Every department in one place</li></ul></div></Panel>
        <Panel title="Payment methods and invoices" sub="Not part of TeamLink."><Planned>Payment methods, GST invoices and automatic top-up need a payment gateway. They are planned; nothing is faked. Today you record a purchase by hand with "Add credits".</Planned></Panel>
      </div>
      {edit && <AllowanceModal person={edit} defaultAllowance={co.settings.allowance} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); toast('Credits saved'); reload(); }} />}
    </>
  );
}
