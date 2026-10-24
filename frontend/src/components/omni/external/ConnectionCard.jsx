import { useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Btn, Pill, GsModal, Field, Banner, ConfirmModal, fmtDateTime } from '../ui.jsx';
import './external.css';

// ---------------------------------------------------------------------------
// ConnectionCard: the prototype's "Connection status" panel for a service that needs an account / keys, with the REAL states:
//   Not connected  ->  Saved, not verified  ->  Connected (only after a read-only check really passed)  /  Check failed: <plain reason>
// The Connect button opens a form with the fields the service really needs, plain numbered steps, and "Save and check". Keys are saved ENCRYPTED on the
// server, never shown again (a masked hint only). Only an Admin connects or disconnects: everybody else only looks.
//   conn        the connection object from useConnection(id)
//   canConnect  true for an Admin
//   onChanged   (newConnection) after save / check / disconnect
//   open, setOpen   the page may open the form from its own header button
//   info        [[label, value], ...] shown ONLY when connected (what the check really returned)
//   pill        optional { tone, words } to override the pill (Instagram: connected Page but no Instagram account)
// ---------------------------------------------------------------------------
const TONE = { connected: 'live', saved: 'warn', failed: 'red', not_connected: 'draft' };

export function ConnectModal({ conn, onClose, onDone }) {
  const { toast } = useOmni();
  const [vals, setVals] = useState(() => { const o = {}; conn.fields.forEach((f) => { o[f.id] = f.secret ? '' : (conn.values && conn.values[f.id]) || ''; }); return o; });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const d = await omni.put(`/gs/external/connection/${conn.id}`, { values: vals });
      const c = d.connection;
      onDone(c);
      toast(c.status === 'connected' ? `${conn.name}: connected and checked.` : c.status === 'failed' ? `Saved, but the check failed: ${c.reason}` : 'Saved. It is not verified yet.');
      onClose();
    } catch (e) { setErr(errOf(e, 'It could not be saved. Please try again.')); } finally { setBusy(false); }
  };
  return (
    <GsModal title={`Connect: ${conn.name}`} sub="Your keys are saved encrypted and are never shown again. TeamLink only reads. Nothing is posted, created or spent." width={560} onClose={onClose}
      foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy} onClick={save}>{busy ? 'Saving and checking…' : 'Save and check'}</Btn></>}>
      <div style={{ fontSize: 10, fontWeight: 850, textTransform: 'uppercase', letterSpacing: '.08em', color: '#7f8b84', marginBottom: 6 }}>How to get these</div>
      <ol className="ext-steps">{conn.steps.map((s) => <li key={s}>{s}</li>)}</ol>
      <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); save(); }} style={{ display: 'grid', gap: 12 }}>
        {conn.fields.map((f, i) => {
          const hint = f.secret && conn.secretHints && conn.secretHints[f.id] ? `Saved: ${conn.secretHints[f.id]}. Leave empty to keep it. ${f.hint || ''}` : (f.hint || '');
          return (
            <Field key={f.id} label={f.label.toUpperCase()} hint={hint}>
              {f.multiline
                ? <textarea rows={5} autoComplete="off" spellCheck={false} placeholder={f.placeholder || ''} value={vals[f.id]} onChange={(e) => setVals({ ...vals, [f.id]: e.target.value })} />
                : <input autoFocus={i === 0} autoComplete="off" spellCheck={false} type={f.secret ? 'password' : 'text'} placeholder={f.placeholder || ''} value={vals[f.id]} onChange={(e) => setVals({ ...vals, [f.id]: e.target.value })} />}
            </Field>
          );
        })}
        <button type="submit" style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
      </form>
      {err && <Banner tone="error">{err}</Banner>}
    </GsModal>
  );
}

export default function ConnectionCard({ conn, canConnect, onChanged, open, setOpen, title = 'Connection status', sub, lead, info, pill, connectLabel = 'Connect', children }) {
  const { toast } = useOmni();
  const [own, setOwn] = useState(false);
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState('');
  const isOpen = open !== undefined ? open : own;
  const setIsOpen = setOpen || setOwn;
  if (!conn) return <div className="card panel" style={{ marginBottom: 14 }}><div className="panel-sub">Loading…</div></div>;
  const status = conn.status;
  const saved = status !== 'not_connected';
  const run = async (kind) => {
    setBusy(kind); setErr('');
    try {
      const d = kind === 'check' ? await omni.post(`/gs/external/connection/${conn.id}/check`) : await omni.del(`/gs/external/connection/${conn.id}`);
      onChanged(d.connection);
      toast(kind === 'check' ? (d.connection.status === 'connected' ? 'Checked: connected.' : d.connection.status === 'failed' ? `Check failed: ${d.connection.reason}` : 'Checked. Still not verified.') : 'Disconnected. The saved keys were deleted.');
    } catch (e) { setErr(errOf(e, 'That did not work. Please try again.')); } finally { setBusy(''); setConfirm(false); }
  };
  const p = pill || { tone: TONE[status], words: conn.statusWords };
  return (
    <div className="card panel">
      <div className="panel-top">
        <div><div className="panel-title">{title}</div><div className="panel-sub">{sub || conn.name}</div></div>
        <Pill tone={p.tone} dot>{p.words}</Pill>
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7, marginTop: 10 }}>{lead || conn.why}</p>
      {status === 'connected' && info && info.length > 0 && (
        <div className="ext-info">{info.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => <div key={k}><b>{k}:</b> {v}</div>)}</div>
      )}
      {status === 'failed' && <Banner tone="error">Check failed: {conn.reason}</Banner>}
      {status === 'saved' && <Banner tone="warn">Saved, not verified. {conn.reason || 'Press "Check again" to test the keys.'}</Banner>}
      {saved && conn.checkedAt && status !== 'saved' && <div className="ext-note">Last checked {fmtDateTime(conn.checkedAt)}.</div>}
      {err && <Banner tone="error">{err}</Banner>}
      <div className="ext-row">
        {canConnect && !saved && <Btn primary onClick={() => setIsOpen(true)}>🔗 {connectLabel}</Btn>}
        {canConnect && saved && <Btn onClick={() => run('check')} disabled={!!busy}>{busy === 'check' ? 'Checking…' : '↻ Check again'}</Btn>}
        {canConnect && saved && <Btn onClick={() => setIsOpen(true)}>Change keys</Btn>}
        {canConnect && saved && <Btn danger onClick={() => setConfirm(true)} disabled={!!busy}>Disconnect</Btn>}
        {!canConnect && <span className="ext-note" style={{ margin: 0 }}>{saved ? 'Only an Admin can change or disconnect this.' : 'Only an Admin can connect this. You can look.'}</span>}
      </div>
      {children}
      {isOpen && canConnect && <ConnectModal conn={conn} onClose={() => setIsOpen(false)} onDone={onChanged} />}
      {confirm && <ConfirmModal title="Disconnect?" text={`This deletes the saved keys for ${conn.name}. Nothing else is touched. You can connect again any time.`} yes="Disconnect" danger onYes={() => run('disconnect')} onNo={() => setConfirm(false)} />}
    </div>
  );
}
