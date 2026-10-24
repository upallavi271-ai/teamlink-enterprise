import { useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Panel, Btn, GsModal, Banner } from '../ui.jsx';
import { useLoad, SwitchRow, Err } from './adminUtil.jsx';

// The REAL feature switches, in plain words. Test mode and the sending master are the existing outreach settings (the "I understand" tick stays);
// the others are the policy switches and the bots switch the bot builder reads (AppSetting omni.bots {enabled}).
export default function SuperSwitches({ toast, compact, only, title, sub }) {
  const show = (k) => !only || only.includes(k);
  const { data, err, reload } = useLoad(() => omni.get('/gs/admin/switches'), []);
  const [problem, setProblem] = useState('');
  const [live, setLive] = useState(null); // asking to switch Test mode OFF
  const [tick, setTick] = useState(false);
  const [master, setMaster] = useState(false); // asking to switch the sending master ON
  const put = async (path, body, done) => {
    setProblem('');
    try { if (path === 'settings') await omni.put('/settings', body); else await omni.put('/gs/admin/switches', body); toast(done); setLive(null); setMaster(false); setTick(false); reload(); } catch (e) { setProblem(errOf(e, 'It could not be saved.')); }
  };
  if (err) return <Err text={err} />;
  if (!data) return <div className="card panel">Loading…</div>;
  return (
    <Panel title={title || "Feature switches"} sub={sub || "Deployment-wide. Every switch is a real setting the sending engine reads. Only an Admin can change them."}>
      <Err text={problem} />
      {show("testMode") && <SwitchRow label="Test mode" on={data.testMode} note={data.testMode ? 'ON: campaigns are only rehearsed. Nothing is sent to real people. This is the safe way to try things.' : 'OFF: real people get real messages.'}
        onChange={(v) => { if (v) put('settings', { emailTestMode: true }, 'Test mode is ON. Nothing is sent.'); else { setLive(true); setTick(false); } }} />}
      {show('master') && <SwitchRow label="Sending master switch" on={data.master} note="OFF: nothing is sent at all, not even a rehearsal. ON: campaigns may run (Test mode above still decides whether it is real)."
        onChange={(v) => { if (v) setMaster(true); else put('settings', { master: false }, 'Sending is OFF.'); }} />}
      {show('approvalRequired') && <SwitchRow label="Campaign approval" on={data.approvalRequired} note="ON: a campaign made by a BDE waits for a Team Lead, BDE TL or Admin to approve it before it can be sent."
        onChange={(v) => put('switches', { approvalRequired: v }, v ? 'Campaign approval is ON.' : 'Campaign approval is OFF.')} />}
      {show('atsAppliedMeansJobAllowed') && <SwitchRow label="Applied to our requirement = promotion messages allowed" on={data.atsAppliedMeansJobAllowed} note="ON: a person copied from the ATS who applied to OUR requirement may get promotion messages even though no yes was recorded. Opt-outs still win. Default OFF."
        onChange={(v) => put('switches', { atsAppliedMeansJobAllowed: v }, v ? 'The rule is ON.' : 'The rule is OFF.')} />}
      {show('botsEnabled') && <SwitchRow label="Bot auto-replies" on={data.botsEnabled} note="ON: the WhatsApp bots you built may answer people by themselves. OFF: every reply is written by a person."
        onChange={(v) => put('switches', { botsEnabled: v }, v ? 'Bot auto-replies are ON.' : 'Bot auto-replies are OFF.')} />}
      {!compact && !only &&<div className="adm-note">Not here: Internal HR may send, day limits and quiet hours are under Settings &gt; Channels &amp; sending.</div>}
      {live && (
        <GsModal title="Switch Test mode OFF?" width={460} onClose={() => setLive(null)} foot={<><Btn onClick={() => setLive(null)}>Cancel</Btn><Btn danger disabled={!tick} onClick={() => put('settings', { emailTestMode: false, confirmLive: true }, 'Test mode is OFF. Real sending is allowed.')}>Switch Test mode OFF</Btn></>}>
          <Banner tone="warn">After this, a campaign that is sent for real reaches real people on Email, WhatsApp and SMS.</Banner>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginTop: 10 }}><input type="checkbox" checked={tick} onChange={(e) => setTick(e.target.checked)} /> I understand real people will get messages</label>
        </GsModal>
      )}
      {master && (
        <GsModal title="Switch sending ON?" width={440} onClose={() => setMaster(false)} foot={<><Btn onClick={() => setMaster(false)}>Cancel</Btn><Btn primary onClick={() => put('settings', { master: true }, 'Sending is ON.')}>Switch sending ON</Btn></>}>
          <p style={{ fontSize: 12, lineHeight: 1.7, margin: 0 }}>Campaigns will be allowed to run. While <b>Test mode</b> is ON they are only rehearsed and nobody receives anything.</p>
        </GsModal>
      )}
    </Panel>
  );
}
