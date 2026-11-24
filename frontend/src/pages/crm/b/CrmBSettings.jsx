// CRM > Dashboard > ⚙ Settings: "Email, phone, marketing and portal" (CRM wave B, 2026-11-24). The Admin switches of the new features (all OFF
// until the founder turns them on), the BCC / team mailbox addresses, the preference-centre topics, and the addresses / keys an Admin gives
// to the mail provider, Exotel, Facebook and Google.
import { useState } from 'react';
import api from '../../../api';
import { useCrm, errOf } from '../crmShared.jsx';
import { useLoad, CopyBox } from './bShared.jsx';

export default function CrmBSettings() {
  const { toast } = useCrm();
  const { data, reload } = useLoad('/crm/b/settings');
  const [f, setF] = useState(null);
  const [open, setOpen] = useState(false);
  if (!data) return null;
  const v = f || { bccAddress: data.bccAddress || '', teamMailbox: data.teamMailbox || '', topics: (data.topics || []).join(', ') };
  async function flip(k) {
    try { await api.put('/crm/b/settings', { switches: { [k]: !data.switches[k] } }); toast(`${data.switches[k] ? 'Switched off' : 'Switched on'}.`); reload(); } catch (e) { toast(errOf(e, 'Not changed.')); }
  }
  async function save() {
    try { await api.put('/crm/b/settings', { bccAddress: v.bccAddress, teamMailbox: v.teamMailbox, topics: String(v.topics).split(',').map((t) => t.trim()).filter(Boolean) }); toast('Saved.'); setF(null); reload(); } catch (e) { toast(errOf(e, 'Not saved.')); }
  }
  return (
    <div style={{ marginTop: 14 }}>
      <div className="section-label">Email, phone, marketing and portal</div>
      <div className="card" style={{ padding: 10 }}>
        {Object.entries(data.labels).map(([k, label]) => (
          <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <span style={{ flex: 1, fontSize: 13 }}>{label}</span>
            <span className={`status ${data.switches[k] ? 'joined' : 'review'}`}>{data.switches[k] ? 'On' : 'Off'}</span>
            {data.canSwitch && <button type="button" className="btn btn-sm" onClick={() => flip(k)}>{data.switches[k] ? 'Switch off' : 'Switch on'}</button>}
          </div>
        ))}
        {!data.canSwitch && <div className="small-muted" style={{ fontSize: 12, marginTop: 6 }}>Only an Admin switches these.</div>}
        {data.canEdit && (
          <>
            <div className="grid-2" style={{ marginTop: 10 }}>
              <div className="field"><label>CRM BCC address (team members BCC it to log a mail)</label><input type="email" value={v.bccAddress} onChange={(e) => setF({ ...v, bccAddress: e.target.value })} placeholder="crm@yourcompany.com (delivered to the shared inbox)" /></div>
              <div className="field"><label>Team mailbox (customer mail to it is a team inbox card)</label><input type="email" value={v.teamMailbox} onChange={(e) => setF({ ...v, teamMailbox: e.target.value })} placeholder="sales@yourcompany.com" /></div>
            </div>
            <div className="field"><label>Preference-centre topics (comma separated)</label><input value={v.topics} onChange={(e) => setF({ ...v, topics: e.target.value })} /></div>
            <button type="button" className="btn btn-sm btn-primary" onClick={save}>Save addresses and topics</button>
            <button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} the addresses for providers</button>
            {open && data.snippets && (
              <div style={{ marginTop: 8 }}>
                <CopyBox label="Mail provider inbound-parse (raw MIME POST) - logs BCC'd / forwarded mail" value={data.snippets.inboundMail} rows={1} />
                <CopyBox label="Mail provider bounce webhook (JSON: email, type, reason)" value={data.snippets.bounceHook} rows={1} />
                <CopyBox label="Exotel Connect applet > dynamic URL (incoming calls to the owner)" value={data.snippets.callRoute} rows={1} />
                <CopyBox label="Gmail OAuth redirect address (Google Cloud Console)" value={data.snippets.gmailRedirect} rows={1} />
                <CopyBox label="Outlook OAuth redirect address (Microsoft Entra)" value={data.snippets.outlookRedirect} rows={1} />
                <CopyBox label="Public help articles" value={data.snippets.kb} rows={1} />
                <div className="small-muted" style={{ fontSize: 12 }}>The key in these addresses is secret: a new one can be made by an Admin (the old addresses then stop).</div>
                {data.canSwitch && <button type="button" className="btn btn-sm" onClick={async () => { if (!window.confirm('Make a new key? The provider addresses must then be changed too.')) return; try { await api.put('/crm/b/settings', { newHookKey: true }); reload(); } catch (e) { toast(errOf(e, 'Not changed.')); } }}>New key</button>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
