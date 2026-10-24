import { useState } from 'react';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Planned } from '../ui.jsx';
import ConnectionCard from '../external/ConnectionCard.jsx';
import { Metric, Metrics, SimpleTable, LoadError } from '../external/parts.jsx';
import { useConnection } from '../external/useExternal.js';

// Google Analytics (prototype page ganalytics). Connect a GA4 property with a service account (Admin); the read-only check returns the property name.
// Sessions, bounce rate, goals, traffic sources and landing pages stay "Not synced yet". UTM tags on campaign links are planned.
export default function GoogleAnalyticsPage() {
  const { dept } = useOmni();
  const { conn, canConnect, setConn, error } = useConnection('google-analytics');
  const [open, setOpen] = useState(false);
  const ok = conn && conn.status === 'connected';
  const info = (ok && conn.info) || {};
  const pid = conn && conn.values && conn.values.propertyId;
  const meta = ok ? 'Not synced yet' : 'Connect to view';
  return (
    <div>
      <PageHead eyebrow="Ads & campaigns" title="Google Analytics" lead="Connect your Google Analytics property to trace website conversions back to campaign traffic.">
        {canConnect && <Btn primary onClick={() => setOpen(true)}>🔗 {conn && conn.status !== 'not_connected' ? 'Change Analytics keys' : 'Connect Google Analytics'}</Btn>}
      </PageHead>
      <LoadError error={error} />
      <ConnectionCard conn={conn} canConnect={canConnect} onChanged={setConn} open={open} setOpen={setOpen} connectLabel="Connect Google Analytics" sub={ok ? (info.propertyName || 'GA4 property') : (dept ? `${dept} workspace` : 'All departments')}
        lead="Once connected, campaign links sent through WhatsApp, SMS, Email and social will carry UTM parameters, and session / conversion data will appear here beside your campaign metrics. Today TeamLink only checks the connection and reads the property name."
        info={[['Property', info.propertyName], ['Time zone', info.timeZone], ['Currency', info.currency]]}>
        <Planned>Adding UTM tags to campaign links automatically is planned. Links are not changed yet.</Planned>
      </ConnectionCard>
      <Metrics>
        <Metric label="Sessions from campaigns" value="—" meta={meta} dim={!ok} />
        <Metric label="Bounce rate" value="—" meta={meta} dim={!ok} />
        <Metric label="Goal completions" value="—" meta={meta} dim={!ok} />
      </Metrics>
      <Panel title="Traffic by source" sub={ok ? `Property ${pid || ''}. Traffic is not synced yet.` : 'Connect a property to trace real conversions.'} style={{ marginTop: 16 }}>
        <SimpleTable columns={['Source', 'Sessions', 'Conversion rate']} rows={[]} empty={ok ? 'Traffic is not synced yet. Syncing is planned.' : 'Connect Google Analytics to see traffic by source.'} />
      </Panel>
      <Panel title="Top landing pages" sub="Where campaign traffic arrives." style={{ marginTop: 16 }}>
        <SimpleTable columns={['Page', 'Sessions', 'Avg. time']} rows={[]} empty={ok ? 'Landing pages are not synced yet. Syncing is planned.' : 'Connect Google Analytics to see your landing pages.'} />
      </Panel>
    </div>
  );
}
