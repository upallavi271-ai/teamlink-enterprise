import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../../api';
import Modal from '../../../components/Modal.jsx';
import './ProofReminderAuto.css';

// WHO GETS EACH ACCOUNTS REMINDER (founder, 2026-10-21): one row per reminder. The Admin / Super Admin chooses the roles and the named people,
// the ways it is sent (bell, email, WhatsApp: only the ones that reminder supports), the timing where it has one, and an On / Off switch.
// "Reset to default" per row, "Send me a test" (only to the Admin who clicks). Until a row is changed it uses the default: Purna Chandra
// and the Accountant role. Backend: routes/accountsReminders.js, utils/accountsReminderSettings.js. Hidden for everyone who is not an Admin.
const GROUPS = [['Proof', 'Payment proofs and the daily summary'], ['Vendors', 'Vendors'], ['Other', 'Joinings, payouts and agreements'], ['Emergency', 'Emergency only']];

function Chip({ children, tone, title }) {
  return <span className={`arr-chip ${tone || ''}`} title={title || ''}>{children}</span>;
}

export default function AccountsReminderSettings({ flash, onChanged }) {
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [edit, setEdit] = useState(null); // the row being edited
  const [busy, setBusy] = useState('');
  const say = (m, tone) => (flash ? flash(m, tone) : null);

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get('/accounts-reminders');
      setData(d);
    } catch (e) { if (e.response && [401, 403].includes(e.response.status)) setHidden(true); }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (hidden || !data) return null;

  const after = async (msg) => { if (msg) say(msg); await load(); if (onChanged) onChanged(); };
  const reset = async (row) => {
    if (!window.confirm(`Put "${row.title}" back to the default (Purna Chandra and the Accountant, the usual ways and times)?`)) return;
    setBusy(`reset${row.key}`);
    try { await api.post(`/accounts-reminders/${row.key}/reset`); await after('Back to the default.'); } catch (e) { say(e.response?.data?.error || 'Could not reset.', 'red'); }
    setBusy('');
  };
  const test = async (row) => {
    setBusy(`test${row.key}`);
    try {
      const { data: d } = await api.post(`/accounts-reminders/${row.key}/test`);
      const bits = Object.values(d.result || {}).filter(Boolean).join('. ');
      say(`${d.message} ${bits}`.trim());
    } catch (e) { say(e.response?.data?.error || 'The test could not be sent.', 'red'); }
    setBusy('');
  };
  const preset = async (name, text) => {
    if (!window.confirm(text)) return;
    setBusy('preset');
    try { await api.put('/accounts-reminders/preset', { preset: name }); await after('Saved.'); } catch (e) { say(e.response?.data?.error || 'Could not save.', 'red'); }
    setBusy('');
  };

  const timingText = (r) => r.timing.map((t) => `${t.label}: ${t.value}`).join(' · ');

  return (
    <div className="prr-box" id="who-gets-each">
      <div className="prr-top">
        <div>
          <h3>Who gets each reminder</h3>
          <div className="small-muted">Choose who receives each Accounts reminder, how it is sent and when. A row you have not changed uses the default: Purna Chandra and anyone with the Accountant role. Nobody else gets it.</div>
        </div>
        <div className="acd-btns" style={{ margin: 0 }}>
          <button type="button" className="btn btn-sm" disabled={busy === 'preset'} onClick={() => preset('accountant-only', 'Put every row back to the default (Purna Chandra and the Accountant)? Your own choices on these rows are removed.')}>Use the default for all</button>
          <button type="button" className="btn btn-sm" disabled={busy === 'preset'} onClick={() => preset('also-admin', 'Also send every Accounts reminder to the Admin and the Super Admin, on top of the people already chosen?')}>Also the Admin and Super Admin</button>
        </div>
      </div>
      {GROUPS.map(([g, label]) => {
        const rows = data.rows.filter((r) => r.group === g);
        if (!rows.length) return null;
        return (
          <div key={g}>
            <h4 style={{ margin: '14px 0 4px', fontSize: 13 }}>{label}</h4>
            <div className="prr-wrap">
              <table className="prr-tbl arr-tbl">
                <thead><tr><th>Reminder</th><th>Who gets it</th><th>How</th><th>When</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td style={{ minWidth: 220 }}>
                        <b>{r.title}</b> <Chip tone={r.on ? 'green' : 'grey'}>{r.on ? 'On' : 'Off'}</Chip> {r.custom && <Chip tone="blue" title="You changed this row">Changed</Chip>}
                        <div className="small-muted">{r.description}</div>
                        {r.warnings.map((w) => <div key={w} className="arr-warn">{w}</div>)}
                      </td>
                      <td style={{ minWidth: 200 }}>
                        {r.roles.map((x) => <Chip key={x.code}>{x.label} role</Chip>)}
                        {r.people.map((p) => <Chip key={p.id} tone={p.active ? '' : 'red'} title={p.active ? '' : 'Switched off: skipped'}>{p.name}{p.active ? '' : ' (off)'}</Chip>)}
                        {r.owner && r.owner.on && <Chip tone="blue">+ {r.owner.label}</Chip>}
                        {!r.roles.length && !r.people.length && <span className="small-muted">Nobody chosen</span>}
                      </td>
                      <td>
                        {r.channels.filter((c) => c.on).map((c) => (
                          <Chip key={c.id} tone={c.health && !c.health.ok ? 'amber' : ''} title={c.health && !c.health.ok ? c.health.note : ''}>{c.label}{c.health && !c.health.ok ? ' (not ready)' : ''}</Chip>
                        ))}
                        {r.channels.filter((c) => c.on && c.health && !c.health.ok).map((c) => <div key={c.id} className="arr-warn">{c.health.note}</div>)}
                      </td>
                      <td className="small-muted">{timingText(r) || 'When it happens'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setEdit(r)}>Edit</button>{' '}
                        <button type="button" className="btn btn-sm" disabled={!r.custom || busy === `reset${r.key}`} onClick={() => reset(r)} title={r.custom ? 'Back to the default' : 'Already the default'}>Reset to default</button>{' '}
                        <button type="button" className="btn btn-sm" disabled={busy === `test${r.key}`} onClick={() => test(r)} title="Sends a message marked TEST only to you">Send me a test</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {edit && <EditRow row={edit} roles={data.roles} onClose={() => setEdit(null)} onSaved={async (warn) => { setEdit(null); await after(warn && warn.length ? `Saved. ${warn.join(' ')}` : 'Saved.'); }} />}
    </div>
  );
}

function EditRow({ row, roles, onClose, onSaved }) {
  const [on, setOn] = useState(row.on);
  const [roleSel, setRoleSel] = useState(row.roles.map((r) => r.code));
  const [people, setPeople] = useState(row.people.map((p) => ({ id: p.id, name: p.name })));
  const [owner, setOwner] = useState(!!(row.owner && row.owner.on));
  const [ways, setWays] = useState(row.channels.filter((c) => c.on).map((c) => c.id));
  const [timing, setTiming] = useState(Object.fromEntries(row.timing.map((t) => [t.id, t.value])));
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.get('/accounts-reminders/people', { params: { q } }).then((r) => setFound(r.data.people || [])).catch(() => setFound([]));
    }, 200);
    return () => clearTimeout(timer.current);
  }, [q]);

  const toggle = (list, setList, v) => setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const hasPerson = (id) => people.some((p) => p.id === id);
  const togglePerson = (p) => setPeople(hasPerson(p.id) ? people.filter((x) => x.id !== p.id) : [...people, { id: p.id, name: p.name }]);

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      const body = {
        on, roles: roleSel, people: people.map((p) => p.id), owner, channels: ways, timing,
      };
      const { data } = await api.put(`/accounts-reminders/${row.key}`, body);
      await onSaved(data.warnings);
    } catch (e) { setErr(e.response?.data?.error || 'Could not save.'); }
    setSaving(false);
  };

  return (
    <Modal
      title={row.title}
      size="wide"
      onClose={onClose}
      footer={(
        <>
          {err && <span className="arr-err">{err}</span>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      <div className="small-muted">{row.description}</div>
      <label className="arr-line"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> This reminder is ON</label>

      <h4 className="arr-h">Which roles get it</h4>
      <div className="prr-who">
        {roles.map((r) => (
          <label key={r.code}><input type="checkbox" checked={roleSel.includes(r.code)} onChange={() => toggle(roleSel, setRoleSel, r.code)} /> {r.label}</label>
        ))}
      </div>

      <h4 className="arr-h">And these people</h4>
      <div>{people.length ? people.map((p) => <span key={p.id} className="arr-chip">{p.name} <button type="button" className="arr-x" onClick={() => togglePerson(p)} aria-label={`Remove ${p.name}`}>×</button></span>) : <span className="small-muted">No named person.</span>}</div>
      <input className="arr-search" type="search" placeholder="Type a name to find a person…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="arr-list">
        {found.map((p) => (
          <label key={p.id}>
            <input type="checkbox" checked={hasPerson(p.id)} onChange={() => togglePerson(p)} />
            {' '}{p.name} {p.role && <span className="small-muted">({p.role})</span>}
            {!p.hasAccounts && <span className="small-muted"> · no Accounts access: gets the message, cannot open Accounts</span>}
          </label>
        ))}
        {!found.length && <span className="small-muted">No one found.</span>}
      </div>

      {row.owner && (
        <label className="arr-line"><input type="checkbox" checked={owner} onChange={(e) => setOwner(e.target.checked)} /> {row.owner.label}</label>
      )}

      <h4 className="arr-h">How it is sent</h4>
      <div className="prr-who">
        {row.channels.map((c) => (
          <label key={c.id}>
            <input type="checkbox" checked={c.fixed ? true : ways.includes(c.id)} disabled={c.fixed} onChange={() => toggle(ways, setWays, c.id)} /> {c.label}{c.fixed ? ' (always)' : ''}
            {c.health && !c.health.ok && <span className="arr-warn"> {c.health.note}</span>}
          </label>
        ))}
      </div>

      {row.timing.length > 0 && (
        <>
          <h4 className="arr-h">When</h4>
          <div className="prr-row">
            {row.timing.map((t) => (
              <label key={t.id}>{t.label}
                {t.type === 'time'
                  ? <input type="time" value={timing[t.id] || ''} onChange={(e) => setTiming({ ...timing, [t.id]: e.target.value })} />
                  : <input type="number" min={t.min} max={t.max} step="1" value={timing[t.id] ?? ''} onChange={(e) => setTiming({ ...timing, [t.id]: e.target.value === '' ? '' : Number(e.target.value) })} />}
              </label>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
