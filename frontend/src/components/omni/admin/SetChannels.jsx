import { useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Panel, Btn, Pill, Field, Banner, fmtNum } from '../ui.jsx';
import { useLoad, Err, SwitchRow } from './adminUtil.jsx';
import SuperSwitches from './SuperSwitches.jsx';

const intOnly = (v) => v.replace(/\D/g, '');

// Settings > Channels & sending: Test mode, the sending master switch, day limits, speed per minute, quiet hours, the same-job rule, sender identities.
// Each block saves by itself. The rules are the existing outreach settings; WhatsApp and SMS limits are saved by the Administration route.
export default function SetChannels({ toast }) {
  const ch = useLoad(() => omni.get('/channels'), []);
  const sd = useLoad(() => omni.get('/sender-details'), []);
  const [f, setF] = useState(null);
  const [q, setQ] = useState(null);
  const [s, setS] = useState(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState('');
  useEffect(() => {
    if (!ch.data || !sd.data) return;
    const st = ch.data.settings;
    setF({ emailDailyCap: String(st.emailDailyCap), waDailyCap: String(st.waDailyCap), smsDailyCap: String(st.smsDailyCap), emailPerMinute: String(st.emailPerMinute), waPerMinute: String(st.waPerMinute), smsPerMinute: String(st.smsPerMinute), suppressDays: String(st.suppressDays) });
    setQ(sd.data.quietHours);
    const d = sd.data.details;
    setS({ fromName: d.fromName, replyTo: d.replyTo, fromEmail: d.fromEmail, whatsappNumber: d.whatsappShown || d.whatsappNumber });
  }, [ch.data, sd.data]);
  const run = async (key, fn, done) => { setBusy(key); setErr(''); try { await fn(); toast(done); ch.reload(); sd.reload(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } finally { setBusy(''); } };
  const saveLimits = () => run('limits', async () => {
    await omni.put('/settings', { emailDailyCap: Number(f.emailDailyCap || 0), emailPerMinute: Number(f.emailPerMinute || 1), suppressDays: Number(f.suppressDays || 0) });
    await omni.put('/gs/admin/settings/sending', { waDailyCap: Number(f.waDailyCap || 0), smsDailyCap: Number(f.smsDailyCap || 0), waPerMinute: Number(f.waPerMinute || 1), smsPerMinute: Number(f.smsPerMinute || 1) });
  }, 'Limits saved');
  const saveQuiet = (enabled) => run('quiet', () => omni.put('/settings', { quietHours: { start: q.start, end: q.end, applyInternal: q.applyInternal, enabled } }), enabled ? 'Quiet hours are ON' : 'Quiet hours are OFF');
  const saveSender = () => run('sender', () => omni.put('/settings', s), 'Sender details saved');
  const hr = ch.data ? ch.data.settings.internalHrMaySend : false;
  if (ch.err || sd.err) return <Err text={ch.err || sd.err} />;
  if (!f || !q || !s) return <div className="card panel">Loading…</div>;
  const email = ch.data.channels.find((c) => c.channel === 'email');
  return (
    <>
      <Err text={err} />
      <SuperSwitches toast={toast} only={['testMode', 'master']} title="Test mode and sending" sub="The two switches that decide whether anything can leave TeamLink." />
      <div className="adm-two">
        <Panel title="Daily limits and speed" sub="The most messages a day, and how fast they go out." right={<Btn primary onClick={saveLimits} disabled={busy === 'limits'}>{busy === 'limits' ? 'Saving…' : 'Save limits'}</Btn>}>
          <div className="adm-form">
            <Field label="EMAILS PER DAY"><input inputMode="numeric" value={f.emailDailyCap} onChange={(e) => setF({ ...f, emailDailyCap: intOnly(e.target.value) })} /></Field>
            <Field label="WHATSAPP PER DAY"><input inputMode="numeric" value={f.waDailyCap} onChange={(e) => setF({ ...f, waDailyCap: intOnly(e.target.value) })} /></Field>
            <Field label="SMS PER DAY"><input inputMode="numeric" value={f.smsDailyCap} onChange={(e) => setF({ ...f, smsDailyCap: intOnly(e.target.value) })} /></Field>
            <Field label="EMAILS PER MINUTE"><input inputMode="numeric" value={f.emailPerMinute} onChange={(e) => setF({ ...f, emailPerMinute: intOnly(e.target.value) })} /></Field>
            <Field label="WHATSAPP PER MINUTE"><input inputMode="numeric" value={f.waPerMinute} onChange={(e) => setF({ ...f, waPerMinute: intOnly(e.target.value) })} /></Field>
            <Field label="SMS PER MINUTE"><input inputMode="numeric" value={f.smsPerMinute} onChange={(e) => setF({ ...f, smsPerMinute: intOnly(e.target.value) })} /></Field>
            <Field label="SAME REQUIREMENT AGAIN AFTER (DAYS)" hint="Do not message the same person about the same requirement again within this many days."><input inputMode="numeric" value={f.suppressDays} onChange={(e) => setF({ ...f, suppressDays: intOnly(e.target.value) })} /></Field>
          </div>
          {email && <div className="adm-note">Email today: {fmtNum(email.sentToday)} of {fmtNum(email.dailyCap)} allowed.</div>}
        </Panel>
        <Panel title="Quiet hours" sub="Never send at night (India time). Promotion messages wait until quiet hours end, then go out by themselves."
          right={q.enabled ? <Pill tone="live" dot>ON</Pill> : <Pill tone="draft" dot>OFF</Pill>}>
          <div className="adm-form">
            <Field label="QUIET FROM"><input type="time" value={q.start} onChange={(e) => setQ({ ...q, start: e.target.value })} /></Field>
            <Field label="UNTIL"><input type="time" value={q.end} onChange={(e) => setQ({ ...q, end: e.target.value })} /></Field>
          </div>
          <SwitchRow label="Apply to messages to staff too" note="OFF: messages to staff may still go out at night." on={q.applyInternal} onChange={(v) => setQ({ ...q, applyInternal: v })} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn primary onClick={() => saveQuiet(true)} disabled={busy === 'quiet'}>{q.enabled ? 'Save times' : 'Turn quiet hours ON'}</Btn>
            {q.enabled && <Btn onClick={() => saveQuiet(false)} disabled={busy === 'quiet'}>Turn quiet hours OFF</Btn>}
          </div>
          <div className="adm-note">{sd.data.quietWords}</div>
        </Panel>
      </div>
      <Panel title="Sender identities" sub="What people see as the sender." right={<Btn primary onClick={saveSender} disabled={busy === 'sender'}>{busy === 'sender' ? 'Saving…' : 'Save sender details'}</Btn>}>
        <div className="adm-form">
          <Field label="SENDER NAME"><input maxLength={80} value={s.fromName} onChange={(e) => setS({ ...s, fromName: e.target.value })} placeholder="TeamLink Jobs" /></Field>
          <Field label="EMAIL FROM ADDRESS"><input maxLength={160} value={s.fromEmail} onChange={(e) => setS({ ...s, fromEmail: e.target.value })} placeholder="jobs@yourcompany.in" /></Field>
          <Field label="REPLIES GO TO"><input maxLength={160} value={s.replyTo} onChange={(e) => setS({ ...s, replyTo: e.target.value })} placeholder="jobs@yourcompany.in" /></Field>
          <Field label="WHATSAPP BUSINESS NUMBER" hint="Shown on previews. The mail server and the WhatsApp number themselves are connected in Administration > Integrations."><input maxLength={30} value={s.whatsappNumber} onChange={(e) => setS({ ...s, whatsappNumber: e.target.value })} placeholder="+91 98765 43210" /></Field>
        </div>
        <div className="adm-note">The SMS sender ID and the DLT number are under Compliance.</div>
      </Panel>
      <Panel title="Staff messages" sub="Messages to your own people.">
        <SwitchRow label="Internal HR may send" note="ON: the HR desk may send messages to staff. OFF: only an Admin may." on={hr} onChange={(v) => run('hr', () => omni.put('/settings', { internalHrMaySend: v }), v ? 'Internal HR may send' : 'Internal HR may not send')} />
      </Panel>
      {ch.data.settings.emailTestMode && <Banner tone="test">Test mode is ON: campaigns are only rehearsed, nobody receives anything.</Banner>}
    </>
  );
}
