import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import { clearMyWaNumbers } from '../messaging/WaSender.jsx';
import { chipTone, chipWords, fmtNumber } from '../messaging/waSender.js';
import { useActiveDepartments, keepActive } from '../../utils/activeDepartments.js';
import './comm.css';

// ---------------------------------------------------------------------------
// ADMINISTRATION > INTEGRATIONS > WhatsApp & SMS > WhatsApp numbers
//   every WhatsApp business number of the company in one list: connection status (asked from Meta), who may send from it, the default one.
//   Add WhatsApp Number - Edit - Assign - Reconnect - Deactivate / Activate - Make default - Remove: each one is its own button.
// The old single connection shows as "Main number (default)" until "Move it into the list" is pressed (nothing breaks either way).
// Tokens and secrets are write-only here: the server never sends them back, the screen only says "Saved".
// Server: /api/wa-numbers (Admin / Super Admin only).
// ---------------------------------------------------------------------------

const ago = (iso) => {
  if (!iso) return 'not checked yet';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;

// Template language choices. '' = English as en AND en_US: whichever Meta approved is sent.
const LANG_CHOICES = [
  { value: '', label: 'English: en and en_US (both)' },
  { value: 'en', label: 'English (en) first' },
  { value: 'en_US', label: 'English US (en_US) first' },
  { value: 'te', label: 'Telugu (te)' },
  { value: 'hi', label: 'Hindi (hi)' },
];
const BLANK = {
  label: '', displayNumber: '', phoneNumberId: '', wabaId: '', portfolio: '', tokenMode: 'own', token: '', appSecret: '', verifyToken: '', language: '', tplLink: '', tplOtp: '', tplBulk: '', makeDefault: false, departments: [],
};

// ---- Business portfolio (founder 2026-11-14) --------------------------------------------------------------------------------
// A plain label: which Meta business portfolio owns this number's WhatsApp Business Account (and so pays for its messages).
// It changes nothing in Meta and nothing in how messages are sent; it only lets the Admin see, at a glance, what bills where.
const NO_PORTFOLIO = '__none__';
// Numbers under their portfolio. Until at least one number has a portfolio there is one group and no header: the list looks as it always did.
export function groupByPortfolio(rows) {
  const any = rows.some((n) => n.portfolio);
  if (!any) return [{ key: 'all', name: '', items: rows, header: false }];
  const by = new Map();
  rows.forEach((n) => { const k = n.portfolio || ''; if (!by.has(k)) by.set(k, []); by.get(k).push(n); });
  const named = [...by.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b)).map((k) => ({ key: `p:${k}`, name: k, items: by.get(k), header: true }));
  return by.has('') ? [...named, { key: 'none', name: '', items: by.get(''), header: true }] : named;
}
// One WhatsApp Business Account belongs to one portfolio. Two numbers of the same account under different portfolios = one label is wrong.
export function portfolioClashes(numbers) {
  const byWaba = new Map();
  numbers.forEach((n) => { if (n.wabaId && n.portfolio && !n.virtual) { if (!byWaba.has(n.wabaId)) byWaba.set(n.wabaId, []); byWaba.get(n.wabaId).push(n); } });
  const out = [];
  byWaba.forEach((list, wabaId) => {
    const names = [...new Set(list.map((n) => n.portfolio))];
    if (names.length > 1) out.push({ wabaId, portfolios: names, numbers: list.map((n) => n.label) });
  });
  return out;
}
const groupSummary = (items) => {
  const on = items.filter((n) => n.status && n.status.code === 'connected').length;
  return `${items.length} number${items.length === 1 ? '' : 's'} · ${on} connected`;
};
function PortfolioCell({ n, onSet }) {
  if (n.virtual) return <span className="cm-sub">—</span>;
  return (
    <div className="wn-port">
      {n.portfolio ? <span className="wn-chip wn-chip-port">{n.portfolio}</span> : <span className="cm-sub">Not set</span>}
      {n.wabaId ? <div className="cm-sub" title="Messages are billed to the WhatsApp Business Account that owns the number">Account {n.wabaId}</div> : <div className="cm-sub">No account ID saved</div>}
      <button type="button" className="link-btn" onClick={() => onSet(n)}>{n.portfolio ? 'Change' : 'Set'}</button>
    </div>
  );
}
function GroupHead({ g }) {
  return (
    <>
      <b>{g.name || 'No portfolio set'}</b> <span className="cm-sub">· {groupSummary(g.items)}</span>
      {!g.name && <span className="cm-sub"> · press Set to say which portfolio pays for each of these</span>}
    </>
  );
}

export function StatusBadge({ status }) {
  if (!status) return null;
  return <StatusChip tone={chipTone(status.code)}>{status.label || chipWords(status.code)}</StatusChip>;
}

// a small card for the "Set up" page: how many numbers, how many connected, and a button to the list
export function NumbersGlance({ onOpen }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/wa-numbers').then((r) => setD(r.data)).catch(() => setD(null)); }, []);
  if (!d) return null;
  const total = d.numbers.length;
  return (
    <div className="cm-card" data-wa-glance>
      <div className="cm-cardhead">
        <h3>WhatsApp numbers</h3>
        <button type="button" className="btn btn-primary" onClick={onOpen}>Manage WhatsApp numbers</button>
      </div>
      <div className="cm-sub">
        {d.listed
          ? `${total} number${total === 1 ? '' : 's'} added · ${d.counts.connected || 0} connected${d.counts.verification_required ? ` · ${d.counts.verification_required} need verification` : ''}${d.counts.disconnected ? ` · ${d.counts.disconnected} not connected` : ''}.`
          : 'One number is connected today (the Main number) and everybody uses it. Add more numbers and choose who may send from which one.'}
      </div>
    </div>
  );
}

