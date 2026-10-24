import { useState } from 'react';
import omni from '../omniApi.js';
import { PageHead, Btn } from '../ui.jsx';
import { useOmni } from '../omniContext.js';
import { refreshWallet } from '../omniStore.js';
import { useLoad, MonthPick, Err, downloadFile } from '../admin/adminUtil.jsx';
import BillingMine from '../admin/BillingMine.jsx';
import BillingCompany, { RechargeModal } from '../admin/BillingCompany.jsx';

// Billing ("Plan & usage"). EVERYBODY sees "Your credits" (given, used, left this month, per way, Test messages apart). Admin and Finance also see the
// company view: credit balance, usage by way / department / person, cost per message, the credit rules, recharge history. TeamLink has no paid plan and
// no payment gateway: "Add credits" RECORDS a recharge by hand; auto top-up, payment methods and invoices are Planned.
export default function BillingPage() {
  const { toast, dept } = useOmni();
  const [month, setMonth] = useState('');
  const { data, err, loading, reload } = useLoad(() => omni.get('/billing/summary', month ? { month } : {}), [month, dept]);
  const [adding, setAdding] = useState(false);
  const co = data && data.company;
  const exportUsage = async () => {
    try { await downloadFile('/billing/usage.csv', { month: data ? data.month : month }, `omni-usage-${data ? data.month : month}.csv`); toast('Usage exported'); } catch { toast('You cannot download the usage.'); }
  };
  return (
    <div>
      <PageHead eyebrow="Plan & usage" title="Billing" lead="Your plan, the credits that pay for every message, and the invoices behind them.">
        {data && <MonthPick value={data.month} months={data.months} onChange={setMonth} />}
        {co && <Btn onClick={exportUsage}>⬇ Export usage</Btn>}
        {data && data.canRecharge && <Btn primary onClick={() => setAdding(true)}>＋ Add credits</Btn>}
      </PageHead>
      <Err text={err} />
      {loading && !data && <div className="card panel">Loading…</div>}
      {data && data.mine && <BillingMine mine={data.mine} />}
      {data && co && (
        <>
          {data.mine && <div className="panel-title" style={{ margin: '22px 2px 10px', fontSize: 15 }}>The whole company</div>}
          <BillingCompany co={co} canRecharge={data.canRecharge} canEditRules={data.canEditRules} reload={() => { reload(); refreshWallet(); }} toast={toast} onAdd={() => setAdding(true)} />
        </>
      )}
      {adding && <RechargeModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); toast('Recharge recorded'); reload(); refreshWallet(); }} />}
    </div>
  );
}
