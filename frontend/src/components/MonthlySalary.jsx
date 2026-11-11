// ---------------------------------------------------------------------------
// THE SALARY AT JOINING, PER MONTH (founder 2026-11-11: "joined click chesaina tharvatha evariki ayina, monthly ctc enter chesaka,
// automatic ga annual ctc theeskovali. next save chesaka save avvali").
// One box for every Joined screen (the profile's Joined popup and the Joining screen): it starts on "Per month", shows the yearly
// figure right under it, and hands back the YEARLY CTC (what the server keeps). "Per year" stays for someone who has the yearly CTC.
//   const [sal, setSal] = useState(salaryStart(app.offeredCtc));
//   <MonthlySalary value={sal} onChange={setSal} />      yearlyOf(sal) -> 528000
// ---------------------------------------------------------------------------
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

/** The box's starting value from a yearly CTC on file (shown per month). */
export function salaryStart(yearlyOnFile) {
  const y = Number(yearlyOnFile);
  return { amount: y > 0 ? String(Math.round(y / 12)) : '', unit: 'month' };
}

/** The yearly CTC the box stands for (0 = nothing written). */
export function yearlyOf(v) {
  const n = Number(v && v.amount);
  if (!(n > 0)) return 0;
  return Math.round(v.unit === 'year' ? n : n * 12);
}

export default function MonthlySalary({ value, onChange, label = 'Salary', hint = '' }) {
  const v = value || { amount: '', unit: 'month' };
  const yearly = yearlyOf(v);
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <label className="field">
      <span>{`${label} (₹ ${v.unit === 'month' ? 'per month' : 'per year'})`}</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="number" min="1" inputMode="numeric" style={{ flex: 1 }}
          step={v.unit === 'month' ? 500 : 1000}
          placeholder={v.unit === 'month' ? 'e.g. 44000' : 'e.g. 528000'}
          value={v.amount}
          onChange={(e) => set({ amount: e.target.value })}
        />
        <span role="group" aria-label="Per month or per year" style={{ display: 'inline-flex', gap: 4 }}>
          {[['month', 'Per month'], ['year', 'Per year']].map(([u, l]) => (
            <button key={u} type="button" className={`btn btn-sm${v.unit === u ? ' btn-primary' : ''}`} aria-pressed={v.unit === u} onClick={() => set({ unit: u })}>{l}</button>
          ))}
        </span>
      </div>
      <span className="small-muted">
        {yearly > 0
          ? (v.unit === 'month' ? `${inr(v.amount)} a month = ${inr(yearly)} a year (CTC) — this is saved` : `${inr(yearly)} a year = about ${inr(yearly / 12)} a month`)
          : (hint || 'Write the monthly salary; the yearly CTC is worked out for you.')}
        {v.unit === 'year' && yearly > 0 && yearly < 100000 ? ' — this looks like a monthly amount: press "Per month".' : ''}
      </span>
    </label>
  );
}
