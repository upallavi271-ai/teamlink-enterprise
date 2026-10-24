import { useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, TinyBtn, Panel, Pill, Planned } from '../ui.jsx';
import ConnectionCard from '../external/ConnectionCard.jsx';
import { Metric, Metrics, SimpleTable, FormModal, NotSynced, LoadError, inr } from '../external/parts.jsx';
import { useConnection, useItems } from '../external/useExternal.js';

// Ads Manager (prototype page adsmanager). Connect the Meta ad account (Admin); the read-only check returns the account name.
// Campaign numbers stay "Not synced yet". "Create Ad Campaign" writes a PLAN here only: nothing is created at Meta, nothing is spent.
export default function AdsManagerPage() {
  const { toast } = useOmni();
  const { conn, canConnect, setConn, error } = useConnection('meta-ads');
  const list = useItems('ad_campaign');
  const [creating, setCreating] = useState(false);
  const ok = conn && conn.status === 'connected';
  const info = (ok && conn.info) || {};
  const meta = ok ? 'Not synced yet' : 'Connect to view';
  const create = async (v) => {
    try {
      const d = await omni.post('/gs/external/items', { kind: 'ad_campaign', name: v.name, budget: v.budget, platform: v.platform });
      await list.reload(); setCreating(false);
      toast(`"${d.item.name}" saved as a plan. Nothing was created at Meta.`);
      return '';
    } catch (e) { return errOf(e, 'It could not be saved.'); }
  };
  const remove = async (it) => { try { await omni.del(`/gs/external/items/${it.id}`); await list.reload(); toast('Plan removed'); } catch (e) { toast(errOf(e, 'It could not be removed.')); } };
  return (
    <div>
      <PageHead eyebrow="Ads & campaigns" title="Ads Manager" lead="Manage Facebook & Instagram ad campaigns from one place.">
        <Btn primary onClick={() => setCreating(true)}>＋ Create Ad Campaign</Btn>
      </PageHead>
      <LoadError error={error || list.error} />
      <ConnectionCard conn={conn} canConnect={canConnect} onChanged={setConn} connectLabel="Connect Meta Ads" sub={ok ? (info.accountName || 'Meta ad account') : 'Your workspace'}
        info={[['Ad account', info.accountName], ['Currency', info.currency], ['Time zone', info.timezone]]} />
      <Metrics>
        <Metric label="Active campaigns" value="—" meta={ok ? 'Not synced yet' : 'Connect to view'} dim={!ok} />
        <Metric label="Total spend (30d)" value="—" meta={meta} dim={!ok} />
        <Metric label="Avg. CTR" value="—" meta={meta} dim={!ok} />
      </Metrics>
      <Panel title="Ad campaigns" sub="Performance for the last 30 days" style={{ marginTop: 16 }}>
        <SimpleTable columns={['Campaign', 'Platform', 'Spend', 'Reach', 'CTR', 'Status']} rows={[]} empty={ok ? 'Ad performance is not synced yet. Syncing is planned.' : 'Connect Meta Ads to see ad performance.'} />
      </Panel>
      <Panel title="Ad campaigns" sub="Facebook and Instagram campaigns on the connected ad account." style={{ marginTop: 16 }}>
        <SimpleTable columns={['Campaign', 'Platform', 'Budget', 'Spend', 'Results', 'Status', '']}
          empty={list.loading ? 'Loading…' : 'No ad campaigns yet. Write a plan with "Create Ad Campaign".'}
          rows={list.items.map((it) => [
            <b key="n">{it.name}</b>, (it.data && it.data.platform) || 'Facebook', it.budget != null ? `${inr(it.budget)}/day` : '—', <NotSynced key="s" />, <NotSynced key="r" />,
            <Pill key="p" tone="draft">Plan only</Pill>,
            <span key="a" style={{ display: 'inline-flex', gap: 6 }}>
              <TinyBtn disabled title="Starting and pausing ads needs the ad account: planned">▶</TinyBtn>
              <TinyBtn onClick={() => remove(it)} title="Remove this plan">🗑</TinyBtn>
            </span>,
          ])} />
        <Planned>Creating the campaign at Meta is planned. "Create Ad Campaign" only saves your plan here: nothing is created and nothing is spent.</Planned>
      </Panel>
      {creating && <FormModal title="New ad campaign" sub="This saves a plan only. Nothing is created at Meta." okLabel="Create campaign" onClose={() => setCreating(false)} onSubmit={create}
        fields={[{ id: 'name', label: 'Campaign name', placeholder: 'Winter range — prospecting' }, { id: 'budget', label: 'Daily budget in ₹ (optional)', placeholder: '500', inputMode: 'numeric' }, { id: 'platform', label: 'Platform', options: ['Facebook', 'Instagram', 'Facebook and Instagram'] }]}
        initial={{ name: '' }} />}
    </div>
  );
}
