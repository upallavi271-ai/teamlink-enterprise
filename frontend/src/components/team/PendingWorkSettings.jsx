import { useEffect, useState } from 'react';
import api from '../../api';
import { errText } from './pendingWorkKit.jsx';
import './pendingWork.css';

// ---------------------------------------------------------------------------
// REMINDERS TO TEAM LEADS — every switch in plain words.
// GET / PUT /api/pending-work/settings (Super Admin / Admin / HR change; leads read).
// Used in the modal on Team -> Pending work and as a card in Step timing.
// "Send a test run" = POST /pending-work/digest/run and /eod/run with dryRun:true:
// it shows who WOULD get what; nothing is sent.
// ---------------------------------------------------------------------------

const clone = (o) => JSON.parse(JSON.stringify(o));

function Switch({ checked, onChange, disabled, children, hint }) {
  return (
    <label className={`pwk-sw${disabled ? ' is-off' : ''}`}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="pwk-sw-text">
        {children}
        {hint && <span className="small-muted pwk-sw-hint">{hint}</span>}
      </span>
    </label>
  );
}

function Num({ value, onChange, disabled, min = 0, max = 60, label }) {
  return (
    <input
      type="number"
      className="pwk-num"
      min={min}
      max={max}
      value={value === undefined || value === null ? '' : value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
    />
  );
}

function Time({ value, onChange, disabled, label }) {
  return <input type="time" className="pwk-time" value={value || ''} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.value)} />;
}

function TestResult({ title, res }) {
  if (!res) return null;
  if (res.loading) return <div className="small-muted">Checking…</div>;
  if (res.error) return <div className="notice red">{res.error}</div>;
  const teams = res.teams || [];
  return (
    <div className="pwk-test">
      <div className="pwk-test-title">{title} <span className="small-muted">(nothing was sent)</span></div>
      {res.skipped && <div className="small-muted">{res.skipped}</div>}
      {!res.skipped && !teams.length && <div className="small-muted">Nobody would get anything right now.</div>}
      {teams.map((t, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className="pwk-test-row">
          <b>{t.tl}</b>
          <span className="small-muted">
            {[
              t.recruiters ? `${t.recruiters} recruiter${t.recruiters === 1 ? '' : 's'}` : null,
              t.late ? `${t.late} late` : null,
              t.dueToday ? `${t.dueToday} due today` : null,
              t.waiting ? `${t.waiting} waiting` : null,
            ].filter(Boolean).join(' · ')}
          </span>
          <span className={`pwk-tag ${/would send/.test(t.status) ? 'pwk-tag-green' : 'pwk-tag-grey'}`}>{t.status || '—'}</span>
        </div>
      ))}
      {res.copies > 0 && <div className="small-muted">{`${res.copies} copy${res.copies === 1 ? '' : ' copies'} to STL / Manager.`}</div>}
    </div>
  );
}

