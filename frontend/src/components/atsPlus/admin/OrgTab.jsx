import { useEffect, useState } from 'react';
import api from '../../../api';
import BranchesPanel from '../BranchesPanel.jsx';
import { Notice, Section, Table, useLoad, useAction, Field, row } from '../kit.jsx';
import { translations, LanguagePicker } from '../../../i18n.jsx';

// ATS settings -> Organisation: branches (05.11), seats and plan (13.12), currencies (13.07), languages (13.06).
function Seats() {
  const { data, err, reload } = useLoad('/ats-plus/seats');
  const { run, busy, flash } = useAction(reload);
  const [f, setF] = useState(null);
  useEffect(() => { if (data) setF({ plan: data.plan, aiMonthly: data.ai.monthly || '', seats: Object.fromEntries(data.rows.map((r) => [r.role, r.seats ?? ''])) }); }, [data]);
  return (
    <Section title="Seats and plan" note="How many logins each role may have, against the active logins today, and this month's AI use. An over-seat role is flagged; nobody is blocked.">
      <Notice tone="red">{err}</Notice>{flash}
      {data && data.over.length > 0 && <Notice tone="amber">Over the seats: {data.over.join(', ')}</Notice>}
      {data && f && <>
        <Field label="Plan"><input value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })} /></Field>
        <Table rows={data.rows} rowKey={(r) => r.role}
          cols={[{ key: 'label', label: 'Role' }, { key: 'seats', label: 'Seats', render: (r) => <input type="number" min="0" aria-label={`Seats for ${r.label}`} style={{ width: 90 }} value={f.seats[r.role]} onChange={(e) => setF({ ...f, seats: { ...f.seats, [r.role]: e.target.value } })} placeholder="no limit" /> },
            { key: 'used', label: 'Active logins' }, { key: 'free', label: 'Free', render: (r) => (r.seats === null ? '—' : <span style={r.over ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{r.free}</span>) }]} />
        <div style={{ ...row, marginTop: 6 }}><span>AI actions this month: <b>{data.ai.used}</b></span><input type="number" aria-label="AI actions a month" placeholder="AI actions a month (optional)" value={f.aiMonthly} onChange={(e) => setF({ ...f, aiMonthly: e.target.value })} />
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put('/ats-plus/seats', f), 'Saved.')}>Save</button></div>
      </>}
    </Section>
  );
}
function Currency() {
  const { data, err, reload } = useLoad('/ats-plus/currency');
  const { run, busy, flash } = useAction(reload);
  const [rates, setRates] = useState({}); const [add, setAdd] = useState('');
  const [t, setT] = useState({ amount: '1000', from: 'USD', out: null });
  useEffect(() => { if (data) setRates({ ...data.rates }); }, [data]);
  return (
    <Section title="Currencies" note="Rupees (INR) are the base. Type how many rupees one unit of each currency is; amounts in another currency (a job's CTC, a fee) are shown with the rupee value next to them. Stored amounts never change.">
      <Notice tone="red">{err}</Notice>{flash}
      {data && <>
        <div style={row}>{Object.entries(rates).map(([k, v]) => <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>1 {k} = ₹<input type="number" step="0.01" style={{ width: 90 }} aria-label={`Rate ${k}`} value={v} disabled={!data.canEdit} onChange={(e) => setRates({ ...rates, [k]: e.target.value })} /></label>)}</div>
        {data.canEdit && <div style={{ ...row, marginTop: 6 }}><input aria-label="New currency code" placeholder="Code, e.g. JPY" value={add} maxLength={3} onChange={(e) => setAdd(e.target.value.toUpperCase())} /><button type="button" className="btn btn-sm" disabled={add.length !== 3} onClick={() => { setRates({ ...rates, [add]: '' }); setAdd(''); }}>+ Currency</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put('/ats-plus/currency', { rates }), 'Rates saved.')}>Save rates</button></div>}
        <div className="small-muted">{data.updatedAt ? `Rates of ${new Date(data.updatedAt).toLocaleDateString('en-GB')} by ${data.updatedBy}` : 'Starting rates (change them to today\'s).'}</div>
        <div style={{ ...row, marginTop: 8 }}><span>Try:</span><input type="number" aria-label="Amount" value={t.amount} onChange={(e) => setT({ ...t, amount: e.target.value })} style={{ width: 100 }} />
          <select aria-label="From" value={t.from} onChange={(e) => setT({ ...t, from: e.target.value })}>{Object.keys(rates).map((k) => <option key={k}>{k}</option>)}</select>
          <button type="button" className="btn btn-sm" onClick={() => api.get(`/ats-plus/currency/convert?amount=${t.amount}&from=${t.from}`).then((r) => setT({ ...t, out: r.data.value })).catch(() => setT({ ...t, out: null }))}>= ₹</button>{t.out !== null && <b>₹{Number(t.out).toLocaleString('en-IN')}</b>}</div>
      </>}
    </Section>
  );
}
function Languages() {
  const u = useLoad('/ats-plus/i18n/usage');
  return (
    <Section title="Languages" note="English stays the default. Each person picks English, Telugu or Hindi at the bottom of the menu (it follows their login); the candidate pages (pre-boarding, privacy notice) have the same switch.">
      <div style={row}><span>Your language:</span><LanguagePicker /></div>
      <div className="small-muted" style={{ marginTop: 6 }}>Words translated: Telugu {Object.keys(translations.te).length}, Hindi {Object.keys(translations.hi).length}. Words with no translation stay in English.</div>
      {u.data && <div className="small-muted">People using: English {u.data.usage.en}, Telugu {u.data.usage.te}, Hindi {u.data.usage.hi} (those who changed it).</div>}
    </Section>
  );
}
export default function OrgTab() {
  return <><BranchesPanel /><Seats /><Currency /><Languages /></>;
}
