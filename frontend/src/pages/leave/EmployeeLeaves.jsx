// ---------------------------------------------------------------------------
// ON THE APPROVE / REJECT SCREEN (founder 2026-11-25: "in the approve / reject tab the leaves that employee has taken, and whether they were
// approved or rejected, must be seen right there"):
//   * EmployeeLeaves - the employee's balance, this year's totals and every other leave with what was decided
//   * SplitNote      - the pay-month rule (first days Team Lead then HR, the rest Super Admin): every part of the application, who has
//                      approved or rejected each one, and who it still waits for
// Both only draw what the server sends (GET /api/leave/:id/workflow: employeeLeave, split).
// ---------------------------------------------------------------------------
import { EmptyMini, SectionLabel, Status } from '../../components/proto.jsx';

const dm = (iso) => {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || '—';
  return new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
export const dates = (from, to) => (to && to !== from ? `${dm(from)} – ${dm(to)}` : dm(from));
const days = (n) => `${n} day${Number(n) === 1 ? '' : 's'}`;

const whoNeeded = (kind) => (kind === 'sa' ? 'Super Admin' : 'Team Lead, then HR');

// One approver of one request: who, and whether they approved, rejected, or are still to decide.
export function Approval({ a }) {
  const done = a.status === 'Approved' || a.status === 'Rejected';
  const mark = a.status === 'Approved' ? '✓' : a.status === 'Rejected' ? '✗' : a.status === 'Pending' ? '⏳' : '○';
  const word = done ? `${a.status.toLowerCase()}${a.at ? ` on ${dm(a.at)}` : ''}` : a.status === 'Pending' ? 'waiting' : 'after that';
  return (
    <div className={`lvx-appr lvx-appr-${a.status.toLowerCase()}`}>
      <span aria-hidden="true">{mark}</span> <b>{a.label}</b>{a.name ? ` ${a.name}` : ''} <span>— {word}{a.direct ? ' (decided directly)' : ''}</span>
      {done && a.note && <span className="lvx-comment"> “{a.note}”</span>}
    </div>
  );
}

export function SplitNote({ split, currentId, onOpenPart }) {
  if (!split) return null;
  const { parts = [], months = [], limit, of, totalDays } = split;
  return (
    <div className="lvx-split" data-testid="split-note">
      <div>
        <b>{of > 1 ? `${days(totalDays)} leave in ${of} parts` : `${days(totalDays)} leave`}</b> ({dates(split.fromDate, split.toDate)}).
        {' '}The first {days(limit)} of leave in a pay month need the Team Lead and then HR; every further day needs the Super Admin.
      </div>
      {months.map((m) => <div key={m.key} className="lvx-muted">Pay month {m.label} ({m.rangeText}): {days(m.usedBefore)} already applied before this leave.</div>)}
      {parts.map((p) => (p.deleted
        ? <div key={p.id} className="lvx-part lvx-muted">Part {p.part} was deleted.</div>
        : (
          <div key={p.id} className={`lvx-part${p.id === currentId ? ' lvx-part-now' : ''}`}>
            <div className="lvx-part-head">
              <b>{of > 1 ? `Part ${p.part}: ` : ''}{dates(p.fromDate, p.toDate)} ({days(p.days)})</b>
              <span className="lvx-muted">{whoNeeded(p.kind)}</span>
              <Status>{p.status}</Status>
              {of > 1 && (p.id === currentId
                ? <span className="lvx-chip lvx-chip-blue">On this screen</span>
                : onOpenPart && <button type="button" className="btn btn-sm" onClick={() => onOpenPart(p.id)}>Open part {p.part}</button>)}
            </div>
            {(p.approvals || []).map((a) => <Approval key={`${a.level}-${a.status}`} a={a} />)}
            {(p.approvals || []).length === 0 && p.decidedBy && <div className="lvx-appr">{p.status} by <b>{p.decidedBy}</b>{p.decidedAt ? ` on ${dm(p.decidedAt)}` : ''}</div>}
          </div>
        )))}
    </div>
  );
}

function Total({ label, t, tone }) {
  return (
    <div className={`lvx-total lvx-total-${tone}`}>
      <b>{t.days}</b>
      <span>{label}</span>
      <small>{t.requests} request{t.requests === 1 ? '' : 's'}</small>
    </div>
  );
}

export default function EmployeeLeaves({ data, name }) {
  if (!data) return null;
  const { totals, year, balances = [], requests = [], count } = data;
  return (
    <div className="lvx-history" data-testid="employee-leaves">
      <SectionLabel style={{ marginTop: 14 }}>{`${name || 'This employee'} — leaves in ${year} (this request not included)`}</SectionLabel>
      <div className="lvx-totals">
        <Total label="Days approved" t={totals.approved} tone="ok" />
        <Total label="Days waiting" t={totals.pending} tone="wait" />
        <Total label="Days rejected" t={totals.rejected} tone="no" />
        <Total label="Days cancelled" t={totals.cancelled} tone="off" />
      </div>

      {balances.length > 0 && (
        <div className="tbl-wrap lvx-bal">
          <table>
            <thead><tr><th>Type</th><th>Total</th><th>Taken</th><th title="Includes the request you are deciding">Waiting*</th><th>Available</th></tr></thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.type}>
                  <td>{b.type}</td>
                  <td>{b.limited ? b.total : '—'}</td>
                  <td>{b.taken}</td>
                  <td>{b.pending}</td>
                  <td><b>{b.limited ? b.available : 'No limit'}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="lvx-muted" style={{ padding: '2px 8px 4px' }}>* Waiting includes the request on this screen.</div>
        </div>
      )}

      <div className="lvx-hist-title">All other leave requests ({count}){count > requests.length ? ` — latest ${requests.length} shown` : ''}</div>
      {requests.length === 0
        ? <EmptyMini>No other leave requests.</EmptyMini>
        : (
          <div className="tbl-wrap lvx-hist">
            {/* Three columns so that "approved or rejected, and by whom" is on screen on a phone too. */}
            <table>
              <thead><tr><th>Leave</th><th>Approved / rejected</th><th className="lvx-wide-only">Reason</th></tr></thead>
              <tbody>
                {requests.map((r) => {
                  const d = r.decision || {};
                  const pending = r.status === 'Pending';
                  const acted = r.approvals || [];
                  const n = r.halfDay ? `0.5 day (${r.halfDay})` : days(r.days ?? 1);
                  const used = r.chargedDays != null && r.status !== 'Cancelled' && Number(r.chargedDays) !== Number(r.days) ? ` · ${r.chargedDays} taken` : '';
                  return (
                    <tr key={r.id} className={r.split?.sameApplication ? 'lvx-same' : undefined}>
                      <td><b>{dates(r.fromDate, r.toDate)}</b>
                        <div className="lvx-muted">{r.type} · {n}{used}</div>
                        {r.split && r.split.of > 1 && <div className="lvx-muted">{r.split.sameApplication ? 'Other part of this leave' : `Part ${r.split.part} of ${r.split.of}`}</div>}
                      </td>
                      <td>
                        <Status>{r.status}</Status>
                        {/* every approval level that has decided; older and imported leaves have only the final decider */}
                        {acted.map((a) => <Approval key={a.level} a={a} />)}
                        {pending && <div className="lvx-muted">{d.by ? `Waiting for ${d.by}` : 'Waiting'}</div>}
                        {!pending && acted.length === 0 && (d.by || d.at) && <div className="lvx-muted">{d.by ? `by ${d.by}` : ''}{d.at ? `${d.by ? ' · ' : ''}${dm(d.at)}` : ''}</div>}
                        {!pending && acted.length === 0 && d.comment && <div className="lvx-comment">“{d.comment}”</div>}
                      </td>
                      <td className="lvx-muted lvx-wide-only">{r.reasonText || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
