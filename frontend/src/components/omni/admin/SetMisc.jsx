import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import omni from '../omniApi.js';
import { Panel, Btn, Planned, Pill } from '../ui.jsx';
import { useOmni } from '../omniContext.js';
import { useLoad, Err } from './adminUtil.jsx';

// Settings > Account, Security, Notifications, API keys, Webhooks, Audit log. What exists is shown for real; what does not exist yet is marked Planned.

export function AccountTab() {
  const { user, acc } = useOmni();
  const navigate = useNavigate();
  return (
    <Panel title="Your profile" sub="Shown to your team and used as the sender name on internal notes.">
      <dl className="adm-kv">
        <dt>Full name</dt><dd>{(user && user.name) || '—'}</dd>
        <dt>Email</dt><dd>{(user && user.email) || '—'}</dd>
        <dt>Your level</dt><dd>{(acc && acc.levelWords) || '—'}</dd>
        <dt>Departments</dt><dd>{acc && acc.allDepartments ? 'All departments' : ((acc && acc.departments) || []).map((d) => d.replace(/^./, (c) => c.toUpperCase())).join(', ') || '—'}</dd>
      </dl>
      <div className="adm-note">Your name and email come from your TeamLink login, so they are the same in every part of TeamLink. Change them in your profile.</div>
      <Btn onClick={() => navigate('/admin/profile')}>Open my profile</Btn>
    </Panel>
  );
}

export function SecurityTab() {
  const navigate = useNavigate();
  return (
    <>
      <Panel title="Password" sub="One password for the whole of TeamLink.">
        <p style={{ fontSize: 12, lineHeight: 1.7, margin: '0 0 10px' }}>Your password is changed in your TeamLink profile (it also signs you out of other devices). Nothing about passwords is kept in Omni-Channel.</p>
        <Btn onClick={() => navigate('/admin/profile')}>Change password</Btn>
      </Panel>
      <Panel title="Two-factor sign-in and active sessions" sub="Extra protection for a login."><Planned>Two-factor sign-in and a list of the devices that are signed in are planned. Nothing here is faked.</Planned></Panel>
    </>
  );
}

export function NotificationsTab() {
  const navigate = useNavigate();
  return (
    <Panel title="Notifications" sub="Choose what reaches you, and how.">
      <Planned>Choosing, per person, which bell notices to get (campaign finished, a failed send, a template approved, credits running low) is planned. Today the bell shows the notices TeamLink already sends to everyone it concerns.</Planned>
      <div className="adm-note">The notices TeamLink sends are set up in Administration &gt; Notifications.</div>
      <Btn onClick={() => navigate('/admin/notifications')}>Open Administration &gt; Notifications</Btn>
    </Panel>
  );
}

export function ApiKeysTab() {
  return (
    <Panel title="API keys" sub="Server-side only. A key is shown once, when it is created.">
      <Planned>API keys to call Omni-Channel from your own systems are planned. No key exists, and none is shown. The delivery-report webhook (next tab) already exists.</Planned>
      <div className="adm-note">Never put a key in browser code. Requests are signed on the server.</div>
    </Panel>
  );
}

export function WebhooksTab({ toast }) {
  const meta = useLoad(() => omni.get('/config/meta'), []);
  const snd = useLoad(() => omni.get('/sending'), []);
  const [show, setShow] = useState(false);
  const wa = meta.data && meta.data.account;
  const hook = snd.data && snd.data.webhook;
  const origin = window.location.origin;
  return (
    <>
      <Err text={snd.err} />
      <Panel title="Delivery reports (email)" sub="Your mail provider posts here when an email is delivered, bounces or is marked as spam. The account is signed with a secret.">
        {hook ? (
          <>
            <dl className="adm-kv">
              <dt>Address</dt><dd className="mono-cell">{origin}{hook.path}</dd>
              <dt>Signing secret</dt><dd>{show ? <div className="adm-secret">{hook.secret}</div> : <span className="mono-cell">••••••••••••••••</span>} <Btn small onClick={() => { setShow(!show); }}>{show ? 'Hide the secret' : 'Show the secret'}</Btn></dd>
            </dl>
            <div className="adm-note">{hook.note}</div>
            <div className="adm-note">Keep the secret on your server only. It is read from the server settings; it cannot be changed here.</div>
          </>
        ) : <div className="adm-note">Loading…</div>}
      </Panel>
      <Panel title="WhatsApp replies and delivery (Meta)" sub="Meta calls this address when someone replies or a message is delivered.">
        {wa ? (
          <dl className="adm-kv">
            <dt>Address</dt><dd className="mono-cell">{wa.webhook.hasPublicAddress ? wa.webhook.url : `${origin}/api/webhooks/whatsapp`}</dd>
            <dt>Last call</dt><dd>{wa.webhook.lastCall ? new Date(wa.webhook.lastCall).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'None seen yet'} <Pill tone={wa.webhook.state === 'green' ? 'live' : (wa.webhook.state === 'yellow' ? 'warn' : 'draft')} dot>{wa.webhook.state === 'green' ? 'Delivering' : (wa.webhook.state === 'yellow' ? 'Waiting for Meta' : 'Not connected')}</Pill></dd>
            <dt>Set up in</dt><dd>{wa.where}</dd>
          </dl>
        ) : <div className="adm-note">{meta.err || 'Loading…'}</div>}
      </Panel>
      <Panel title="Webhooks to your own systems" sub="Send TeamLink events (message sent, delivered, replied) to a URL you choose."><Planned>Outgoing webhooks to your own address are planned. Nothing is sent anywhere today.</Planned></Panel>
    </>
  );
}

export function AuditTab() {
  const { go } = useOmni();
  return (
    <Panel title="Audit log" sub="Every consequential action: credits, switches, settings, consent, exports.">
      <p style={{ fontSize: 12, lineHeight: 1.7, margin: '0 0 10px' }}>The audit log lives in <b>Team &amp; Roles &gt; Audit log</b>: who did what and when, searchable, with a CSV for Admins. Phone numbers and emails are never shown there.</p>
      <Btn primary onClick={() => go('team', { tab: 'audit' })}>Open the audit log</Btn>
    </Panel>
  );
}

