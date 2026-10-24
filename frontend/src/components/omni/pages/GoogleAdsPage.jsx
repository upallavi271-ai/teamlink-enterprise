import { useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Planned } from '../ui.jsx';
import ConnectionCard from '../external/ConnectionCard.jsx';
import { Metric, Metrics, SimpleTable, FormModal, LoadError, inr } from '../external/parts.jsx';
import { useConnection } from '../external/useExternal.js';

// Google Ads (prototype page googleads). Connect the account (Admin); the read-only check signs in and lists the accounts the sign-in can open.
// The monthly budget is YOUR plan figure, saved here only (nothing is set at Google). Spend, CPC, quality score and keywords stay "Not synced yet".
export default function GoogleAdsPage() {
  const { toast } = useOmni();
  const { conn, canConnect, settings, setConn, setSettings, error } = useConnection('google-ads');
  const [editing, setEditing] = useState(false);
  const ok = conn && conn.status === 'connected';
  const info = (ok && conn.info) || {};
  const budget = settings && settings.googleBudget ? settings.googleBudget.amount : null;
  const meta = ok ? 'Not synced yet' : 'Connect to view';
  const save = async (v) => {
    try {
      const d = await omni.put('/gs/external/google-budget', { amount: v.amount });
      setSettings(d.settings); setEditing(false);
      toast(`Monthly budget plan set to ${inr(d.settings.googleBudget.amount)}`);
      return '';
    } catch (e) { return errOf(e, 'It could not be saved.'); }
  };
  return (
    <div>
      <PageHead eyebrow="Ads & campaigns" title="Google Ads" lead="Account-level overview, budget, and top-performing keywords.">
        <Btn onClick={() => setEditing(true)}>Manage Account</Btn>
      </PageHead>
      <LoadError error={error} />
      <ConnectionCard conn={conn} canConnect={canConnect} onChanged={setConn} connectLabel="Connect Google Ads" sub={ok ? `Customer ${info.customerId || ''}` : 'Your workspace'}
        info={[['Customer', info.customerId], ['Accounts this sign-in can open', info.accountsFound], ['This customer is in that list', info.customerListed === undefined ? '' : (info.customerListed ? 'Yes' : 'No: check the Customer ID')]]} />
      <Metrics>
        <Metric label="Monthly budget" value={budget ? inr(budget) : '—'} meta={budget ? 'Your plan. Spend is not synced yet.' : 'Not set yet'} dim={!budget} />
        <Metric label="Avg. CPC" value="—" meta={meta} dim={!ok} />
        <Metric label="Quality score" value="—" meta={meta} dim={!ok} />
      </Metrics>
      <Panel title="Top keywords" sub="By clicks, last 30 days" style={{ marginTop: 16 }}>
        <SimpleTable columns={['Keyword', 'Clicks', 'Avg. CPC', 'Conversions']} rows={[]} empty={ok ? 'Keywords are not synced yet. Syncing is planned.' : 'Connect Google Ads to see your top keywords.'} />
      </Panel>
      <Panel title="Monthly budget" sub={budget ? `${inr(budget)} planned for the month. Spend is not synced yet.` : 'No monthly budget planned yet.'} right={<Btn onClick={() => setEditing(true)}>Edit budget</Btn>} style={{ marginTop: 16 }}>
        <div className="bar" style={{ marginTop: 12 }}><span style={{ width: '0%' }} /></div>
        <p className="tpl-note" style={{ fontSize: 10, color: 'var(--muted)' }}>Budget used appears here once Google Ads spend is synced (planned).</p>
        <Planned>The budget is your plan figure, saved here only. TeamLink does not change anything in Google Ads.</Planned>
      </Panel>
      <Panel title="Top keywords" sub="Ranked by clicks over the last 30 days." style={{ marginTop: 16 }}>
        <SimpleTable columns={['Keyword', 'Clicks', 'Avg. CPC', 'Conversions', 'Quality score']} rows={[]} empty={ok ? 'Keywords are not synced yet. Syncing is planned.' : 'Connect Google Ads to see keywords.'} />
      </Panel>
      {editing && <FormModal title="Monthly budget" sub="Your plan figure. It is saved here only." okLabel="Save budget" onClose={() => setEditing(false)} onSubmit={save}
        fields={[{ id: 'amount', label: 'Amount in ₹', placeholder: '105000', inputMode: 'numeric' }]} initial={{ amount: budget ? String(budget) : '' }} />}
    </div>
  );
}
