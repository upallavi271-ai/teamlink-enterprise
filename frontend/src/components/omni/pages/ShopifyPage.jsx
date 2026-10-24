import { useState } from 'react';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Planned } from '../ui.jsx';
import ConnectionCard from '../external/ConnectionCard.jsx';
import { Metric, Metrics, Toggle, SimpleTable, LoadError } from '../external/parts.jsx';
import { useConnection } from '../external/useExternal.js';

// Shopify (prototype page shopify). Connect a store with its domain + Admin API token (Admin only); the read-only check (shop.json) returns the shop name.
// Orders, revenue, abandoned carts and customer sync are "Not synced yet" / planned: no sample orders, no invented customers.
export default function ShopifyPage() {
  const { dept, toast } = useOmni();
  const { conn, canConnect, settings, setConn, saveSettings, error } = useConnection('shopify');
  const [open, setOpen] = useState(false);
  const ok = conn && conn.status === 'connected';
  const info = (ok && conn.info) || {};
  const sync = settings && settings.shopify;
  const meta = ok ? 'Not synced yet' : 'Connect to view';
  const workspace = dept ? `${dept} workspace` : 'All departments';
  return (
    <div>
      <PageHead eyebrow="Commerce" title="Shopify" lead="Connect your Shopify store to sync orders, customers, and recover abandoned carts.">
        {canConnect && <Btn primary onClick={() => setOpen(true)}>🔗 {conn && conn.status !== 'not_connected' ? 'Change Shopify keys' : 'Connect Shopify Store'}</Btn>}
      </PageHead>
      <LoadError error={error} />
      <ConnectionCard conn={conn} canConnect={canConnect} onChanged={setConn} open={open} setOpen={setOpen} connectLabel="Connect Shopify Store" sub={ok ? `${info.shopName || 'Shopify store'} (${info.domain || ''})` : workspace}
        lead="Once connected, orders and customers sync automatically into your CRM, and abandoned checkouts can trigger a WhatsApp or Email recovery campaign. Today TeamLink only checks the connection and reads the shop name."
        info={[['Shop', info.shopName], ['Address', info.domain], ['Plan', info.plan], ['Currency', info.currency]]} />
      <Metrics>
        <Metric label="Orders synced" value="—" meta={meta} dim={!ok} />
        <Metric label="Revenue attributed" value="—" meta={meta} dim={!ok} />
        <Metric label="Carts recovered" value="—" meta={meta} dim={!ok} />
      </Metrics>
      <Panel title="Sync customers to CRM" sub="New Shopify customers are added as CRM leads automatically." style={{ marginTop: 16 }}
        right={<Toggle on={!!(sync && sync.syncCustomers)} disabled={!canConnect || !sync} label="Sync customers to CRM" title={canConnect ? '' : 'Only an Admin can change this'}
          onChange={async (v) => { try { await saveSettings('shopify', { syncCustomers: v }); toast(v ? 'Customer sync enabled' : 'Customer sync disabled'); } catch { toast('That could not be saved.'); } }} />}>
        <Planned>Your choice is saved, but copying customers into the CRM is planned: no customer is added yet.</Planned>
      </Panel>
      <Panel title="Recent orders" sub={ok ? `Connected to ${info.domain || 'your store'}. Orders are not synced yet.` : 'Connect a store to sync live orders.'} style={{ marginTop: 16 }}>
        <SimpleTable columns={['Order', 'Customer', 'Total', 'Status', 'Placed']} rows={[]} empty={ok ? 'Orders are not synced yet. Syncing is planned.' : 'Connect Shopify to see your orders.'} />
      </Panel>
      <Panel title="Abandoned carts" sub="Send a WhatsApp reminder to recover these." style={{ marginTop: 16 }}>
        <SimpleTable columns={['Customer', 'Cart value', 'Abandoned', 'Action']} rows={[]} empty={ok ? 'Abandoned carts are not synced yet. Recovery messages are planned.' : 'Connect Shopify to see abandoned carts.'} />
      </Panel>
    </div>
  );
}
