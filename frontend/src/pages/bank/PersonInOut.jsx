// HAND LOANS: IN AND OUT BY PERSON (founder 2026-11-28): choose a person and a month and see how much money they put in
// to TeamLink and how much went out of the TeamLink account to them. Rows come from GET /bank/hand-loans (`ledger`):
// statement lines linked to or filed as a hand loan, lines that look like one but are not filed yet, and typed hand
// entries that have no statement line.
import { useMemo, useState } from 'react';
import { money2, fmtD } from '../invoices/invFormat';

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (k) => (/^\d{4}-\d{2}$/.test(k) ? `${MON3[Number(k.slice(5, 7)) - 1]}-${k.slice(0, 4)}` : k);
const HOW = { linked: 'Linked to a hand entry', filed: 'Filed as hand loan', guess: 'Not filed yet', entry: 'Typed entry, no statement line' };

const totals = (rows) => rows.reduce((t, r) => ({ ...t, [r.dir]: t[r.dir] + r.amount }), { in: 0, out: 0 });
const group = (rows, keyOf) => {
  const m = new Map();
  rows.forEach((r) => { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return [...m.entries()].map(([key, list]) => ({ key, n: list.length, ...totals(list) }));
};

function Diff({ t }) {
  const d = t.in - t.out;
  if (Math.abs(d) < 0.5) return <span>Even</span>;
  return d > 0 ? <span className="s6-red">{money2(d)} more came in</span> : <span className="s6-green">{money2(-d)} more went out</span>;
}

export default function PersonInOut({ ledger = [] }) {
  const [person, setPerson] = useState('');
  const [month, setMonth] = useState('');
  const [account, setAccount] = useState('');
  const [guesses, setGuesses] = useState(true);
  const people = useMemo(() => [...new Set(ledger.map((r) => r.person))].sort((a, b) => a.localeCompare(b)), [ledger]);
  const months = useMemo(() => [...new Set(ledger.map((r) => String(r.date).slice(0, 7)))].sort().reverse(), [ledger]);
  const accounts = useMemo(() => [...new Set(ledger.map((r) => r.account).filter(Boolean))].sort(), [ledger]);

  // `scope` = everything but the month, so the month table stays whole while one month is chosen.
  const scope = ledger.filter((r) => (!person || r.person === person) && (!account || r.account === account) && (guesses || r.how !== 'guess'));
  const rows = scope.filter((r) => !month || String(r.date).slice(0, 7) === month);
  const t = totals(rows);
  const notFiled = rows.filter((r) => r.how === 'guess');
  const nf = totals(notFiled);
  const byMonth = group(scope, (r) => String(r.date).slice(0, 7)).sort((a, b) => b.key.localeCompare(a.key));
  const byPerson = group(rows, (r) => r.person).sort((a, b) => (b.in + b.out) - (a.in + a.out));
  const pick = { padding: '6px 8px', minWidth: 150 };

  return (
    <section data-testid="hand-in-out" style={{ marginBottom: 18 }}>
      <h4 className="s6-h3">Came in and went out — choose a person</h4>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
        <select value={person} onChange={(e) => setPerson(e.target.value)} style={pick} aria-label="Person">
          <option value="">All persons</option>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={month} onChange={(e) => setMonth(e.target.value)} style={pick} aria-label="Month">
          <option value="">All months</option>
          {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
        </select>
        <select value={account} onChange={(e) => setAccount(e.target.value)} style={pick} aria-label="Bank account">
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <label className="s6-sub" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={guesses} onChange={(e) => setGuesses(e.target.checked)} /> Count lines not filed yet
        </label>
        {(person || month || account || !guesses) && (
          <button type="button" className="s6-btn sm" onClick={() => { setPerson(''); setMonth(''); setAccount(''); setGuesses(true); }}>Clear filters</button>
        )}
      </div>
      <div className="s6-stats">
        <div className="s6-stat green"><div className="s6-label">Came in (they put in)</div><div className="v s6-green">{money2(t.in)}</div><div className="c">{rows.filter((r) => r.dir === 'in').length} line(s)</div></div>
        <div className="s6-stat red"><div className="s6-label">Went out from TeamLink</div><div className="v s6-red">{money2(t.out)}</div><div className="c">{rows.filter((r) => r.dir === 'out').length} line(s)</div></div>
        <div className="s6-stat"><div className="s6-label">Difference</div><div className="v" style={{ fontSize: 18 }}><Diff t={t} /></div><div className="c">{person || 'All persons'} · {month ? monthName(month) : 'All months'}</div></div>
      </div>
      {guesses && notFiled.length > 0 && (
        <div className="s6-sub" style={{ marginBottom: 8 }}>Includes {notFiled.length} line(s) not filed yet (in {money2(nf.in)}, out {money2(nf.out)}). The app only guessed from the narration that these are hand loans.</div>
      )}

      <div className="s6-tbl fixed" style={{ maxHeight: 280, overflow: 'auto', marginBottom: 10 }}>
        <table style={{ minWidth: 640 }}>
          <thead><tr><th className="sort">{person ? 'Month' : 'Person'}</th><th className="num">Lines</th><th className="num">Came in</th><th className="num">Went out</th><th>Difference</th></tr></thead>
          <tbody>
            {(person ? byMonth : byPerson).map((g) => (
              <tr key={g.key} style={{ cursor: 'pointer', fontWeight: person && g.key === month ? 700 : 400 }} onClick={() => (person ? setMonth(g.key === month ? '' : g.key) : setPerson(g.key))}>
                <td>{person ? monthName(g.key) : g.key}</td>
                <td className="num s6-mono">{g.n}</td>
                <td className="num s6-mono s6-green">{g.in ? money2(g.in) : '—'}</td>
                <td className="num s6-mono s6-red">{g.out ? money2(g.out) : '—'}</td>
                <td><Diff t={g} /></td>
              </tr>
            ))}
            {!(person ? byMonth : byPerson).length && <tr><td colSpan="5" className="bks-empty">Nothing for these filters.</td></tr>}
          </tbody>
        </table>
      </div>

      {person && (
        <div className="s6-tbl fixed" style={{ maxHeight: 320, overflow: 'auto' }}>
          <table style={{ minWidth: 820 }}>
            <thead><tr><th className="sort">Date</th><th>Narration</th><th>Account</th><th className="num">Came in</th><th className="num">Went out</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="s6-mono">{fmtD(r.date)}</td>
                  <td className="s6-sub" style={{ minWidth: 260 }}>{String(r.description || '—').slice(0, 110)}<div><b>{HOW[r.how]}</b></div></td>
                  <td className="s6-mono">{r.account || '—'}</td>
                  <td className="num s6-mono s6-green">{r.dir === 'in' ? money2(r.amount) : ''}</td>
                  <td className="num s6-mono s6-red">{r.dir === 'out' ? money2(r.amount) : ''}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan="5" className="bks-empty">Nothing for these filters.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