function ChainResult({ res }) {
  if (!res) return null;
  if (res.loading) return <div className="small-muted">Checking…</div>;
  if (res.error) return <div className="notice red">{res.error}</div>;
  const kinds = Object.entries(res.byKind || {}).filter(([, n]) => Number(n) > 0);
  return (
    <div className="pwk-test">
      <div className="pwk-test-title">Pending approvals and follow-ups <span className="small-muted">(nothing was sent)</span></div>
      {res.skipped && <div className="small-muted">{res.skipped}</div>}
      {!res.skipped && !Number(res.items) && <div className="small-muted">Nothing is pending right now.</div>}
      {Number(res.items) > 0 && (
        <div className="small-muted">
          {`${res.items} pending item${res.items === 1 ? '' : 's'}`}
          {kinds.length ? ` (${kinds.map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}
          {` · ${res.toTell || 0} message${res.toTell === 1 ? '' : 's'} to ${res.people || 0} people`}
        </div>
      )}
      {(res.preview || []).map((p, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className="pwk-test-row">
          <b>{p.to}</b>
          <span className="small-muted">{[p.forYou ? `${p.forYou} for you` : null, p.onYourTeam ? `${p.onYourTeam} on your team` : null].filter(Boolean).join(' · ')}</span>
        </div>
      ))}
    </div>
  );
}

export default function PendingWorkSettings({ onSaved, onClose, embedded = false }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [dig, setDig] = useState(null);
  const [eod, setEod] = useState(null);
  const [chain, setChain] = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/pending-work/settings')
      .then((r) => { if (live) { setData(r.data); setForm(clone(r.data.settings)); } })
      .catch((e) => { if (live) setErr(errText(e, 'The settings could not be loaded. Please try again.')); });
    return () => { live = false; };
  }, []);

  if (err && !form) return <div className="notice red">{err}</div>;
  if (!form) return <div className="small-muted">Loading…</div>;

  const edit = !!data.canEdit;
  const ch = data.channels || {};
  const upd = (fn) => { setMsg(''); setForm((f) => { const n = clone(f); fn(n); return n; }); };
  const tls = data.teamLeads || [];
  const off = new Set(form.eod.offTls || []);

  async function save() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.put('/pending-work/settings', form);
      setForm(clone(r.data.settings));
      setData((d) => ({ ...d, settings: r.data.settings }));
      setMsg('Saved');
      if (onSaved) onSaved(r.data.settings);
    } catch (e) { setErr(errText(e, 'Could not save. Please try again.')); } finally { setBusy(false); }
  }
  async function testRun(kind) {
    const set = kind === 'eod' ? setEod : kind === 'chain' ? setChain : setDig;
    set({ loading: true });
    try {
      const r = await api.post(`/pending-work/${kind === 'eod' ? 'eod' : kind === 'chain' ? 'chain' : 'digest'}/run`, { dryRun: true });
      set(r.data);
    } catch (e) { set({ error: errText(e, 'The test run could not be made. Please try again.') }); }
  }

  return (
    <div className={`pwk-set${embedded ? ' is-embedded' : ''}`}>
      {!edit && <div className="notice">Only a Super Admin, Admin or HR can change these. You can read them.</div>}

      <section className="pwk-set-sec">
        <h4>Daily list for team leads</h4>
        <Switch checked={form.enabled} disabled={!edit} onChange={(v) => upd((f) => { f.enabled = v; })}>
          <b>Switch on</b> the reminders to team leads
        </Switch>
        <div className="pwk-line">
          Send the daily list at <Time value={form.digestTime} disabled={!edit} onChange={(v) => upd((f) => { f.digestTime = v; })} label="Send the daily list at" />
        </div>
        <Switch checked={form.bell} disabled={!edit} onChange={(v) => upd((f) => { f.bell = v; })}>Show it in the bell</Switch>
        <Switch
          checked={form.email}
          disabled={!edit}
          onChange={(v) => upd((f) => { f.email = v; })}
          hint={ch.Email === false ? 'E-mail is not connected yet, so no mail goes out. The bell still works.' : undefined}
        >
          Send it by e-mail
        </Switch>
        <Switch checked={form.copyStl} disabled={!edit} onChange={(v) => upd((f) => { f.copyStl = v; })}>Also copy the STL</Switch>
        <Switch checked={form.copyManager} disabled={!edit} onChange={(v) => upd((f) => { f.copyManager = v; })}>Also copy the Manager</Switch>
      </section>

      <section className="pwk-set-sec">
        <h4>When a step is late</h4>
        <Switch checked={form.escalation.enabled} disabled={!edit} onChange={(v) => upd((f) => { f.escalation.enabled = v; })}>Tell the boss when a step is late</Switch>
        <div className="pwk-line">
          Tell the team lead when a step is late by more than
          {' '}
          <Num value={form.escalation.afterDays} disabled={!edit} min={0} max={60} label="Team lead after days" onChange={(v) => upd((f) => { f.escalation.afterDays = v; })} />
          {' '}day(s)
        </div>
        <div className="pwk-line">
          and tell the STL / Manager after
          {' '}
          <Num value={form.escalation.managerAfterDays} disabled={!edit} min={0} max={60} label="STL or Manager after days" onChange={(v) => upd((f) => { f.escalation.managerAfterDays = v; })} />
          {' '}day(s)
        </div>
      </section>

      <section className="pwk-set-sec">
        <h4>Client work (BDE)</h4>
        <Switch checked={form.bde.enabled} disabled={!edit} onChange={(v) => upd((f) => { f.bde.enabled = v; })}>Switch on the daily client-work list for client managers (BDE)</Switch>
        <div className="pwk-line">
          Chase the client after
          {' '}
          <Num value={form.bde.feedbackDays} disabled={!edit} min={1} max={30} label="Chase the client after days" onChange={(v) => upd((f) => { f.bde.feedbackDays = v; })} />
          {' '}day(s) with no reply
        </div>
        <Switch checked={form.bde.copyBdeTl} disabled={!edit} onChange={(v) => upd((f) => { f.bde.copyBdeTl = v; })}>Also copy the BDE team lead</Switch>
      </section>

      {form.chain && (
        <section className="pwk-set-sec">
          <h4>Pending approvals and follow-ups</h4>
          <Switch checked={form.chain.enabled} disabled={!edit} onChange={(v) => upd((f) => { f.chain.enabled = v; })}>
            Tell everyone above at once when an approval or a follow-up is pending
          </Switch>
          <Switch checked={form.chain.approvals} disabled={!edit} onChange={(v) => upd((f) => { f.chain.approvals = v; })}>Approvals (leave, late coming, offers, ...)</Switch>
          <Switch checked={form.chain.followUps} disabled={!edit} onChange={(v) => upd((f) => { f.chain.followUps = v; })}>Follow-ups past their day</Switch>
          <Switch checked={form.chain.repeatDaily} disabled={!edit} onChange={(v) => upd((f) => { f.chain.repeatDaily = v; })}>Remind again every working day until it is done</Switch>
          <div className="pwk-line">
            Tell up to
            {' '}
            <select className="pwk-sel" value={form.chain.maxLevel} disabled={!edit} aria-label="Tell up to" onChange={(e) => upd((f) => { f.chain.maxLevel = Number(e.target.value); })}>
              <option value={1}>the Team lead</option>
              <option value={2}>the STL</option>
              <option value={3}>the Manager</option>
              <option value={4}>the Admin</option>
            </select>
          </div>
          <div className="small-muted">Wait this many hours before telling each person (0 = at once):</div>
          <div className="pwk-hours">
            {['The person', 'Team lead', 'STL', 'Manager', 'Admin'].map((l, i) => (
              <label key={l} className="pwk-hours-one">
                <span className="small-muted">{l}</span>
                <Num
                  value={(form.chain.levelHours || [])[i]}
                  disabled={!edit}
                  min={0}
                  max={240}
                  label={`Hours before telling: ${l}`}
                  onChange={(v) => upd((f) => { const a = [...(f.chain.levelHours || [0, 0, 0, 0, 0])]; a[i] = v === '' ? 0 : v; f.chain.levelHours = a; })}
                />
              </label>
            ))}
          </div>
        </section>
      )}

      <section className="pwk-set-sec">
        <h4>When you press Remind</h4>
        <div className="small-muted">The person always gets a bell message. You can also send it by:</div>
        {[['whatsapp', 'WhatsApp', 'WhatsApp'], ['sms', 'SMS', 'SMS'], ['email', 'E-mail', 'Email']].map(([k, label, chKey]) => (
          <Switch
            key={k}
            checked={form.nudge[k]}
            disabled={!edit || ch[chKey] === false}
            onChange={(v) => upd((f) => { f.nudge[k] = v; })}
            hint={ch[chKey] === false ? `${label} is not connected yet.` : undefined}
          >
            {label}
          </Switch>
        ))}
      </section>

      <section className="pwk-set-sec">
        <h4>End-of-day report</h4>
        <Switch checked={form.eod.enabled} disabled={!edit} onChange={(v) => upd((f) => { f.eod.enabled = v; })}>Switch on the end-of-day report for team leads</Switch>
        <div className="pwk-line">
          Send it at <Time value={form.eod.time} disabled={!edit} onChange={(v) => upd((f) => { f.eod.time = v; })} label="Send the end-of-day report at" />
        </div>
        <Switch checked={form.eod.copyStl} disabled={!edit} onChange={(v) => upd((f) => { f.eod.copyStl = v; })}>Also copy the STL</Switch>
        <Switch checked={form.eod.copyManager} disabled={!edit} onChange={(v) => upd((f) => { f.eod.copyManager = v; })}>Also copy the Manager</Switch>
        <Switch checked={form.eod.excel} disabled={!edit} onChange={(v) => upd((f) => { f.eod.excel = v; })}>Attach the Excel file</Switch>
        <div className="pwk-line">
          A team with no activity today gets
          {' '}
          <select
            className="pwk-sel"
            value={form.eod.quiet}
            disabled={!edit}
            aria-label="A quiet team gets"
            onChange={(e) => upd((f) => { f.eod.quiet = e.target.value; })}
          >
            <option value="short">a short &quot;no activity&quot; line</option>
            <option value="skip">nothing</option>
          </select>
        </div>
        {tls.length > 0 && (
          <div className="pwk-tls">
            <div className="small-muted">Send the report to these team leads:</div>
            {tls.map((t) => (
              <Switch
                key={t.id}
                checked={!off.has(t.id)}
                disabled={!edit}
                onChange={(v) => upd((f) => {
                  const s = new Set(f.eod.offTls || []);
                  if (v) s.delete(t.id); else s.add(t.id);
                  f.eod.offTls = [...s];
                })}
              >
                {t.name}
                <span className="small-muted">{t.department ? ` · ${t.department}` : ''}</span>
              </Switch>
            ))}
          </div>
        )}
      </section>

      {msg && <div className="fux-banner is-green" role="status">{msg}</div>}
      {err && <div className="notice red">{err}</div>}

      <div className="pwk-set-foot">
        {edit && <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>}
        {onClose && <button type="button" className="btn" onClick={onClose}>Close</button>}
      </div>

      {edit && (
        <section className="pwk-set-sec pwk-set-test">
          <h4>Try it first</h4>
          <div className="small-muted">Shows who would get what, with today&apos;s numbers. Nothing is sent.</div>
          <div className="pwk-set-foot">
            <button type="button" className="btn btn-sm" onClick={() => testRun('digest')}>Send a test run (nothing is sent) — daily list</button>
            <button type="button" className="btn btn-sm" onClick={() => testRun('eod')}>Send a test run (nothing is sent) — end of day</button>
            {form.chain && <button type="button" className="btn btn-sm" onClick={() => testRun('chain')}>Send a test run (nothing is sent) — pending approvals</button>}
          </div>
          <TestResult title="Daily list" res={dig} />
          <TestResult title="End-of-day report" res={eod} />
          <ChainResult res={chain} />
        </section>
      )}
    </div>
  );
}
