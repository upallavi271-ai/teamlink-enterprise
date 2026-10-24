import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Planned, fmtNum } from '../ui.jsx';
import ConnectionCard from '../external/ConnectionCard.jsx';
import { Metric, Metrics, SimpleTable, LoadError } from '../external/parts.jsx';
import { useConnection } from '../external/useExternal.js';

// Facebook Catalogs (prototype page fbcatalogs). Connect a catalog (Admin); the read-only check returns the catalog name and how many products Facebook holds.
// Syncing products to the catalog is planned, so the totals and the product tables stay "Not synced yet": no invented products.
export default function FbCatalogsPage() {
  const { go } = useOmni();
  const { conn, canConnect, setConn, error } = useConnection('fb-catalog');
  const ok = conn && conn.status === 'connected';
  const info = (ok && conn.info) || {};
  const meta = ok ? 'Not synced yet' : 'Connect to view';
  const empty = ok ? 'Products are not synced yet. Syncing is planned.' : 'Connect your Facebook catalog to see the products.';
  return (
    <div>
      <PageHead eyebrow="Commerce" title="Facebook Catalogs" lead="Sync your product catalog to power Facebook & Instagram Shops and dynamic ads.">
        <Btn primary disabled title="Syncing a catalog is planned: nothing is sent to Facebook yet">↻ Sync Catalog Now</Btn>
      </PageHead>
      <LoadError error={error} />
      <ConnectionCard conn={conn} canConnect={canConnect} onChanged={setConn} connectLabel="Connect Facebook Catalog" sub={ok ? (info.catalogName || 'Facebook catalog') : 'Your workspace'}
        info={[['Catalog', info.catalogName], ['Products at Facebook', info.productCount != null ? fmtNum(info.productCount) : '']]}>
        <Planned>"Sync Catalog Now" is planned. TeamLink does not send products to Facebook yet.</Planned>
      </ConnectionCard>
      <Metrics>
        <Metric label="Products synced" value="—" meta={meta} dim={!ok} />
        <Metric label="In stock" value="—" meta={meta} dim={!ok} />
        <Metric label="Out of stock" value="—" meta={meta} dim={!ok} />
      </Metrics>
      <Panel title="Catalog items" sub="Products feeding Facebook & Instagram Shops" style={{ marginTop: 16 }}>
        <SimpleTable columns={['Product', 'Price', 'Inventory', 'Status']} rows={[]} empty={empty} />
      </Panel>
      <Panel title="Catalog items" sub={`Last synced: never · 0 products shown.`} right={<Btn onClick={() => go('shopify')}>Source: Shopify →</Btn>} style={{ marginTop: 16 }}>
        <SimpleTable columns={['SKU', 'Product', 'Price', 'Stock', 'Status']} rows={[]} empty={empty} />
      </Panel>
    </div>
  );
}
