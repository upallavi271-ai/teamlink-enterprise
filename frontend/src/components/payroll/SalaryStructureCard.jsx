import './payroll.css';

// ---------------------------------------------------------------------------
// SALARY STRUCTURE CARD — the user's reference layout, used for both
//   - the Standard Package reference on Payroll → Dashboard / Salary Structure
//     (an illustrative example, recalculated live from a CTC input), and
//   - an employee's OWN structure (Payroll & Compensation, employee side),
//     with their real, stored figures.
//
// `b` is the backend's breakup shape (backend utils/salaryRules.js):
//   { basic, hra, bonus, special, gross, employeePf, professionalTax,
//     deductions, net, employerPf, gratuity, ctcCheck, valid }
// A stipend has no components: pass `stipend` instead and the card shows the
// flat amount as both earnings and net pay.
// ---------------------------------------------------------------------------

export const rupees = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const minus = (n) => `−${rupees(n)}`;

function Row({ label, value, total, ded }) {
  return (
    <div className={`ss-row${total ? ' total' : ''}${ded ? ' ded' : ''}`}>
      <span>{label}</span>
      <span className="ss-amt">{value}</span>
    </div>
  );
}

export default function SalaryStructureCard({
  b, stipend, title = 'Salary Structure', subtitle, controls, footer, empty,
}) {
  const isStipend = stipend != null;
  return (
    <div className="ss-card">
      <div className="ss-card-head">
        <h3>{title}</h3>
        {subtitle && <div className="ss-card-sub">{subtitle}</div>}
      </div>
      {controls && <div className="ss-controls">{controls}</div>}
      <div className="ss-body">
        {!b && !isStipend && <div className="small-muted" style={{ padding: '12px 0' }}>{empty || 'No salary structure has been set yet.'}</div>}

        {isStipend && (
          <>
            <div className="ss-sec earn">Earnings</div>
            <Row label="Stipend (fixed monthly)" value={rupees(stipend)} />
            <Row label="Gross" value={rupees(stipend)} total />
            <div className="ss-sec ded">Deductions</div>
            <Row label="None — a stipend carries no PF or PT" value={rupees(0)} />
            <div className="ss-net"><span>Net Pay</span><span className="ss-amt">{rupees(stipend)}</span></div>
          </>
        )}

        {b && !isStipend && (
          <>
            <div className="ss-sec earn">Earnings</div>
            <Row label="Basic" value={rupees(b.basic)} />
            <Row label="HRA" value={rupees(b.hra)} />
            <Row label="Bonus" value={rupees(b.bonus)} />
            <Row label="Special Allowance" value={rupees(b.special)} />
            <Row label="Gross" value={rupees(b.gross)} total />

            <div className="ss-sec ded">Deductions</div>
            <Row label="PF (Provident Fund)" value={minus(b.employeePf)} ded />
            <Row label="PT (Professional Tax)" value={minus(b.professionalTax)} ded />
            <Row label="Total Deductions" value={minus(b.deductions)} total ded />

            <div className="ss-net"><span>Net Pay</span><span className="ss-amt">{rupees(b.net)}</span></div>

            <div className="ss-sec emp">Employer Cost <span className="ss-sec-note">(not part of your take-home)</span></div>
            <Row label="Employer PF" value={rupees(b.employerPf)} />
            <Row label="Gratuity" value={rupees(b.gratuity)} />
            <Row label="CTC" value={rupees(b.ctcCheck)} total />
            {b.valid === false && (
              <div className="ss-warn">This CTC is too small to carry Basic, HRA, Bonus, PF and Gratuity — Special Allowance is negative.</div>
            )}
          </>
        )}
      </div>
      {footer && <div className="ss-foot">{footer}</div>}
    </div>
  );
}
