import { useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Pill, Planned } from '../ui.jsx';
import ConnectionCard from '../external/ConnectionCard.jsx';
import { SimpleTable, FormModal, NotSynced, LoadError, inr } from '../external/parts.jsx';
import { useConnection, useItems } from '../external/useExternal.js';

// Google Campaigns (prototype page googlecampaigns). Same Google Ads connection as the Google Ads page. Clicks and impressions stay "Not synced yet".
// "New Campaign" writes a PLAN here only: nothing is created at Google, nothing is spent.
export default function GoogleCampaignsPage() {
  const { toast } = useOmni();
  const { conn, canConnect, setConn, error } = useConnection('google-ads');
  const list = useItems('google_campaign');
  const [creating, setCreating] = useState(false);
  const ok = conn && conn.status === 'connected';
  const info = (ok && conn.info) || {};
  const create = async (v) => {
    try {
      const d = await omni.post('/gs/external/items', { kind: 'google_campaign', name: v.name, budget: v.budget, type: v.type });
      await list.reload(); setCreating(false);
      toast(`"${d.item.name}" saved as a plan. Nothing was created at Google.`);
      return '';
    } catch (e) { return errOf(e, 'It could not be saved.'); }
  };
  const remove = async (it) => { try { await omni.del(`/gs/external/items/${it.id}`); await list.reload(); toast('Plan removed'); } catch (e) { toast(errOf(e, 'It could not be removed.')); } };
  return (
    <div>
      <PageHead eyebrow="Ads & campaigns" title="Google Campaigns" lead="Search, Display, and Performance Max campaigns running through your connected Google Ads account.">
        <Btn primary onClick={() => setCreating(true)}>＋ New Campaign</Btn>
      </PageHead>
      <LoadError error={error || list.error} />
      <ConnectionCard conn={conn} canConnect={canConnect} onChanged={setConn} connectLabel="Connect Google Ads" sub={ok ? `Customer ${info.customerId || ''}` : 'Your workspace'}
        info={[['Customer', info.customerId], ['Accounts this sign-in can open', info.accountsFound], ['This customer is in that list', info.customerListed === undefined ? '' : (info.customerListed ? 'Yes' : 'No: check the Customer ID')]]} />
      <Panel style={{ marginTop: 16 }}>
        <SimpleTable columns={['Campaign', 'Type', 'Budget/day', 'Clicks', 'Impressions', 'Status']} rows={[]} empty={ok ? 'Campaign results are not synced yet. Syncing is planned.' : 'Connect Google Ads to see your campaigns.'} />
      </Panel>
      <Panel title="Campaigns" sub="Running through the connected Google Ads account." style={{ marginTop: 16 }}>
        <SimpleTable columns={['Campaign', 'Type', 'Budget/day', 'Clicks', 'Impressions', 'Status', '']}
          empty={list.loading ? 'Loading…' : 'No campaigns yet. Write a plan with "New Campaign".'}
          rows={list.items.map((it) => [
            <b key="n">{it.name}</b>, (it.data && it.data.type) || 'Search', it.budget != null ? inr(it.budget) : '—', <NotSynced key="c" />, <NotSynced key="i" />,
            <Pill key="p" tone="draft">Plan only</Pill>,
            <span key="a" style={{ display: 'inline-flex', gap: 6 }}>
              <TinyBtn disabled title="Starting and pausing campaigns needs Google Ads: planned">▶</TinyBtn>
              <TinyBtn onClick={() => remove(it)} title="Remove this plan">🗑</TinyBtn>
            </span>,
          ])} />
        <Planned>Creating the campaign at Google is planned. "New Campaign" only saves your plan here: nothing is created and nothing is spent.</Planned>
      </Panel>
      {creating && <FormModal title="New Google campaign" sub="This saves a plan only. Nothing is created at Google." okLabel="Create campaign" onClose={() => setCreating(false)} onSubmit={create}
        fields={[{ id: 'name', label: 'Campaign name', placeholder: 'Winter range — Search' }, { id: 'type', label: 'Type', options: ['Search', 'Display', 'Performance Max'] }, { id: 'budget', label: 'Daily budget in ₹ (optional)', placeholder: '500', inputMode: 'numeric' }]}
        initial={{ name: '' }} />}
    </div>
  );
}
