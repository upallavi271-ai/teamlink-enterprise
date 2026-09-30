// The top summary bar (spec A): a Month / Year quick pick that sets the same
// period the period picker does, the month's total and a chip per category
// ("Rent: ₹X"). Read from GET /office-expenses/summary — every live bill
// (pending, approved, paid); rejected bills are out of the books.
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import {
  money, MONTH_FULL, monthOfSel, monthSel, rangeOfSel,
} from './officeUtil';

export default function MonthBar({
  period, setPeriod, reloadKey, activeCats, onPickCategory,
}) {
  const ym = monthOfSel(period);
  const now = new Date();
  const [y, m0] = ym || [now.getFullYear(), now.getMonth()];
  const [sum, setSum] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true); setErr('');
    const params = ym ? { month: ym[1] + 1, year: ym[0] } : { period };
    api.get('/office-expenses/summary', { params })
      .then((r) => { setSum(r.data); setBusy(false); })
      .catch((e) => { setErr(e.response?.data?.error || 'The month summary could not be loaded.'); setBusy(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);
  useEffect(load, [load, reloadKey]);

  const pick = (yy, mm) => setPeriod(monthSel(yy, mm));
  const step = (k) => { const d = new Date(y, m0 + k, 1); pick(d.getFullYear(), d.getMonth()); };
  const years = [];
  for (let yy = now.getFullYear() - 6; yy <= now.getFullYear() + 1; yy += 1) years.push(yy);
  const label = ym ? `${MONTH_FULL[m0]} ${y}` : rangeOfSel(period).label;
  const bs = sum?.by_status;

  return (
    <div className="oe-mb">
      <div className="oe-mb-pick">
        <span className="oe-mb-l">Month</span>
        <div className="oe-mb-ctl">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => step(-1)} aria-label="Previous month">‹</button>
          <select className={`oe-sel${ym ? ' set' : ''}`} value={ym ? m0 : ''} aria-label="Month"
            onChange={(e) => { if (e.target.value !== '') pick(y, Number(e.target.value)); }}>
            {!ym && <option value="">— other period —</option>}
            {MONTH_FULL.map((mn, i) => <option key={mn} value={i}>{mn}</option>)}
          </select>
          <select className={`oe-sel${ym ? ' set' : ''}`} value={y} aria-label="Year" onChange={(e) => pick(Number(e.target.value), m0)}>
            {years.map((yy) => <option key={yy} value={yy}>{yy}</option>)}
          </select>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => step(1)} aria-label="Next month">›</button>
        </div>
        {!ym && <div className="small-muted oe-mb-note">Showing {label} — pick a month to jump to it</div>}
      </div>

      <div className="oe-mb-total" aria-live="polite">
        <span className="oe-mb-l">Total expenses · {label}</span>
        {err ? (
          <span className="oe-mb-err">{err} <button type="button" className="link-btn" onClick={load}>Retry</button></span>
        ) : (
          <>
            <b className="oe-mb-n">{sum ? money(sum.total_amount) : '…'}{busy && sum && <span className="oe-spin oe-spin-sm" aria-label="Updating" />}</b>
            {bs && (
              <span className="oe-mb-sub">
                {sum.count} bill{sum.count === 1 ? '' : 's'} · pending {money(bs.PENDING.total_amount)} · approved {money(bs.APPROVED.total_amount)} · paid {money(bs.PAID.total_amount)}
                {bs.REIMBURSED && bs.REIMBURSED.count > 0 && ` · reimbursed ${money(bs.REIMBURSED.total_amount)}`}
                {bs.REJECTED.count > 0 && ` · ${bs.REJECTED.count} rejected (not counted)`}
              </span>
            )}
          </>
        )}
      </div>

      <div className="oe-mb-chips">
        {sum && sum.category_wise_totals.length === 0 && !err && <span className="small-muted">No expenses recorded for {label}</span>}
        {sum && sum.category_wise_totals.map((c) => {
          const on = (activeCats || []).length === 1 && activeCats[0] === c.category;
          return (
            <button type="button" key={c.category} className={`oe-mb-chip${on ? ' on' : ''}`}
              title={`${c.count} bill${c.count === 1 ? '' : 's'} — click to filter the table to ${c.category}`}
              onClick={() => onPickCategory && onPickCategory(on ? null : c.category)}>
              {c.category}: <b>{money(c.total_amount)}</b>
            </button>
          );
        })}
      </div>
    </div>
  );
}
