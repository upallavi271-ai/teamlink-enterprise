import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import omni, { errOf } from '../omniApi.js';
import { Panel, Btn, TinyBtn, Pill, Banner, ConfirmModal, fmtDateTime, fmtNum } from '../ui.jsx';
import MultiPick from '../../MultiPick.jsx';
import { useLoad, Err, Ok } from './adminUtil.jsx';
import { useOmni } from '../omniContext.js';

const TONE = { green: 'live', yellow: 'warn', red: 'red' };

// ---- Connection health: HRMS, ATS, Accounts, Job Portal, Email, WhatsApp, SMS (read only: counts rows and reads settings; never sends) ----
function Health({ toast }) {
  const navigate = useNavigate();
  const { data, err, loading, reload } = useLoad(() => omni.get('/gs/admin/settings/health'), []);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState('');
  const [sync, setSync] = useState(false);
  const [syncMsg, setSyncMsg] = useState(''); const [syncErr, setSyncErr] = useState('');
  useEffect(() => { if (data) setRows(data.rows); }, [data]);
  const test = async (r) => {
    setBusy(r.id);
    try { const x = await omni.post(`/gs/admin/settings/health/${r.id}/test`); setRows((rs) => rs.map((y) => (y.id === r.id ? x.row : y))); toast(`${r.name}: ${x.row.stateWord}. Nothing was sent.`); } catch (e) { toast(errOf(e, 'The check could not run.')); } finally { setBusy(''); }
  };
  const recheck = async () => { toast('Checking every connection…'); await reload(); toast('Health re-checked'); };
  const doSync = async () => {
    setSync(false); setSyncErr(''); setSyncMsg('');
    try { const r = await omni.post('/connections/sync/hrms'); setSyncMsg(`${r.added} staff added, ${r.existed} were already there. ${r.note}`); reload(); } catch (e) { setSyncErr(errOf(e, 'It could not be done.')); }
  };
  const attention = rows ? rows.filter((r) => r.state !== 'green').length : 0;
  return (
    <Panel title="Connection health" sub={rows ? (attention ? `${attention} ${attention === 1 ? 'connection needs' : 'connections need'} attention.` : 'Every connection is delivering.') : 'Loading…'}
      right={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Btn onClick={recheck} disabled={loading}>↻ Re-check all</Btn><Btn onClick={() => navigate('/admin/integrations')}>Open Administration &gt; Integrations</Btn></div>}>
      <Err text={err} /><Err text={syncErr} /><Ok text={syncMsg} />
      <div className="card table-card"><div className="table-scroll"><table className="table">
        <thead><tr><th>Account</th><th>Channel</th><th>Status</th><th>Detail</th><th /></tr></thead>
        <tbody>{(rows || []).map((r) => (
          <tr key={r.id}>
            <td><b>{r.name}</b></td><td>{r.channel}</td>
            <td><Pill tone={TONE[r.state]} dot>{r.stateWord}</Pill></td>
            <td style={{ maxWidth: 380 }}>{r.detail}{r.facts && r.facts.length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 10, color: 'var(--muted)' }}>{r.facts.map((f) => <li key={f}>{f}</li>)}</ul>}</td>
            <td><div className="row-acts adm-wide"><TinyBtn onClick={() => test(r)} disabled={busy === r.id}>{busy === r.id ? 'Checking…' : 'Test connection'}</TinyBtn>{r.canSync && <TinyBtn onClick={() => setSync(true)}>Add staff as contacts</TinyBtn>}{r.state === 'red' && <TinyBtn onClick={() => navigate('/admin/integrations')}>Connect</TinyBtn>}</div></td>
          </tr>
        ))}</tbody>
      </table></div></div>
      <div className="adm-note">"Test connection" only reads: it counts rows and reads settings, it never sends a message. Passwords and keys stay in Administration &gt; Integrations.</div>
      {sync && <ConfirmModal title="Add staff as internal contacts?" yes="Add staff" text="Every employee with a phone or email becomes an internal contact in Omni-Channel. No permission is recorded, so nothing can be sent to them until their consent is recorded. Test mode stays on." onYes={doSync} onNo={() => setSync(false)} />}
    </Panel>
  );
}