export default function WaNumbers() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState(null); // { ok, text }
  const [busy, setBusy] = useState('');
  const [modal, setModal] = useState(null); // { type, n }
  const [q, setQ] = useState('');
  const [fDept, setFDept] = useState('');
  const [fUser, setFUser] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fPortfolio, setFPortfolio] = useState('');

  const load = useCallback(async () => {
    try { const r = await api.get('/wa-numbers'); setData(r.data); setErr(''); clearMyWaNumbers(); } catch (e) { setErr(errOf(e, 'The numbers could not be loaded.')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(key, fn, okText) {
    setBusy(key); setNote(null);
    try { const r = await fn(); await load(); setNote({ ok: true, text: typeof okText === 'function' ? okText(r) : okText }); return r; } catch (e) {
      setNote({ ok: false, text: errOf(e, 'That did not work.') }); return null;
    } finally { setBusy(''); }
  }

  const people = useMemo(() => {
    const m = new Map();
    ((data && data.numbers) || []).forEach((n) => (n.users || []).forEach((u) => m.set(u.id, u.name)));
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    return data.numbers.filter((n) => {
      if (fDept && !(n.departments || []).includes(fDept) && !n.everyone) return false;
      if (fUser && !(n.users || []).some((u) => u.id === fUser)) return false;
      if (fStatus && n.status.code !== fStatus) return false;
      if (fPortfolio === NO_PORTFOLIO ? !!n.portfolio : (fPortfolio && n.portfolio !== fPortfolio)) return false;
      if (s) {
        const hay = `${n.label} ${n.displayNumber} ${n.portfolio || ''} ${(n.departments || []).join(' ')} ${(n.users || []).map((u) => u.name).join(' ')} ${n.status.label}`.toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [data, q, fDept, fUser, fStatus, fPortfolio]);

  // numbers shown under their Business portfolio (only once at least one number has a portfolio; before that the list looks exactly as it did)
  const groups = useMemo(() => groupByPortfolio(rows), [rows]);
  // one WhatsApp Business Account belongs to ONE portfolio: two numbers of the same account with different portfolios is a slip
  const clashes = useMemo(() => portfolioClashes((data && data.numbers) || []), [data]);

  if (!data) return <div className="cm-help">{err || 'Loading…'}</div>;
  const c = data.counts || {};
  const unusedStatus = ['connected', 'verification_required', 'disconnected', 'switched_off', 'test_mode', 'unchecked'];

  return (
    <div className="wn-page" data-wa-numbers>
      <p className="cm-help">All the WhatsApp numbers of the company. You choose which department or person may send from which number. A person with no number cannot send WhatsApp from TeamLink until you give one.</p>
      {note && <div className={`cm-line ${note.ok ? 'cm-green' : 'cm-red'}`} role="status">{note.text}</div>}
      {err && <div className="cm-line cm-red">{err}</div>}

      <div className="cm-grid wn-stats">
        <div className="cm-stat"><b>{c.connected || 0}</b><span>Connected</span></div>
        <div className="cm-stat"><b>{c.verification_required || 0}</b><span>Verification required</span></div>
        <div className="cm-stat"><b>{c.disconnected || 0}</b><span>Disconnected</span></div>
        <div className="cm-stat" title="Messages that came for a Phone number ID nobody added here. They are kept, never given to another number."><b>{data.unknownMessages || 0}</b><span>Messages for an unknown number</span></div>
      </div>

      {!data.listed && (
        <div className="cm-line cm-blue">
          <b>One number is connected today: the Main number.</b> Everybody uses it, exactly as before. To choose who may use it, or to add more numbers, press <b>Move it into the list</b> (nothing changes for anybody when you do), or just add a new number.
        </div>
      )}

      {clashes.map((c) => (
        <div className="cm-line cm-orange" key={c.wabaId} role="alert" data-portfolio-clash>
          <b>{c.numbers.join(' and ')}</b> use the same WhatsApp Business Account (ID {c.wabaId}) but are under different portfolios ({c.portfolios.join(' / ')}). One account belongs to one portfolio, so one of these labels is wrong.
        </div>
      ))}
      {data.listed && data.numbers.length > 1 && !data.numbers.some((n) => n.portfolio) && (
        <div className="cm-line cm-blue" data-portfolio-tip>
          <b>Tip: set the Business portfolio of each number.</b> Messages are billed to the portfolio that owns the number&apos;s WhatsApp Business Account. Press <b>Set</b> in the Business portfolio column and the list is grouped by portfolio, so you can see which payment method each number uses. It is only a label here; it changes nothing in Meta.
        </div>
      )}

      <div className="wn-toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setModal({ type: 'edit', n: null })}>Add WhatsApp Number</button>
        <input className="wn-search" type="search" placeholder="Search a number, name, portfolio, department or person" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search WhatsApp numbers" />
        {(data.portfolios || []).length > 0 && (
          <Combo value={fPortfolio} onChange={(e) => setFPortfolio(e.target.value)} aria-label="Business portfolio" className="wn-filter">
            <option value="">All portfolios</option>
            {data.portfolios.map((p) => <option key={p} value={p}>{p}</option>)}
            <option value={NO_PORTFOLIO}>No portfolio set</option>
          </Combo>
        )}
        <Combo value={fDept} onChange={(e) => setFDept(e.target.value)} aria-label="Department" className="wn-filter">
          <option value="">All departments</option>
          {data.departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
        <Combo value={fUser} onChange={(e) => setFUser(e.target.value)} aria-label="Person" className="wn-filter">
          <option value="">All people</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Combo>
        <Combo value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="Connection status" className="wn-filter">
          <option value="">Any status</option>
          {unusedStatus.map((k) => <option key={k} value={k}>{chipWords(k)}</option>)}
        </Combo>
        <button type="button" className="btn" onClick={() => setModal({ type: 'settings' })}>Company settings</button>
      </div>

      {rows.length === 0 && <div className="cm-card"><div className="cm-sub">{data.numbers.length ? 'No number matches this search or filter.' : 'No WhatsApp number is added yet.'}</div></div>}

      {rows.length > 0 && (
        <>
          <div className="wn-tablewrap">
            <table className="cm-table wn-table">
              <thead><tr><th>Number</th><th>Display name</th><th>Business portfolio</th><th>Department</th><th>Assigned users</th><th>Connection status</th><th>Actions</th></tr></thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.key}>
                    {g.header && <tr className="wn-grouprow" data-portfolio-group={g.name || 'none'}><td colSpan={7}><GroupHead g={g} /></td></tr>}
                    {g.items.map((n) => (
                      <tr key={n.id} data-number-row={n.label}>
                        <td className="wn-num"><b>{fmtNumber(n.displayNumber) || '—'}</b>{n.isDefault && <span className="wn-star" title="Default number">★ Default</span>}</td>
                        <td className="wn-name">{n.label}{n.isMain && <span className="wn-tag">Main number</span>}</td>
                        <td><PortfolioCell n={n} onSet={(x) => setModal({ type: 'portfolio', n: x })} /></td>
                        <td><Chips n={n} part="departments" /></td>
                        <td><Chips n={n} part="people" /></td>
                        <td><StatusCell n={n} /></td>
                        <td className="wn-actions"><Actions n={n} busy={busy} setModal={setModal} act={act} data={data} /></td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="wn-cards">
            {groups.map((g) => (
              <Fragment key={g.key}>
                {g.header && <div className="wn-grouphead"><GroupHead g={g} /></div>}
                {g.items.map((n) => (
                  <div className="cm-card wn-card" key={n.id}>
                    <div className="wn-card-head"><b className="wn-name">{n.label}</b>{n.isMain && <span className="wn-tag">Main number</span>}{n.isDefault && <span className="wn-star">★ Default</span>}</div>
                    <div className="wn-num"><b>{fmtNumber(n.displayNumber) || '—'}</b></div>
                    <StatusCell n={n} />
                    <div className="wn-lab">Business portfolio</div><PortfolioCell n={n} onSet={(x) => setModal({ type: 'portfolio', n: x })} />
                    <div className="wn-lab">Department</div><Chips n={n} part="departments" />
                    <div className="wn-lab">Assigned users</div><Chips n={n} part="people" />
                    <div className="wn-actions"><Actions n={n} busy={busy} setModal={setModal} act={act} data={data} /></div>
                  </div>
                ))}
              </Fragment>
            ))}
          </div>
        </>
      )}

      <details className="cm-card wn-help">
        <summary><b>What to do in Meta for a new number</b> (read once)</summary>
        <ol className="cm-steps">
          <li>In Meta Business Suite open <b>WhatsApp Manager &gt; Phone numbers</b> and add the number to your WhatsApp Business Account. If the number belongs to another business or account, you need that account&apos;s own ID and token.</li>
          <li>Meta sends a code to the number. Enter it there to <b>verify</b> the number.</li>
          <li>On developers.facebook.com open your app &gt; <b>WhatsApp &gt; API Setup</b>. Copy the <b>Phone number ID</b> of the new number and the <b>WhatsApp Business Account ID</b>.</li>
          <li>Make a permanent token: <b>Business settings &gt; System users</b>, give it your app and the WhatsApp account, permissions <b>whatsapp_business_messaging</b> and <b>whatsapp_business_management</b>, then Generate token. One token works for every number of that account (choose &quot;the shared token&quot; here), or paste a token for just this number.</li>
          <li>In your app open <b>WhatsApp &gt; Configuration</b>. The webhook address is the same for every number: <code>{data.webhookUrl || '(your TeamLink address)/api/webhooks/whatsapp'}</code> with your verify token. Subscribe to <b>messages</b>.</li>
          <li>Press <b>Add WhatsApp Number</b> here, fill the boxes and press <b>Save and check connection</b>. Later, <b>Reconnect</b> asks Meta again and also makes sure the webhook is subscribed.</li>
        </ol>
        <div className="cm-sub">Every number uses the same templates, whichever department it belongs to. Templates belong to the WhatsApp Business Account, not to one number, so numbers of one account share them at once. For a number of another account, an Admin presses <b>Send to every number&apos;s WhatsApp account</b> on the template (Omni-Channel &gt; Templates); Meta then approves it for that account too.</div>
      </details>

      {modal && modal.type === 'edit' && <EditModal data={data} n={modal.n} onClose={() => setModal(null)} onSaved={async (text, ok) => { await load(); setNote({ ok, text }); }} />}
      {modal && modal.type === 'portfolio' && <PortfolioModal data={data} n={modal.n} onClose={() => setModal(null)} onSaved={async (text) => { setModal(null); await load(); setNote({ ok: true, text }); }} />}
      {modal && modal.type === 'assign' && <AssignModal data={data} n={modal.n} onClose={() => setModal(null)} onSaved={async (text) => { setModal(null); await load(); setNote({ ok: true, text }); }} />}
      {modal && modal.type === 'remove' && <RemoveModal n={modal.n} onClose={() => setModal(null)} onDone={async (text) => { setModal(null); await load(); setNote({ ok: true, text }); }} />}
      {modal && modal.type === 'settings' && <SettingsModal data={data} onClose={() => setModal(null)} onSaved={async (text) => { setModal(null); await load(); setNote({ ok: true, text }); }} />}
    </div>
  );
}

// ---- cells ------------------------------------------------------------------------------------------------------------
function Chips({ n, part }) {
  if (part === 'departments') {
    const list = n.departments || [];
    if (!list.length) return <span className="cm-sub">{n.everyone ? 'All departments' : '—'}</span>;
    return <span className="wn-chips">{list.map((d) => <span className="wn-chip" key={d}>{d}</span>)}</span>;
  }
  const users = n.users || [];
  const roles = n.roles || [];
  if (n.notAssigned) return <span className="wn-chip wn-chip-warn">Not assigned to anyone</span>;
  const shown = users.slice(0, 3);
  return (
    <span className="wn-chips">
      {n.everyone && <span className="wn-chip">Everyone (as before)</span>}
      {roles.map((r) => <span className="wn-chip" key={r.code}>{r.label}</span>)}
      {shown.map((u) => <span className={`wn-chip${u.inactive ? ' wn-chip-warn' : ''}`} key={u.id} title={u.inactive ? 'No longer active' : ''}>{u.name}</span>)}
      {users.length > shown.length && <span className="wn-chip wn-chip-more" title={users.slice(3).map((u) => u.name).join(', ')}>+{users.length - shown.length}</span>}
      {!n.everyone && !roles.length && !users.length && <span className="cm-sub">Departments only</span>}
    </span>
  );
}
function StatusCell({ n }) {
  const s = n.status || {};
  return (
    <div className="wn-status">
      <StatusBadge status={s} />
      {s.text && <div className="cm-sub wn-why">{s.text}</div>}
      {s.webhookNote && <div className="cm-sub wn-why">{s.webhookNote}</div>}
      {n.tokenSource && <div className="cm-sub">{`Token: ${n.tokenSource}${n.tokenSavedAt ? `, saved ${ago(n.tokenSavedAt)}` : ''}${n.tokenTag ? `, ID ${n.tokenTag}` : ''}`}</div>}
      <div className="cm-sub">{n.virtual ? '' : (s.checkedAt ? `Checked ${ago(s.checkedAt)}` : 'Not checked yet')}</div>
    </div>
  );
}
function Actions({ n, busy, setModal, act, data }) {
  if (n.virtual) {
    return (
      <>
        <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act(`move-${n.id}`, () => api.post('/wa-numbers/move-main'), 'The Main number is now in the list. Everybody who could send before can still send. Press Assign to choose who may use it.')}>Move it into the list</button>
        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act(`test-${n.id}`, () => api.post('/wa-numbers/legacy/test'), (r) => r.data.text)}>Test connection</button>
      </>
    );
  }
  const on = n.active;
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setModal({ type: 'edit', n })}>Edit</button>
      <button type="button" className="btn btn-sm" onClick={() => setModal({ type: 'assign', n })}>Assign</button>
      <button type="button" className="btn btn-sm" disabled={!!busy || !on} title={on ? 'Ask Meta again and check the webhook' : 'Switch it on first'} onClick={() => act(`re-${n.id}`, () => api.post(`/wa-numbers/${n.id}/reconnect`), (r) => `${n.label}: ${r.data.text}${r.data.webhookNote ? ` ${r.data.webhookNote}` : ''}`)}>{busy === `re-${n.id}` ? 'Checking…' : 'Reconnect'}</button>
      {on
        ? <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act(`off-${n.id}`, () => api.post(`/wa-numbers/${n.id}/active`, { active: false }), `${n.label} is switched off. Nothing is sent from it. Its history stays.`)}>Deactivate</button>
        : <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act(`on-${n.id}`, () => api.post(`/wa-numbers/${n.id}/active`, { active: true }), `${n.label} is switched on again.`)}>Activate</button>}
      {!n.isDefault && on && <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => act(`def-${n.id}`, () => api.post(`/wa-numbers/${n.id}/default`), `${n.label} is now the default number.`)}>Make default</button>}
      {!n.isMain && !n.isDefault && <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => setModal({ type: 'remove', n })}>Remove</button>}
    </>
  );
}

// ---- Add / Edit ------------------------------------------------------------------------------------------------------------
function EditModal({ data, n, onClose, onSaved }) {
  const liveDepts = useActiveDepartments(); // only switched-on Department & Team names (+ ones already ticked)
  const editing = !!n;
  const main = !!(n && n.isMain);
  const [f, setF] = useState(() => (n ? { ...BLANK, label: n.label, displayNumber: n.displayNumber, phoneNumberId: n.phoneNumberId, wabaId: n.wabaId, portfolio: n.portfolio || '', tokenMode: n.tokenMode || 'own', language: n.language, tplLink: n.tplLink, tplOtp: n.tplOtp, tplBulk: n.tplBulk, departments: n.departments || [] } : { ...BLANK }));
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggleDept = (d) => set('departments', f.departments.includes(d) ? f.departments.filter((x) => x !== d) : [...f.departments, d]);

  async function save() {
    setBusy(true); setErr(''); setResult(null);
    try {
      const body = { ...f };
      delete body.departments;
      // the Main number's connection details live in the WhatsApp Business form: send only what this window may change (the server refuses the rest)
      if (main) ['displayNumber', 'phoneNumberId', 'wabaId', 'tokenMode', 'token', 'appSecret', 'verifyToken'].forEach((k) => { delete body[k]; });
      if (!f.token) delete body.token;
      if (!f.appSecret) delete body.appSecret;
      if (!f.verifyToken) delete body.verifyToken;
      let id; let status;
      if (editing) {
        const r = await api.put(`/wa-numbers/${n.id}`, body); id = r.data.id; status = r.data.status;
        const changed = JSON.stringify([...f.departments].sort()) !== JSON.stringify([...(n.departments || [])].sort());
        if (changed) await api.put(`/wa-numbers/${n.id}/access`, { departments: f.departments, userIds: (n.users || []).map((u) => u.id), roles: (n.roles || []).map((r2) => r2.code), everyone: !!n.everyone });
      } else {
        const r = await api.post('/wa-numbers', { ...body, access: f.departments.length ? { departments: f.departments } : undefined }); id = r.data.id; status = r.data.status;
      }
      void id;
      const text = status ? `${editing ? 'Saved' : 'Added'}. ${status.text}` : `${editing ? 'Saved' : 'Added'}.`;
      const good = !status || status.code === 'connected' || status.code === 'test_mode';
      setResult({ ok: good, text, code: status && status.code });
      await onSaved(text, good); // the list is refreshed; this window stays so the answer of the check can be read
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  }

  return (
    <Modal
      title={editing ? `Edit ${n.label}` : 'Add WhatsApp Number'}
      onClose={onClose}
      foot={result ? <button type="button" className="btn btn-primary" onClick={onClose}>Done</button> : <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving and checking…' : 'Save and check connection'}</button>
      </>}
    >
      {err && <div className="cm-line cm-red" role="alert">{err}</div>}
      {result && <div className={`cm-line ${result.ok ? 'cm-green' : 'cm-orange'}`}>{result.text}</div>}
      <div className="cm-form wn-form">
        <div><label htmlFor="wn-label">Display name</label><input id="wn-label" value={f.label} maxLength={60} placeholder="For example: Education desk" onChange={(e) => set('label', e.target.value)} /></div>
        <div>
          <label htmlFor="wn-port">Business portfolio <span className="cm-sub">optional</span></label>
          <input id="wn-port" list="wn-portfolios" value={f.portfolio} maxLength={60} placeholder="For example: TeamLink Medical Consultancy" onChange={(e) => set('portfolio', e.target.value)} />
          <datalist id="wn-portfolios">{(data.portfolios || []).map((p) => <option key={p} value={p} />)}</datalist>
          <div className="cm-sub">The Meta business portfolio that owns this number&apos;s WhatsApp Business Account and pays for its messages. Only a label here: it changes nothing in Meta.</div>
        </div>
        {!main && <div><label htmlFor="wn-num">WhatsApp number</label><input id="wn-num" value={f.displayNumber} inputMode="tel" placeholder="+91 98xxxxxxx" onChange={(e) => set('displayNumber', e.target.value)} /></div>}
        {!main && <div><label htmlFor="wn-pid">Phone number ID</label><input id="wn-pid" value={f.phoneNumberId} inputMode="numeric" placeholder="from Meta > WhatsApp > API Setup" onChange={(e) => set('phoneNumberId', e.target.value)} /></div>}
        {!main && <div><label htmlFor="wn-waba">WhatsApp Business Account ID</label><input id="wn-waba" value={f.wabaId} inputMode="numeric" placeholder="from Meta > WhatsApp > API Setup" onChange={(e) => set('wabaId', e.target.value)} /></div>}
        {!main && (
          <div>
            <label htmlFor="wn-tokmode">Which access token?</label>
            <Combo id="wn-tokmode" value={f.tokenMode} onChange={(e) => set('tokenMode', e.target.value)}>
              <option value="own">This number&apos;s own token</option>
              <option value="shared">The shared token (from the WhatsApp Business form)</option>
            </Combo>
          </div>
        )}
        {!main && f.tokenMode === 'own' && (
          <div>
            <label htmlFor="wn-token">Access token <span className="cm-sub">stored encrypted, never shown again</span></label>
            <input id="wn-token" type="password" autoComplete="new-password" value={f.token} placeholder={editing && n.tokenSaved ? 'Saved. Leave empty to keep it.' : 'Paste the permanent token'} onChange={(e) => set('token', e.target.value)} />
          </div>
        )}
        {!main && f.tokenMode === 'shared' && <div className="cm-sub wn-inline">{data.sharedTokenSaved ? 'The token saved in the WhatsApp Business form will be used for this number.' : 'No shared token is saved yet. Save one in Connections > WhatsApp Business first, or use this number\'s own token.'}</div>}
        {main && <div className="cm-sub wn-inline">The Main number&apos;s Phone number ID and token are kept in the WhatsApp Business form (Connections tab). Change them there.</div>}
      </div>

      <h4 className="wn-h4">Which departments use it?</h4>
      <div className="dept-checklist wn-depts" role="group" aria-label="Departments">
        {keepActive(liveDepts, data.departments, (d) => d, f.departments).map((d) => (
          <label key={d}><input type="checkbox" checked={f.departments.includes(d)} onChange={() => toggleDept(d)} /> {d}</label>
        ))}
      </div>
      <div className="cm-sub">You can also choose single people and roles with the <b>Assign</b> button.</div>

      {!editing && (
        <label className="wn-tick"><input type="checkbox" checked={f.makeDefault} onChange={(e) => set('makeDefault', e.target.checked)} /> Make this the default number</label>
      )}
      <button type="button" className="link-btn wn-adv" onClick={() => setAdv(!adv)}>{adv ? 'Hide' : 'Show'} advanced settings</button>
      {adv && (
        <div className="cm-form wn-form">
          {!main && <div><label htmlFor="wn-sec">App secret <span className="cm-sub">only if this number is in another Meta app</span></label><input id="wn-sec" type="password" autoComplete="new-password" value={f.appSecret} placeholder={editing && n.appSecretOwn ? 'Saved. Leave empty to keep it.' : 'Empty = the shared one'} onChange={(e) => set('appSecret', e.target.value)} /></div>}
          {!main && <div><label htmlFor="wn-ver">Webhook verify token <span className="cm-sub">only if this number is in another Meta app</span></label><input id="wn-ver" type="password" autoComplete="new-password" value={f.verifyToken} placeholder={editing && n.verifyTokenOwn ? 'Saved. Leave empty to keep it.' : 'Empty = the shared one'} onChange={(e) => set('verifyToken', e.target.value)} /></div>}
          <div className="cm-sub" style={{ gridColumn: '1 / -1' }}><b>Leave these empty.</b> Every number then uses the same templates as every other number (the ones set in Administration &gt; Integrations &gt; WhatsApp Business, and the templates in Manage Templates). Fill a box only if this one number must use a different template name.</div>
          {/* founder 2026-11-09: "language kuda marali, rendu EN, EN_US templates thisukovali". Empty = both: a template approved as en or as
              en_US is sent in the language Meta approved it in (backend outreach/tplWaba.js metaLanguage), so both kinds work on this number. */}
          <div>
            <label htmlFor="wn-lang">Template language</label>
            <select id="wn-lang" value={LANG_CHOICES.some((c) => c.value === (f.language || '')) ? (f.language || '') : 'other'}
              onChange={(e) => set('language', e.target.value === 'other' ? (f.language && !LANG_CHOICES.some((c) => c.value === f.language) ? f.language : ' ') : e.target.value)}>
              {LANG_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              <option value="other">Another language code…</option>
            </select>
            {!LANG_CHOICES.some((c) => c.value === (f.language || '')) && (
              <input aria-label="Language code" value={f.language.trim()} placeholder="For example: ta, kn, mr" onChange={(e) => set('language', e.target.value)} style={{ marginTop: 6 }} />
            )}
            <div className="cm-sub">{!f.language ? 'Templates approved as en and as en_US both work on this number.' : 'Templates in this language are sent first; the same language with another region (en / en_US) still works.'}</div>
          </div>
          <div><label htmlFor="wn-tl">Different template for the agreement link <span className="cm-sub">optional</span></label><input id="wn-tl" value={f.tplLink} placeholder="Empty = same template as every number" onChange={(e) => set('tplLink', e.target.value)} /></div>
          <div><label htmlFor="wn-to">Different template for the OTP <span className="cm-sub">optional</span></label><input id="wn-to" value={f.tplOtp} placeholder="Empty = same template as every number" onChange={(e) => set('tplOtp', e.target.value)} /></div>
          <div><label htmlFor="wn-tb">Different template for bulk / general messages <span className="cm-sub">optional</span></label><input id="wn-tb" value={f.tplBulk} placeholder="Empty = same template as every number" onChange={(e) => set('tplBulk', e.target.value)} /></div>
        </div>
      )}
    </Modal>
  );
}

// ---- Business portfolio (quick label, no check with Meta) ---------------------------------------------------------------------
function PortfolioModal({ data, n, onClose, onSaved }) {
  const [value, setValue] = useState(n.portfolio || '');
  // numbers of the same WhatsApp Business Account are under the same portfolio, so they are offered together (ticked, the Admin can untick)
  const sameAccount = useMemo(() => (n.wabaId ? data.numbers.filter((x) => x.id !== n.id && !x.virtual && x.wabaId === n.wabaId) : []), [data, n]);
  const [also, setAlso] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setBusy(true); setErr('');
    try {
      const targets = [n, ...(also ? sameAccount : [])].filter((x) => (x.portfolio || '') !== value.trim());
      for (const t of targets) await api.put(`/wa-numbers/${t.id}`, { portfolio: value, check: false }); // eslint-disable-line no-await-in-loop
      const names = targets.map((t) => t.label).join(', ');
      onSaved(!targets.length ? 'Nothing changed.' : value.trim() ? `Saved: ${names} ${targets.length === 1 ? 'is' : 'are'} under "${value.trim()}".` : `The portfolio label was cleared for ${names}.`);
    } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  }
  return (
    <Modal
      title={`Business portfolio of ${n.label}`}
      note={fmtNumber(n.displayNumber)}
      onClose={onClose}
      foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}
    >
      {err && <div className="cm-line cm-red" role="alert">{err}</div>}
      <div className="field">
        <label htmlFor="wn-port2">Business portfolio</label>
        <input id="wn-port2" list="wn-portfolios2" value={value} maxLength={60} autoFocus placeholder="For example: TeamLink Medical Consultancy" onChange={(e) => setValue(e.target.value)} />
        <datalist id="wn-portfolios2">{(data.portfolios || []).map((p) => <option key={p} value={p} />)}</datalist>
        <div className="cm-sub">Messages are billed to the Meta business portfolio that owns this number&apos;s WhatsApp Business Account{n.wabaId ? ` (ID ${n.wabaId})` : ''}. This is only a label so you can see what bills where. It changes nothing in Meta and nothing in how messages are sent. Leave it empty to clear it.</div>
      </div>
      {sameAccount.length > 0 && (
        <label className="wn-tick"><input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} /> Also set it for {sameAccount.map((x) => x.label).join(', ')} (same WhatsApp Business Account, so the same portfolio)</label>
      )}
    </Modal>
  );
}

// ---- Assign -----------------------------------------------------------------------------------------------------------------
function AssignModal({ data, n, onClose, onSaved }) {
  const liveDepts = useActiveDepartments(); // only switched-on Department & Team names (+ ones already ticked)
  const [tab, setTab] = useState('dept');
  const [sel, setSel] = useState(() => ({ departments: new Set(n.departments || []), userIds: new Set((n.users || []).map((u) => u.id)), roles: new Set((n.roles || []).map((r) => r.code)), everyone: !!n.everyone }));
  const [people, setPeople] = useState(null);
  const [counts, setCounts] = useState(null);
  const [eff, setEff] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get('/wa-numbers/people').then((r) => setPeople(r.data.people)).catch(() => setPeople([]));
    api.get('/wa-numbers/departments').then((r) => setCounts(r.data.departments)).catch(() => setCounts([]));
    api.get(`/wa-numbers/${n.id}/effective`).then((r) => setEff(r.data)).catch(() => setEff(null));
  }, [n.id]);
  const flip = (key, v) => setSel((s) => { const next = new Set(s[key]); if (next.has(v)) next.delete(v); else next.add(v); return { ...s, [key]: next }; });
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (people || []).filter((p) => !s || `${p.name} ${p.designation} ${p.department} ${p.code}`.toLowerCase().includes(s));
  }, [people, q]);
  async function save() {
    setBusy(true); setErr('');
    try {
      await api.put(`/wa-numbers/${n.id}/access`, { departments: [...sel.departments], userIds: [...sel.userIds], roles: [...sel.roles], everyone: sel.everyone });
      const e2 = await api.get(`/wa-numbers/${n.id}/effective`).then((r) => r.data).catch(() => null);
      onSaved(`Saved. ${e2 ? `${e2.count} ${e2.count === 1 ? 'person' : 'people'} can send from ${n.label} now.` : ''} The change works from the very next message.`);
    } catch (e) { setErr(errOf(e, 'The assignment could not be saved.')); } finally { setBusy(false); }
  }
  const nothing = !sel.departments.size && !sel.userIds.size && !sel.roles.size && !sel.everyone;
  return (
    <Modal
      title={`Who can send from ${n.label}`}
      note={fmtNumber(n.displayNumber)}
      onClose={onClose}
      foot={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </>}
    >
      {err && <div className="cm-line cm-red" role="alert">{err}</div>}
      <div className="cm-line cm-blue">{eff ? `Now ${eff.count} ${eff.count === 1 ? 'person' : 'people'} can send from this number${eff.count > eff.assigned ? ` (${eff.count - eff.assigned} of them are Admins, who can use every number)` : ''}.` : 'Counting…'}</div>
      <div className="cm-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'dept'} className={tab === 'dept' ? 'on' : ''} onClick={() => setTab('dept')}>Departments ({sel.departments.size})</button>
        <button type="button" role="tab" aria-selected={tab === 'people'} className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}>People ({sel.userIds.size})</button>
        <button type="button" role="tab" aria-selected={tab === 'roles'} className={tab === 'roles' ? 'on' : ''} onClick={() => setTab('roles')}>Roles ({sel.roles.size + (sel.everyone ? 1 : 0)})</button>
      </div>
      {tab === 'dept' && (
        <div className="dept-checklist wn-depts wn-tall" role="group" aria-label="Departments">
          {keepActive(liveDepts, counts || data.departments.map((d) => ({ name: d, people: null })), (d) => d.name, [...sel.departments]).map((d) => (
            <label key={d.name}><input type="checkbox" checked={sel.departments.has(d.name)} onChange={() => flip('departments', d.name)} /> {d.name}{d.people != null ? <span className="cm-sub"> · {d.people} {d.people === 1 ? 'person' : 'people'}</span> : null}</label>
          ))}
        </div>
      )}
      {tab === 'people' && (
        <div>
          <input className="wn-search" type="search" placeholder="Type a name, job title or department" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" autoFocus />
          <div className="dept-checklist wn-people wn-tall" role="group" aria-label="People">
            {people === null && <span className="cm-sub">Loading…</span>}
            {people !== null && shown.length === 0 && <span className="cm-sub">Nobody matches.</span>}
            {shown.map((p) => (
              <label key={p.userId}><input type="checkbox" checked={sel.userIds.has(p.userId)} onChange={() => flip('userIds', p.userId)} /> <b>{p.name}</b><span className="cm-sub"> · {[p.designation, p.department].filter(Boolean).join(' · ')}</span></label>
            ))}
          </div>
        </div>
      )}
      {tab === 'roles' && (
        <div className="dept-checklist wn-depts wn-tall" role="group" aria-label="Roles">
          <label className="dept-all"><input type="checkbox" checked={sel.everyone} onChange={() => setSel((s) => ({ ...s, everyone: !s.everyone }))} /> Everyone who works at the company (as it was before)</label>
          {data.roles.map((r) => (
            <label key={r.code}><input type="checkbox" checked={sel.roles.has(r.code)} onChange={() => flip('roles', r.code)} /> {r.label}</label>
          ))}
        </div>
      )}
      {nothing && <div className="cm-line cm-orange">Nothing is ticked, so nobody (except Admins) can send from this number. It will show &quot;Not assigned to anyone&quot;.</div>}
    </Modal>
  );
}

