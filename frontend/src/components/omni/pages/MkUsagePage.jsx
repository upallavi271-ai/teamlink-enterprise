import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Kpi, Kpis, Panel, Pill, Tag, Banner, Field, fmtNum, fmtDateTime } from '../ui.jsx';
import { AiBanner, aiLabel } from '../marketing/mk.jsx';

// AI MARKETING > AI USAGE: every AI request (who, which module, which model, how big, how long), the limits, and which AI parts are connected.
const SLOT = { text: 'Text', image: 'Images', video: 'Videos', audio: 'Audio' };
const TASK = { draft: 'Wrote versions', revise: 'Rewrote one message', video: 'Planned a video from a prompt', post: 'Planned a post from a prompt' };
export default function MkUsagePage() {
  const { toast } = useOmni();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [lim, setLim] = useState({ aiDailyPerUser: 60, aiMonthlyCap: 0, selfApprove: true, clientRequired: false, clientFor: ['words', 'pictures', 'videos'], autoPostAllowed: false, autoRevise: true, accessLogin: '', accessBusinessId: '', autoMake: 'off', clientNotify: { auto: true, whatsapp: true, email: true }, waTemplates: {} });
  const [busy, setBusy] = useState(false);
  const [ways, setWays] = useState(null); // is WhatsApp / email connected (what the "tell the client" switch can really use)
  const [roles, setRoles] = useState(null); // the Admin's table: who sees what in AI Marketing (a non-Admin gets a refusal and sees nothing here)
  const load = useCallback(() => omni.get('/gs/marketing/usage').then((x) => { setD(x); setLim({ aiDailyPerUser: x.settings.aiDailyPerUser, aiMonthlyCap: x.settings.aiMonthlyCap, selfApprove: x.settings.selfApprove, clientRequired: !!x.settings.clientRequired, clientFor: x.settings.clientFor || ['words', 'pictures', 'videos'], autoPostAllowed: !!x.settings.autoPostAllowed, autoRevise: x.settings.autoRevise !== false, accessLogin: x.settings.accessLogin || '', accessBusinessId: x.settings.accessBusinessId || '', autoMake: x.settings.autoMake || 'off', clientNotify: x.settings.clientNotify || { auto: true, whatsapp: true, email: true }, waTemplates: x.settings.waTemplates || {} }); }).catch((e) => setErr(errOf(e, 'The usage could not be read.'))), []);
  useEffect(() => { load(); omni.get('/gs/marketing/projects/notify').then(setWays).catch(() => setWays(null)); omni.get('/gs/marketing/roles').then((x) => setRoles(x.roles)).catch(() => setRoles(null)); }, [load]);
  if (err && !d) return <Banner tone="error">{err}</Banner>;
  if (!d) return <div className="card panel">Loading…</div>;
  const s = d.summary;
  const save = async () => {
    setBusy(true);
    try { const r = await omni.put('/gs/marketing/settings', lim); toast(r.ok || 'Saved'); await load(); } catch (e) { toast(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="AI usage" />
      <AiBanner ai={d.ai} />
      <Kpis>
        <Kpi label="This month" icon="✧" value={fmtNum(s.month)} meta="AI requests that worked" />
        <Kpi label="Today" icon="◔" value={fmtNum(s.today)} meta={`Limit ${d.settings.aiDailyPerUser} per person a day`} />
        <Kpi label="Failed this month" icon="!" value={fmtNum(s.failed)} tone={s.failed > 0 ? 'warn' : 'neutral'} meta="Not ready, over a limit, or unreadable" />
        <Kpi label="Company limit" icon="∑" value={d.settings.aiMonthlyCap ? fmtNum(d.settings.aiMonthlyCap) : 'None'} meta="AI requests a month" />
      </Kpis>
      {d.canEdit && roles ? (
        <Panel title="Who sees what in AI Marketing" style={{ marginTop: 14 }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="mk-table"><thead><tr><th>LOGIN</th><th>SEES IN AI MARKETING</th><th>MAY</th></tr></thead>
              <tbody>{roles.map((r) => (
                <tr key={r.kind}>
                  <td style={{ whiteSpace: 'nowrap' }}><b>{r.who}</b></td>
                  <td style={{ fontSize: 12 }}>{r.sees.length ? r.sees.join(' · ') : <span style={{ color: 'var(--muted)' }}>Nothing: AI Marketing is not shown</span>}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{r.settings ? 'Everything, and the settings' : r.writes ? 'Write and make; an approver approves' : r.approves ? 'Approve or send back' : r.outside ? 'Approve their own work' : 'Nothing here'}</td>
                </tr>
              ))}</tbody></table>
          </div>
        </Panel>
      ) : null}
      <Panel title="What is connected" style={{ marginTop: 14 }}>
        <div className="mk-prov">
          {Object.keys(SLOT).map((k) => { const a = d.ai[k] || {}; return (
            <div key={k}><b>{SLOT[k]} {a.ready ? <Pill tone={a.demo ? 'warn' : 'live'} dot>{a.demo ? 'Sample writer' : 'Ready'}</Pill> : <Pill tone="draft">Not connected</Pill>}</b>
              <span>{a.ready ? aiLabel(a) : (a.reason || 'Not connected yet.')}</span></div>
          ); })}
        </div>
      </Panel>
      {d.canEdit && (
        <Panel title="Limits" style={{ marginTop: 14 }} right={<Btn primary disabled={busy} onClick={save}>Save limits</Btn>}>
          <div className="form-grid">
            <Field label="AI REQUESTS PER PERSON PER DAY"><input type="number" min="0" max="2000" value={lim.aiDailyPerUser} onChange={(e) => setLim({ ...lim, aiDailyPerUser: e.target.value })} /></Field>
            <Field label="COMPANY LIMIT PER MONTH"><input type="number" min="0" value={lim.aiMonthlyCap} onChange={(e) => setLim({ ...lim, aiMonthlyCap: e.target.value })} /></Field>
            <Field label="AN ADMIN MAY APPROVE THEIR OWN CONTENT" full><select value={lim.selfApprove ? 'yes' : 'no'} onChange={(e) => setLim({ ...lim, selfApprove: e.target.value === 'yes' })}><option value="yes">Yes</option><option value="no">No</option></select></Field>
          </div>
        </Panel>
      )}
      {d.canEdit && (
        <Panel title="Who approves: your team or the client" style={{ marginTop: 14 }} right={<Btn primary disabled={busy} onClick={save}>Save</Btn>}>
          <div className="form-grid">
            <Field label="ONLY A CLIENT CAN APPROVE" full>
              <select value={lim.clientRequired ? 'yes' : 'no'} onChange={(e) => setLim({ ...lim, clientRequired: e.target.value === 'yes' })}><option value="no">Off: my team approves</option><option value="yes">On: only the client approves</option></select>
            </Field>
            <Field label="WHEN A CLIENT ASKS FOR CHANGES ON A BANNER OR PICTURE" full>
              <select value={lim.autoRevise ? 'auto' : 'person'} onChange={(e) => setLim({ ...lim, autoRevise: e.target.value === 'auto' })}><option value="auto">TeamLink changes it by itself and sends it to the client again (up to 3 rounds)</option><option value="person">A person changes it: the sender is told what the client wrote</option></select>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>It understands the usual requests (the website link on one line or under the headline, remove or change a line, "change X to Y", a colour). When the picture was made by the AI it also makes a new banner picture, or changes the picture itself, the way the client describes; words drawn inside a picture are left to a person. If it does not understand, nothing is sent and the sender is told.</div>
            </Field>
            {lim.clientRequired ? (
              <Field label="THE CLIENT MUST APPROVE" full>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
                  {[['words', 'Words (AI Content)'], ['pictures', 'Pictures'], ['videos', 'Finished videos']].map(([k, label]) => (
                    <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="checkbox" checked={lim.clientFor.includes(k)} onChange={(e) => setLim({ ...lim, clientFor: e.target.checked ? [...lim.clientFor, k] : lim.clientFor.filter((x) => x !== k) })} />{label}
                    </label>
                  ))}
                </div>
              </Field>
            ) : null}
          </div>
        </Panel>
      )}
      {d.canEdit && (
        <Panel title="Telling the client" style={{ marginTop: 14 }} right={<Btn primary disabled={busy} onClick={save}>Save</Btn>}>
          <div className="form-grid">
            <Field label="TELL THE CLIENT BY ITSELF" full>
              <select value={lim.clientNotify.auto ? 'yes' : 'no'} onChange={(e) => setLim({ ...lim, clientNotify: { ...lim.clientNotify, auto: e.target.value === 'yes' } })}><option value="yes">On: tell the client at each step</option><option value="no">Off: the team sends by hand</option></select>
            </Field>
            <Field label="ANSWER THE CLIENT'S WHATSAPP MESSAGES BY ITSELF" full>
              <select value={lim.clientNotify.chat !== false ? 'yes' : 'no'} onChange={(e) => setLim({ ...lim, clientNotify: { ...lim.clientNotify, chat: e.target.value === 'yes' } })}><option value="yes">On: answer simply by itself</option><option value="no">Off: only the team answers</option></select>
            </Field>
            <Field label="ONE REMINDER AFTER 24 HOURS" full>
              <select value={lim.clientNotify.remind !== false ? 'yes' : 'no'} onChange={(e) => setLim({ ...lim, clientNotify: { ...lim.clientNotify, remind: e.target.value === 'yes' } })}><option value="yes">On: one reminder after 24 hours</option><option value="no">Off: no reminders</option></select>
            </Field>
            <Field label="WAYS" full>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, margin: '2px 0' }}><input type="checkbox" checked={lim.clientNotify.whatsapp} onChange={(e) => setLim({ ...lim, clientNotify: { ...lim.clientNotify, whatsapp: e.target.checked } })} />WhatsApp {ways ? (ways.whatsapp.ready ? <Pill tone="live" dot>Connected</Pill> : <Pill tone="warn" dot>Not connected: {ways.whatsapp.reason}</Pill>) : null}</label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, margin: '2px 0' }}><input type="checkbox" checked={lim.clientNotify.email} onChange={(e) => setLim({ ...lim, clientNotify: { ...lim.clientNotify, email: e.target.checked } })} />Email {ways ? (ways.email.ready ? <Pill tone="live" dot>Connected</Pill> : <Pill tone="warn" dot>Not connected: {ways.email.reason}</Pill>) : null}</label>
            </Field>
            {ways && ways.suggestions ? (
              <Field label="WHATSAPP TEMPLATES" full>
                {Object.entries(ways.suggestions).map(([k, sg]) => {
                  const cur = lim.waTemplates[k] || { name: '', language: 'en' }; const known = (ways.templates && ways.templates[k] && ways.templates[k].known) || 'none';
                  const set = (p) => setLim({ ...lim, waTemplates: { ...lim.waTemplates, [k]: { ...cur, ...p } } });
                  const chip = cur.name ? (known === 'approved' ? <Pill tone="live" dot>Approved at Meta</Pill> : known === 'pending' ? <Pill tone="warn" dot>Waiting for Meta</Pill> : known === 'rejected' ? <Pill tone="red" dot>Rejected by Meta</Pill> : <Pill tone="draft">TeamLink cannot check it: Meta decides when it is sent</Pill>) : <Pill tone="draft">Free text</Pill>;
                  return (
                    <div key={k} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px', margin: '6px 0' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b style={{ fontSize: 12.5 }}>{sg.label}</b> <Tag>{sg.category}</Tag> {chip}</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0' }}>
                        <input value={cur.name} maxLength={200} placeholder="template_name_at_meta" onChange={(e) => set({ name: e.target.value.trim().toLowerCase() })} style={{ flex: '1 1 220px' }} aria-label={`Template name for ${sg.label}`} />
                        <select value={cur.language || 'en'} onChange={(e) => set({ language: e.target.value })} aria-label="Language"><option value="en">English (en)</option><option value="te">Telugu (te)</option><option value="hi">Hindi (hi)</option><option value="en_US">English US (en_US)</option></select>
                      </div>
                      <details><summary style={{ fontSize: 11.5, cursor: 'pointer' }}>Suggested words and what each blank is</summary>
                        <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#f6f8f7', borderRadius: 8, padding: '7px 9px', margin: '6px 0' }}>{sg.body}</div>
                        <ol style={{ margin: '0 0 4px', paddingLeft: 18, fontSize: 11.5, color: '#54645b' }}>{sg.vars.map((v, i) => <li key={i}>{'{{'}{i + 1}{'}}'} = {v}</li>)}</ol>
                        <TinyBtn onClick={async () => { try { await navigator.clipboard.writeText(sg.body); toast('Words copied'); } catch { window.prompt('Copy the words:', sg.body); } }}>⧉ Copy the words</TinyBtn>
                      </details>
                    </div>
                  );
                })}
              </Field>
            ) : null}
          </div>
        </Panel>
      )}
      {d.canEdit && (
        <Panel title="First options made by itself" sub="When a client asks for pictures, TeamLink can make the first picture options from their request, without anybody starting it." style={{ marginTop: 14 }} right={<Btn primary disabled={busy} onClick={save}>Save</Btn>}>
          <div className="form-grid">
            <Field label="WHEN A CLIENT SENDS A REQUEST FOR PICTURES" full hint="Pictures only: a request for a video is always made by the team. Nothing is posted: the client still chooses the one they like, and that choice is the approval. The pictures use the AI limits and the picture allowance of the Admin it runs as, and every step is on the project's timeline. If something fails, the request stays as it was and the team is told.">
              <select value={lim.autoMake || 'off'} onChange={(e) => setLim({ ...lim, autoMake: e.target.value })}><option value="off">Off: the team makes the options</option><option value="options">Make three picture options for the team to check, then the team sends them</option><option value="send">Make three picture options and send them to the client by themselves</option></select>
            </Field>
          </div>
        </Panel>
      )}
      {d.canEdit && (
        <Panel title="Posting to client accounts" style={{ marginTop: 14 }} right={<Btn primary disabled={busy} onClick={save}>Save</Btn>}>
          <div className="form-grid">
            <Field label="POST FROM TEAMLINK" full>
              <select value={lim.autoPostAllowed ? 'yes' : 'no'} onChange={(e) => setLim({ ...lim, autoPostAllowed: e.target.value === 'yes' })}><option value="no">Off: post by hand</option><option value="yes">On: the team can post with a click, and a picture can post itself after the client approves it</option></select>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>A picture can be set to post on the client's connected accounts by itself after the client approves it. It posts only if this switch is On, the client ticked their own permission (naming the accounts and the words) and the picture is the version they approved. Accounts are connected the official way (Administration &gt; Integrations &gt; Social Media): TeamLink never stores a username or password.</div>
            </Field>
            <Field label="OUR FACEBOOK LOGIN THAT CLIENTS ADD TO THEIR PAGE (NAME OR EMAIL)" full><input value={lim.accessLogin} maxLength={120} placeholder="For example: TeamLink Digital" onChange={(e) => setLim({ ...lim, accessLogin: e.target.value })} /></Field>
            <Field label="OUR META BUSINESS ID (OPTIONAL)" full><input value={lim.accessBusinessId} maxLength={30} inputMode="numeric" placeholder="Numbers only" onChange={(e) => setLim({ ...lim, accessBusinessId: e.target.value })} /></Field>
          </div>
        </Panel>
      )}
      <div className="mk-two" style={{ marginTop: 14, gridTemplateColumns: d.scope === 'all' ? undefined : '1fr' }}>
        <Panel title="By task this month">
          {s.byModule.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No AI requests yet this month.</div> : (
            <table className="mk-table"><thead><tr><th>MODULE</th><th>TASK</th><th className="num">REQUESTS</th></tr></thead><tbody>{s.byModule.map((r) => <tr key={`${r.module}${r.task}`}><td>{r.module === 'content' ? 'AI Content' : r.module === 'messaging' ? 'Campaign messages' : r.module === 'email' ? 'Email marketing' : r.module === 'journeys' ? 'Journeys' : r.module}</td><td>{TASK[r.task] || r.task}</td><td className="num">{fmtNum(r.calls)}</td></tr>)}</tbody></table>
          )}
        </Panel>
        {d.scope === 'all' && (
          <Panel title="By person this month">
            {s.byPerson.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>Nobody yet.</div> : (
              <table className="mk-table"><thead><tr><th>PERSON</th><th className="num">REQUESTS</th></tr></thead><tbody>{s.byPerson.map((r) => <tr key={r.userId || r.name}><td>{r.name}</td><td className="num">{fmtNum(r.calls)}</td></tr>)}</tbody></table>
            )}
          </Panel>
        )}
      </div>
      <Panel title="Recent requests" style={{ marginTop: 14 }}>
        {d.recent.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No requests yet.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mk-table"><thead><tr><th>WHEN</th><th>WHO</th><th>TASK</th><th>AI</th><th className="num">SIZE</th><th className="num">TIME</th><th>RESULT</th></tr></thead>
              <tbody>{d.recent.map((r) => (
                <tr key={r.id}><td>{fmtDateTime(r.at)}</td><td>{r.userName}</td><td>{TASK[r.task] || r.task}</td><td>{r.provider === 'demo' ? 'Sample writer' : `${r.provider}${r.model ? ` · ${r.model}` : ''}`}</td><td className="num">{fmtNum(r.chars)}</td><td className="num">{r.ms} ms</td><td>{r.ok ? <Pill tone="live" dot>Worked</Pill> : <span title={r.error}><Pill tone="red" dot>Failed</Pill> <small>{r.error}</small></span>}</td></tr>
              ))}</tbody></table>
          </div>
        )}
      </Panel>
    </div>
  );
}