// ---- the Meta WhatsApp account (read only here), its webhook, and the template approvals ----
function MetaAccount() {
  const { data, err } = useLoad(() => omni.get('/config/meta'), []);
  const [chk, setChk] = useState(null); const [busy, setBusy] = useState(false);
  const check = async () => { setBusy(true); setChk(null); try { setChk(await omni.post('/config/meta/check')); } catch (e) { setChk({ ok: false, words: errOf(e, 'The check could not run.') }); } finally { setBusy(false); } };
  if (err) return <Err text={err} />;
  if (!data) return <div className="card panel">Loading…</div>;
  const a = data.account; const t = data.templates || [];
  const wh = a.webhook || {};
  return (
    <Panel title="WhatsApp Accounts" sub="Meta Cloud API sender: the one company number that carries your approved templates."
      right={<Btn onClick={check} disabled={busy || !a.connected}>{busy ? 'Reading…' : 'Check the number at Meta'}</Btn>}>
      <div className="set-row">
        <div className="set-row-ico" style={{ background: '#e8f7ef' }}>✆</div>
        <div className="set-row-main"><b>{a.number || 'No number yet'} {a.connected ? <Pill tone="live" dot>Connected</Pill> : <Pill tone="draft" dot>Not connected</Pill>}{a.testServer && <Pill tone="warn">Test server</Pill>}</b>
          <small style={{ whiteSpace: 'normal' }}>{a.connected ? `Phone ID ${a.phoneIdMasked || '—'} · Business ID ${a.businessIdMasked || '—'} · ${t.length} template${t.length === 1 ? '' : 's'}` : (a.why || 'Not connected')}</small></div>
      </div>
      {chk && <Banner tone={chk.ok ? 'ok' : 'warn'}>{chk.ok ? `${chk.name || 'Number'} ${chk.number}: quality ${chk.quality}, may message ${chk.limit}. ` : ''}{chk.words}</Banner>}
      <dl className="adm-kv" style={{ margin: '10px 0' }}>
        <dt>Webhook address</dt><dd className="mono-cell" style={{ fontSize: 11 }}>{wh.hasPublicAddress ? wh.url : `${window.location.origin}/api/webhooks/whatsapp`}{!wh.hasPublicAddress && <div className="adm-note">The public site address (APP_BASE_URL) is not set on the server, so Meta cannot reach this address yet.</div>}</dd>
        <dt>Last call from Meta</dt><dd>{wh.lastCall ? `${fmtDateTime(wh.lastCall)} (${fmtNum(wh.calls)} calls)` : 'None seen yet'} <Pill tone={TONE[wh.state] || 'draft'} dot>{wh.state === 'green' ? 'Delivering' : (wh.state === 'yellow' ? 'Waiting for Meta' : 'Not connected')}</Pill></dd>
        <dt>Secrets saved</dt><dd>App secret: {a.secretSaved ? 'yes' : 'no'} · Verify token: {a.verifyTokenSaved ? 'yes' : 'no'} (values are never shown)</dd>
        <dt>Set up in</dt><dd>{a.where}</dd>
      </dl>
      <div className="panel-title" style={{ marginTop: 14 }}>Template approvals</div>
      {t.length ? (
        <div className="card table-card"><div className="table-scroll"><table className="table"><thead><tr><th>Template</th><th>Kind</th><th>Department</th><th>Meta status</th></tr></thead>
          <tbody>{t.slice(0, 30).map((x) => <tr key={x.key}><td><b>{x.name}</b>{x.waName && x.waName !== x.name ? <div style={{ fontSize: 9, color: 'var(--muted)' }}>{x.waName}</div> : null}</td><td>{x.kind}</td><td>{x.department}</td><td>{x.status}</td></tr>)}</tbody></table></div></div>
      ) : <div className="adm-note">No WhatsApp template written yet. Write them in Manage Templates.</div>}
      {t.length > 30 && <div className="adm-note">Showing 30 of {t.length}. All of them are in Manage Templates.</div>}
    </Panel>
  );
}