// ---- Remove ---------------------------------------------------------------------------------------------------------------------
function RemoveModal({ n, onClose, onDone }) {
  const [h, setH] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`/wa-numbers/${n.id}/history`).then((r) => setH(r.data)).catch(() => setH({ messages: 0, chats: 0 })); }, [n.id]);
  const has = h && (h.messages > 0 || h.chats > 0);
  async function go() {
    setBusy(true); setErr('');
    try { await api.delete(`/wa-numbers/${n.id}`); onDone(`${n.label} was removed from the list.`); } catch (e) { setErr(errOf(e, 'It could not be removed.')); } finally { setBusy(false); }
  }
  return (
    <Modal
      title={`Remove ${n.label}?`}
      onClose={onClose}
      foot={<>
        <button type="button" className="btn" onClick={onClose}>{has ? 'Close' : 'No, keep it'}</button>
        {!has && <button type="button" className="btn btn-primary" disabled={busy || !h} onClick={go}>{busy ? 'Removing…' : `Yes, remove ${n.label}`}</button>}
      </>}
    >
      {err && <div className="cm-line cm-red" role="alert">{err}</div>}
      <p><b>{n.label}</b> ({fmtNumber(n.displayNumber)})</p>
      {!h && <div className="cm-sub">Counting its history…</div>}
      {h && !has && <div className="cm-line cm-blue">This number has no messages, so it can be removed. You can add it again later.</div>}
      {has && <div className="cm-line cm-orange">This number has {h.messages} message{h.messages === 1 ? '' : 's'} in {h.chats} chat{h.chats === 1 ? '' : 's'}. It cannot be removed, because the history must stay. Use <b>Deactivate</b> instead: nothing is sent from it, and the history is kept.</div>}
    </Modal>
  );
}

