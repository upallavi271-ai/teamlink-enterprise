import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOmni } from '../omniContext.js';
import omni, { errOf } from '../omniApi.js';
import { PageHead, Panel, Btn, Banner, Pill, Planned, GsModal, Field, DataTable, fmtDateTime } from '../ui.jsx';
import Combo from '../../Combo.jsx';
import ConsolePreview from '../console/ConsolePreview.jsx';
import CrmSelector from '../console/CrmSelector.jsx';
import RunModal from '../console/RunModal.jsx';
import { CHANNELS, chOf, download } from '../console/consoleKit.js';
import '../console/console.css';

// ---------------------------------------------------------------------------
// COMMUNICATION CONSOLE (Green Start "Direct send"): send one message to a list of people on ONE way without building a campaign.
// All the rules are on the server (backend/src/outreach/consoleSend.js): only people who agreed, Test mode = rehearsal, credits, quiet hours,
// daily limits, STOP line, new CSV people only through the import's permission tick. This page asks and shows.
// ---------------------------------------------------------------------------
const titleCase = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const istToday = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const istSoon = () => new Date(Date.now() + 5.5 * 3600000 + 30 * 60000).toISOString().slice(11, 16);

export default function ConsolePage() {
  const { go, toast, dept } = useOmni();
  const [opts, setOpts] = useState(null);
  const [err, setErr] = useState('');
  const [channel, setChannel] = useState('whatsapp');
  const [accBy, setAccBy] = useState({});
  const [tplBy, setTplBy] = useState({});
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [rec, setRec] = useState(null);
  const [pv, setPv] = useState(null);
  const [pvBusy, setPvBusy] = useState(false);
  const [permission, setPermission] = useState(false);
  const [basis, setBasis] = useState('');
  const [kind, setKind] = useState('');
  const [showList, setShowList] = useState(false);
  const [crmOpen, setCrmOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [runId, setRunId] = useState(null);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const loadRuns = useCallback(() => { omni.get('/gs/console/runs').then((d) => setRuns(d.runs || [])).catch(() => {}); }, []);
  useEffect(() => {
    omni.get('/gs/console/options').then((o) => { setOpts(o); setKind(o.defaultType); }).catch((e) => setErr(errOf(e, 'The Communication Console could not be opened.')));
    loadRuns();
  }, [dept, loadRuns]);

  const ch = chOf(channel);
  const accounts = (opts && opts.accounts[channel]) || [];
  const acc = accounts.find((a) => a.id === accBy[channel]) || null;
  const templates = (opts && opts.templates[channel]) || [];
  const tpl = templates.find((t) => t.key === tplBy[channel]) || null;
  // the SAME template for every number: is it approved in the WhatsApp account of the number chosen above? (a template has byNumber only when there are several accounts)
  const here = (t) => (t && acc && t.byNumber ? t.byNumber[acc.id] || null : null);
  const hereBad = channel === 'whatsapp' && tpl && tpl.approved ? here(tpl) : null;
  const hereWhy = hereBad && !hereBad.ok ? String(hereBad.reason || '').split(' An Admin can fix this:')[0] : '';
  const [fixBusy, setFixBusy] = useState(false);
  const fixIt = async () => {
    setFixBusy(true);
    try { await omni.post(`/gs/templates/outreach/${String(tpl.key).split(':')[1]}/submit-all`); toast("Sent to Meta for every number's WhatsApp account. Meta usually answers within minutes to a day."); setOpts(await omni.get('/gs/console/options')); } catch (e) { toast(errOf(e, 'It could not be sent to Meta.')); } finally { setFixBusy(false); }
  };
  const approved = templates.filter((t) => t.approved);
  const blocked = templates.filter((t) => !t.approved);
  const fixedWords = channel === 'whatsapp' || channel === 'sms';
  const wordsNow = fixedWords ? (tpl ? tpl.body : '') : body;
  const subjectNow = channel === 'email' ? (subject || (tpl && tpl.subject) || name) : '';

  // the list of people: ask the server what would happen (nothing is saved or sent)
  const recKey = rec ? `${rec.source}:${rec.source === 'crm' ? rec.ids.join(',') : rec.uploadId}` : '';
  useEffect(() => {
    if (!rec || ch.planned) { setPv(null); return undefined; }
    let live = true;
    setPvBusy(true);
    const t = setTimeout(() => {
      omni.post('/gs/console/preview', { channel, source: rec.source, contactIds: rec.ids, uploadId: rec.uploadId, body: wordsNow, contactType: kind })
        .then((d) => { if (live) { setPv(d); setPvBusy(false); } })
        .catch((e) => { if (live) { setPv({ error: errOf(e, 'The list could not be checked.') }); setPvBusy(false); } });
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [recKey, channel, wordsNow, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickTemplate = (key) => {
    setTplBy((s) => ({ ...s, [channel]: key }));
    const t = templates.find((x) => x.key === key);
    if (t) { setBody(t.body); setSubject(t.subject || ''); if (!name.trim()) setName(titleCase(t.name.replace(/^ZZTEST\s*/i, ''))); }
  };
  const pickAccount = (id) => { setAccBy((s) => ({ ...s, [channel]: id })); setTplBy((s) => ({ ...s, [channel]: '' })); };
  const changeChannel = (k) => { setChannel(k); setPv(null); setShowList(false); };

  const uploadFile = async (file) => {
    if (!file) return;
    try {
      const d = await omni.post(`/gs/console/csv?filename=${encodeURIComponent(file.name)}`, file, { headers: { 'Content-Type': 'application/octet-stream' } });
      setRec({ source: 'csv', uploadId: d.uploadId, label: `${d.rows} contact${d.rows === 1 ? '' : 's'} from ${d.fileName}`, fileName: d.fileName });
      setPermission(false);
      toast(`${d.rows} rows loaded from ${d.fileName}`);
    } catch (e) { toast(errOf(e, `Could not read ${file.name}`)); }
    if (fileRef.current) fileRef.current.value = '';
  };
  const sample = async () => {
    try { download(await omni.blob('/gs/console/sample', { channel }), `sample-${channel}.csv`); toast('Sample file downloaded'); } catch (e) { toast(errOf(e, 'The sample could not be downloaded.')); }
  };

  // the same order as the prototype
  const validate = () => {
    if (ch.planned) return `${ch.label} sending is planned. Nothing is sent from here yet.`;
    if (!acc) return `Select a ${ch.label} account first`;
    if (channel === 'whatsapp' && !tpl) return 'Select an approved WhatsApp template';
    if (tpl && !tpl.approved) return `"${tpl.name}" is ${tpl.statusWords}: Meta must approve it before you can send`;
    if (hereWhy) return hereWhy;
    if (channel === 'sms' && !tpl) return 'Select an SMS template';
    if (name.trim().length < 2) return 'Give the campaign a name';
    if (!rec) return 'Pick recipients from CRM or upload a CSV';
    if (!String(wordsNow).trim()) return 'Write the message.';
    return '';
  };
  const payload = (extra) => ({
    channel, accountId: acc && acc.id, name: name.trim(), templateKey: tpl ? tpl.key : undefined, body: wordsNow, subject: channel === 'email' ? subjectNow : undefined,
    source: rec && rec.source, contactIds: rec && rec.ids, uploadId: rec && rec.uploadId, permission: permission && pv && pv.needsPermission ? true : undefined, basis: permission ? basis : undefined, contactType: kind, dept, ...extra,
  });
  const afterSend = (d) => {
    if (d.scheduledAt) { toast(`${ch.label} send scheduled for ${new Date(d.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`); setRunId(d.id); } else setRunId(d.id);
    if (rec && rec.source === 'csv') { setRec(null); setPv(null); setPermission(false); setBasis(''); }
    loadRuns();
  };
  const sendNow = async () => {
    const e = validate(); if (e) { toast(e); return; }
    setBusy(true);
    try { afterSend(await omni.post('/gs/console/send', payload())); } catch (x) { toast(errOf(x, 'It could not be sent.')); } finally { setBusy(false); }
  };
  const schedule = async (date, time) => {
    const e = validate(); if (e) { toast(e); setSchedOpen(false); return; }
    setBusy(true);
    try { const d = await omni.post('/gs/console/send', payload({ scheduledAt: `${date}T${time}` })); setSchedOpen(false); afterSend(d); } catch (x) { toast(errOf(x, 'It could not be scheduled.')); } finally { setBusy(false); }
  };

  const totals = pv && pv.totals;
  const unusable = totals ? totals.invalid + totals.no_address : 0;
  const leftOut = totals ? totals.total - totals.ready : 0;

  if (err) return <div><PageHead eyebrow="Direct send" title="Communication Console" lead="Send targeted channel communications without building a full campaign." /><Banner tone="error">{err}</Banner></div>;
  if (!opts) return <div><PageHead eyebrow="Direct send" title="Communication Console" lead="Send targeted channel communications without building a full campaign." /><div className="card panel">Loading…</div></div>;

  const runsCols = [
    { id: 'name', label: 'Send', render: (r) => <b style={{ overflowWrap: 'anywhere' }}>{r.name}</b>, search: (r) => r.name },
    { id: 'way', label: 'Way', render: (r) => r.channelWord, search: (r) => r.channelWord },
    { id: 'n', label: 'People', render: (r) => `${r.total}${r.skipped ? ` (${r.skipped} left out)` : ''}`, sort: (r) => r.total },
    { id: 'mode', label: 'Kind', render: (r) => <Pill tone={r.rehearsal ? 'warn' : 'live'}>{r.rehearsal ? 'Rehearsal' : 'Real'}</Pill> },
    { id: 'status', label: 'Status', render: (r) => <Pill tone={r.status === 'done' ? 'warn' : (r.status === 'stopped' ? 'draft' : 'live')} dot>{r.statusWords}</Pill> },
    { id: 'when', label: 'Started', render: (r) => fmtDateTime(r.scheduledAt || r.startedAt || r.createdAt), sort: (r) => r.createdAt },
    { id: 'by', label: 'By', render: (r) => r.createdByName, hide: true },
  ];

  return (
    <div>
      <PageHead eyebrow="Direct send" title="Communication Console" lead="Send targeted channel communications without building a full campaign." />
      {opts.rehearsal
        ? <Banner tone="test"><b>Test mode.</b> {opts.testWords} Switching it off is for an Admin, in Settings.</Banner>
        : <Banner tone="warn"><b>Test mode is OFF.</b> {opts.testWords}</Banner>}
      {!opts.canSend && <Banner tone="warn">{opts.canSendWhy}</Banner>}
      <div className="grid console-grid">
        <div className="card panel">
          <div className="console-tabs">
            {CHANNELS.map((c) => (
              <button type="button" key={c.key} className="console-tab" style={c.key === channel ? { color: c.color, borderColor: c.color, background: '#fff' } : undefined} onClick={() => changeChannel(c.key)}>
                {c.icon} {c.label}{c.planned ? <span style={{ fontSize: 7.5, opacity: 0.7, fontWeight: 700 }}> · Planned</span> : null}
              </button>
            ))}
          </div>
          {ch.planned ? (
            <div>
              <Planned>{ch.label} sending from the console is planned. Nothing is sent and nothing is faked.</Planned>
              {ch.page && <p style={{ fontSize: 11 }}>Your {ch.label} page and its connection steps are here: <button type="button" className="con-link" onClick={() => go(ch.page)}>Open {ch.label} →</button></p>}
            </div>
          ) : (
            <>
              <label className="console-label">Select {ch.label.toLowerCase()} account</label>
              {accounts.length ? (
                <div className="account-cards" style={{ gridTemplateColumns: `repeat(${Math.min(accounts.length, 3)},1fr)` }}>
                  {accounts.map((a) => {
                    const on = acc && acc.id === a.id;
                    return (
                      <button type="button" key={a.id} className="account-card" style={on ? { borderColor: ch.color, background: ch.soft } : undefined} onClick={() => pickAccount(a.id)} aria-pressed={on}>
                        <span className="acc-icon" style={on ? { background: '#fff', color: ch.color } : undefined}>{ch.icon}</span>
                        <b style={{ overflowWrap: 'anywhere' }}>{a.name}</b>
                        <small style={{ overflowWrap: 'anywhere' }}>{a.sub}</small>
                        {a.sub2 && <small className={a.connected ? '' : 'con-acc-bad'} style={{ overflowWrap: 'anywhere' }}>{a.sub2}</small>}
                      </button>
                    );
                  })}
                </div>
              ) : <div className="no-account-box">No {ch.label.toLowerCase()} accounts connected.</div>}
              {!accounts.length && channel !== 'call' && <p className="con-ps">Connect it in Settings (Admin): {channel === 'sms' ? 'Sender details' : (channel === 'email' ? 'Sender details' : 'Integrations')}. Until then nothing can be sent on this way.</p>}

              <div className="field" style={{ marginTop: 14 }}>
                <label>CAMPAIGN NAME</label>
                <input placeholder="e.g., Diwali Sale" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              </div>
              <div className="field" style={{ marginTop: 14 }}>
                <label>SELECT {ch.label.toUpperCase()} TEMPLATE{channel === 'email' || channel === 'call' ? ' (OPTIONAL)' : ''}</label>
                <Combo value={tpl ? tpl.key : ''} onChange={(e) => pickTemplate(e.target.value)} disabled={!acc} placeholder={acc ? 'Select a template (type to search)' : 'Select account first'}>
                  <option value="">{acc ? 'Select a template' : 'Select account first'}</option>
                  {approved.map((t) => <option key={t.key} value={t.key}>{t.name}{t.group ? ` · ${t.group}` : ''}{here(t) && !here(t).ok ? ' — not ready for this number yet' : ''}</option>)}
                  {blocked.map((t) => <option key={t.key} value={t.key} disabled>{t.name} — {t.statusWords}, cannot send</option>)}
                </Combo>
                {acc && channel === 'whatsapp' && (
                  !templates.length ? <div className="mp-gate">This account has no templates yet. <button type="button" className="mp-gate-link" onClick={() => go('templates')}>Create one in Manage Templates →</button></div>
                    : !approved.length ? <div className="mp-gate">{blocked.length} template{blocked.length === 1 ? '' : 's'} still waiting for Meta: nothing can be sent from this account yet. <button type="button" className="mp-gate-link" onClick={() => go('templates')}>Open Manage Templates →</button></div>
                      : blocked.length ? <div className="mp-gate">{blocked.length} template{blocked.length === 1 ? ' is' : 's are'} hidden from sending until Meta approves {blocked.length === 1 ? 'it' : 'them'}. <button type="button" className="mp-gate-link" onClick={() => go('templates')}>Review →</button></div>
                        : <div className="mp-gate ok">{approved.length} approved template{approved.length === 1 ? '' : 's'} available. <button type="button" className="mp-gate-link" onClick={() => go('templates')}>＋ New template</button></div>
                )}
                {hereWhy ? (
                  <div className="mp-gate" role="alert">{hereWhy}{' '}
                    {opts && opts.isAdmin ? <button type="button" className="mp-gate-link" disabled={fixBusy} onClick={fixIt}>{fixBusy ? 'Sending…' : "Send it to every number's WhatsApp account →"}</button> : <b>Ask an Admin to send it to every number&apos;s WhatsApp account.</b>}
                  </div>
                ) : null}
                {acc && channel !== 'whatsapp' && (
                  <div className="mp-gate ok">{templates.length ? `${templates.length} template${templates.length === 1 ? '' : 's'} available.` : 'No templates yet: you can write your own words below.'} <button type="button" className="mp-gate-link" onClick={() => go('templates')}>Open Manage Templates →</button></div>
                )}
              </div>
              {channel === 'email' && (
                <div className="field" style={{ marginTop: 14 }}>
                  <label>SUBJECT</label>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={(tpl && tpl.subject) || 'e.g., A new opening for you'} maxLength={200} />
                </div>
              )}
              <div className="field" style={{ marginTop: 14 }}>
                <label>MESSAGE — {fixedWords ? 'the approved words of the template' : 'write your own for the occasion'}</label>
                <textarea
                  style={{ minHeight: 90 }} className={fixedWords ? 'con-readonly' : ''} readOnly={fixedWords}
                  placeholder={fixedWords ? 'Pick a template: its approved words appear here.' : 'e.g., Diwali greetings + festive offer copy... Use {{name}} for the person\'s name.'}
                  value={fixedWords ? (tpl ? tpl.body : '') : body} onChange={(e) => setBody(e.target.value)} maxLength={8000}
                />
                {fixedWords && <small style={{ fontSize: 9, color: 'var(--muted)' }}>{ch.label} sends the approved wording exactly. To change the words, change the template in Manage Templates. A "Reply STOP to stop" line is added for you.</small>}
              </div>

              <div style={{ marginTop: 16 }}>
                <label className="console-label">Recipients source</label>
                <button type="button" className="crm-tile" onClick={() => setCrmOpen(true)}>
                  <span className="crm-icon">👥</span>
                  <span><span style={{ display: 'block', fontSize: 10, fontWeight: 800, color: ch.color }}>Select from CRM</span><span style={{ display: 'block', fontSize: 9, color: 'var(--muted)' }}>{rec && rec.source === 'crm' ? rec.label : 'Pick contacts directly from your database'}</span></span>
                </button>
                <div className="or-divider"><span className="line" />OR<span className="line" /></div>
                <label className="console-label">Recipients (CSV)</label>
                <input ref={fileRef} type="file" accept=".csv,.tsv,.xlsx,.xls,text/csv" style={{ display: 'none' }} onChange={(e) => uploadFile(e.target.files && e.target.files[0])} />
                <button type="button" className="csv-drop" onClick={() => fileRef.current && fileRef.current.click()}>
                  <span style={{ fontSize: 18 }}>⬆</span>
                  <span style={{ fontSize: 10, fontWeight: 800, color: ch.color }}>{rec && rec.source === 'csv' ? rec.label : 'Upload CSV file'}</span>
                  <span style={{ fontSize: 9, color: 'var(--muted)' }}>Needs a mobile or email column; other columns fill {'{{1}}'}, {'{{2}}'}…</span>
                </button>
                {rec && (
                  <div className="rcp-summary">
                    {pvBusy && !totals ? <span>Checking the list…</span> : totals ? (
                      <>
                        <b>{totals.ready}</b> ready to send
                        {totals.duplicate > 0 && <span>· {totals.duplicate} duplicate{totals.duplicate === 1 ? '' : 's'} removed</span>}
                        {unusable > 0 && <span className="rcp-bad">· {unusable} unusable row{unusable === 1 ? '' : 's'}</span>}
                        {leftOut - totals.duplicate - unusable > 0 && <span className="rcp-bad">· {leftOut - totals.duplicate - unusable} left out (not agreed, stopped, not yours{totals.new ? ', or new' : ''})</span>}
                      </>
                    ) : <span>{pv && pv.error ? pv.error : ''}</span>}
                    <button type="button" className="rcp-clear" onClick={() => { setRec(null); setPv(null); setPermission(false); }}>Clear</button>
                  </div>
                )}
                {totals && totals.total > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <button type="button" className="con-link" onClick={() => setShowList(!showList)}>{showList ? 'Hide the list' : 'See who is ready and who is left out'}</button>
                    {showList && (
                      <div className="table-scroll">
                        <table className="con-rows">
                          <thead><tr><th>Name</th><th>To</th><th>Result</th></tr></thead>
                          <tbody>{pv.rows.map((r) => <tr key={`${r.ref}-${r.name}`}><td>{r.name || '—'}</td><td>{r.to || '—'}</td><td>{r.statusWords}{r.why ? <small style={{ display: 'block', color: 'var(--muted)' }}>{r.why}{r.missing && r.missing.length ? ` Missing: ${r.missing.join(', ')}` : ''}</small> : (r.missing && r.missing.length ? <small style={{ display: 'block', color: '#c25058' }}>Missing: {r.missing.join(', ')}</small> : null)}</td></tr>)}</tbody>
                        </table>
                        {totals.total > pv.rows.length && <p className="con-ps">Showing the first {pv.rows.length} of {totals.total}.</p>}
                      </div>
                    )}
                  </div>
                )}
                {totals && totals.new > 0 && (
                  pv.mayAddNew ? (
                    <div className="con-perm">
                      <b>{totals.new} {totals.new === 1 ? 'person is' : 'people are'} not in your Contacts yet.</b> To message them they must be added first, with the same rules as an import:
                      <label style={{ marginTop: 8 }}><input type="checkbox" checked={permission} onChange={(e) => setPermission(e.target.checked)} /> I have permission to message these people</label>
                      {permission && <input type="text" aria-label="Where do these people come from" placeholder="Where do they come from? e.g. our own past candidates who gave their number" value={basis} onChange={(e) => setBasis(e.target.value)} maxLength={400} />}
                      <div className="con-ps">This is written in the consent log with your name, the file and these words. Without the tick they are simply left out.</div>
                    </div>
                  ) : <div className="con-perm">{totals.new} {totals.new === 1 ? 'person is' : 'people are'} not in Contacts yet. Your login cannot add people (the BDE team, Team Leads and Admins can), so they will be left out.</div>
                )}
              </div>
              <div className="console-actions">
                <button type="button" style={{ background: ch.color, borderColor: ch.color, color: '#fff' }} disabled={busy || !opts.canSend} onClick={sendNow}>➤ {opts.rehearsal ? 'Rehearse now' : 'Send Now'}</button>
                <button type="button" style={{ background: '#fff', borderColor: ch.color, color: ch.color }} disabled={busy || !opts.canSend} onClick={() => { const e = validate(); if (e) toast(e); else setSchedOpen(true); }}>📅 Schedule</button>
              </div>
              {opts.rehearsal && <p className="con-ps">Test mode: "Rehearse now" writes every row down and counts it as a Test message. Nothing reaches anybody.</p>}
              {(opts.quiet || (opts.caps[channel] && opts.caps[channel].limit)) && (
                <p className="con-ps">
                  {opts.quiet}
                  {opts.caps[channel] ? ` Today's limit for ${ch.label}: ${opts.caps[channel].usedToday} of ${opts.caps[channel].limit} used.` : ''}
                  {opts.credits ? ` ${opts.credits.words}` : ''}
                </p>
              )}
            </>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="tips-box" style={{ background: ch.soft, borderColor: `${ch.color}40` }}>
            <div className="tips-head" style={{ color: ch.color }}>ⓘ Tips ({ch.label.toUpperCase()})</div>
            <ul>{ch.tips.map((t) => <li key={t}>{t}</li>)}</ul>
            <div className="tips-note"><b>mobile</b> and <b>email</b> headers are mandatory and must always be included to send sms/email and make sure the CSV headers are mapped exactly to those variable names</div>
            <button type="button" className="tips-download" style={{ borderColor: ch.color, color: ch.color }} onClick={sample}>⬇ Download Sample File</button>
          </div>
          <div className="card panel con-phone-wrap" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ConsolePreview channel={channel} account={acc} templateName={tpl ? tpl.name : ''} body={wordsNow} subject={subjectNow} campaignName={name} />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <Panel title="Recent sends" sub="Your direct sends from this page. Click one to see who got it.">
          <DataTable columns={runsCols} rows={runs} rowKey={(r) => r.id} onRow={(r) => setRunId(r.id)} empty="No sends yet." persistKey="console_runs" searchPlaceholder="Search sends…" defaultSort={{ id: 'when', dir: 'desc' }} />
        </Panel>
      </div>

      {crmOpen && (
        <CrmSelector
          channel={channel} word={ch.label} type={kind || opts.defaultType} types={opts.types} selected={rec && rec.source === 'crm' ? rec.ids : []} go={go} toast={toast}
          onClose={() => setCrmOpen(false)}
          onUse={(ids, k) => { setKind(k); setRec({ source: 'crm', ids, label: `${ids.length} contact${ids.length === 1 ? '' : 's'} from CRM` }); setPermission(false); setCrmOpen(false); toast(`${ids.length} contact${ids.length === 1 ? '' : 's'} selected from CRM`); }}
        />
      )}
      {schedOpen && <ScheduleModal onClose={() => setSchedOpen(false)} onGo={schedule} busy={busy} />}
      {runId && <RunModal runId={runId} go={go} toast={toast} onClose={() => { setRunId(null); loadRuns(); }} />}
    </div>
  );
}

function ScheduleModal({ onClose, onGo, busy }) {
  const [d, setD] = useState(istToday());
  const [t, setT] = useState(istSoon());
  const minDate = useMemo(() => istToday(), []);
  return (
    <GsModal title="Schedule send" sub="Pick a date and time to send this." width={420} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy} onClick={() => { if (!d || !t) return; onGo(d, t); }}>📅 Schedule send</Btn></>}>
      <Field label="DATE"><input type="date" min={minDate} value={d} onChange={(e) => setD(e.target.value)} /></Field>
      <div style={{ marginTop: 13 }}><Field label="TIME (IST)"><input type="time" value={t} onChange={(e) => setT(e.target.value)} /></Field></div>
      <p style={{ fontSize: 9, color: 'var(--muted)', margin: '10px 0 0' }}>All times are in India Standard Time (Asia/Kolkata). Quiet hours and the daily limit still apply when it starts.</p>
    </GsModal>
  );
}