// ---- WhatsApp numbers per department (config + routing only) ----
function WaNumbers({ toast }) {
  const { data, err, reload } = useLoad(() => omni.get('/gs/admin/settings/wa-numbers'), []);
  const [rows, setRows] = useState(null);
  const [problem, setProblem] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setRows(data.numbers.map((n) => ({ id: n.id, label: n.label, number: n.number, departments: n.departments }))); }, [data]);
  const save = async () => {
    setBusy(true); setProblem('');
    try { await omni.put('/gs/admin/settings/wa-numbers', { numbers: rows }); toast('WhatsApp numbers saved'); reload(); } catch (e) { setProblem(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  if (err) return <Err text={err} />;
  if (!rows) return <div className="card panel">Loading…</div>;
  const opts = data.departments.map((d) => ({ value: d, label: d }));
  const upd = (i, p) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <Panel title="WhatsApp numbers per department" sub="Which number each department uses." right={<Btn primary onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Btn>}>
      <Banner tone="info">{data.words} Connected number now: {data.connectedNumber || 'none'}.</Banner>
      <Err text={problem} />
      {rows.length === 0 && <div className="set-empty"><b>No department has its own number yet</b>Every department uses the one company number until you add one here.</div>}
      {rows.map((r, i) => (
        <div className="set-row" key={r.id || i} style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 160px' }}><label>NAME</label><input value={r.label} maxLength={60} placeholder="Medical team" onChange={(e) => upd(i, { label: e.target.value })} /></div>
          <div className="field" style={{ flex: '1 1 160px' }}><label>NUMBER (WITH COUNTRY CODE)</label><input inputMode="numeric" value={r.number} placeholder="919876543210" onChange={(e) => upd(i, { number: e.target.value.replace(/\D/g, '') })} /></div>
          <div className="field" style={{ flex: '2 1 240px' }}><label>DEPARTMENTS</label><MultiPick options={opts} value={r.departments} onChange={(v) => upd(i, { departments: v })} placeholder="Pick departments" /></div>
          <TinyBtn onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</TinyBtn>
        </div>
      ))}
      <Btn onClick={() => setRows([...rows, { id: '', label: '', number: '', departments: [] }])}>＋ Add a number</Btn>
    </Panel>
  );
}

// ---- the connections that belong to other pages ----
function Others() {
  const { acc, go } = useOmni();
  const navigate = useNavigate();
  const has = (p) => acc && Array.isArray(acc.pages) && acc.pages.includes(p);
  return (
    <Panel title="Other connections" sub="Where each kind of account is connected.">
      <div className="set-row"><div className="set-row-main"><b>Email, SMS and WhatsApp accounts</b><small style={{ whiteSpace: 'normal' }}>Passwords, keys and tokens are saved (encrypted) in Administration &gt; Integrations. Nothing is asked twice.</small></div><Btn onClick={() => navigate('/admin/integrations')}>Open Integrations</Btn></div>
      {[['social', 'Social media accounts', 'Facebook, Instagram, LinkedIn, X, YouTube: connected on the Social Media page.'], ['shopify', 'Shopify', 'Connected on the Shopify page.'], ['googleads', 'Google Ads and Google Analytics', 'Connected on their own pages.'], ['adsmanager', 'Meta Ads', 'Connected on the Ads Manager page.']].map(([p, t, s]) => (
        <div className="set-row" key={p}><div className="set-row-main"><b>{t}</b><small style={{ whiteSpace: 'normal' }}>{s}</small></div>{has(p) ? <Btn onClick={() => go(p)}>Open</Btn> : <span className="adm-note">Not for your login</span>}</div>
      ))}
      <div className="adm-note">Nothing is shown as connected unless it really is.</div>
    </Panel>
  );
}

export default function SetIntegrations({ toast }) {
  return (<><Health toast={toast} /><MetaAccount /><WaNumbers toast={toast} /><Others /></>);
}