// ---- Company settings --------------------------------------------------------------------------------------------------------------
function SettingsModal({ data, onClose, onSaved }) {
  const [s, setS] = useState({ ...data.settings });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const active = data.numbers.filter((n) => n.active && !n.virtual);
  async function save() {
    setBusy(true); setErr('');
    try { await api.put('/wa-numbers/settings', { systemNumberId: s.systemNumberId || null, fallbackToDefault: !!s.fallbackToDefault, adminsAllNumbers: s.adminsAllNumbers !== false }); onSaved('Saved.'); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  }
  return (
    <Modal
      title="Company settings for WhatsApp numbers"
      onClose={onClose}
      foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}
    >
      {err && <div className="cm-line cm-red" role="alert">{err}</div>}
      {!data.listed && <div className="cm-line cm-blue">These settings work once a number is in the list.</div>}
      <div className="field">
        <label htmlFor="wn-sys">System messages use this number</label>
        <Combo id="wn-sys" value={s.systemNumberId || ''} onChange={(e) => setS({ ...s, systemNumberId: e.target.value })}>
          <option value="">The default number</option>
          {active.map((n) => <option key={n.id} value={n.id}>{n.label} ({fmtNumber(n.displayNumber)})</option>)}
        </Combo>
        <div className="cm-sub">Messages TeamLink sends by itself (OTP, agreement links, reminders, notices) have no person behind them. They leave from this number.</div>
      </div>
      <label className="wn-tick"><input type="checkbox" checked={!!s.fallbackToDefault} onChange={(e) => setS({ ...s, fallbackToDefault: e.target.checked })} /> If the assigned number is down, send from the default number</label>
      <div className="cm-sub">Off by default. When on, the message leaves from another number, so the person who gets it sees a different sender. Only people allowed to use the default number are moved to it.</div>
      <label className="wn-tick"><input type="checkbox" checked={s.adminsAllNumbers !== false} onChange={(e) => setS({ ...s, adminsAllNumbers: e.target.checked })} /> Admins can send from every number and see every chat</label>
    </Modal>
  );
}
