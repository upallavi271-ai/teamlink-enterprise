import { useEffect, useState } from 'react';
import api from '../../api';

// DATA QUALITY (backend utils/dataQuality.js): how complete the candidate database is, what is missing most, duplicates and how
// right the duplicate finder is, stale profiles, consent not recorded. TL and above.
const pct = (n) => (n == null ? '—' : `${n}%`);
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));

export default function DataQuality() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = (fresh) => { setBusy(true); api.get('/ats/data-quality', { params: fresh ? { fresh: 1 } : {} }).then((r) => setD(r.data)).catch((e) => setErr(e.response?.data?.error || 'Could not load.')).finally(() => setBusy(false)); };
  useEffect(() => { load(false); }, []);
  const Tile = ({ label, value, sub }) => (
    <div className="card" style={{ padding: '12px 14px', minWidth: 170, flex: '1 1 170px' }}>
      <div className="small-muted">{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, margin: '2px 0' }}>{value}</div>
      {sub && <div className="small-muted" style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  );
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Data quality</h1>
          <div className="page-sub">How complete and clean the candidate database is. Each profile is scored on the details a recruiter needs.</div>
        </div>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => load(true)}>{busy ? 'Counting…' : 'Count again'}</button>
      </div>
      {err && <div className="error-text">{err}</div>}
      {!d && !err && <div className="small-muted">Counting every profile…</div>}
      {d && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <Tile label="Profiles" value={num(d.total)} />
            <Tile label="Average completeness" value={pct(d.averageCompleteness)} sub={`80%+ complete: ${num(d.spread['80-100'])}`} />
            <Tile label="No phone and no email" value={num(d.noPhoneNoEmail)} sub="cannot be contacted" />
            <Tile label="Possible duplicates open" value={num(d.duplicates.openFlags)} sub={`${pct(d.duplicates.ratePct)} of profiles · ${num(d.duplicates.merged)} merged so far`} />
            <Tile label="Duplicate finder accuracy" value={pct(d.duplicates.accuracy && d.duplicates.accuracy.precisionPct)} sub={d.duplicates.accuracy && d.duplicates.accuracy.decided ? `${num(d.duplicates.accuracy.falseAlarms)} false alarms of ${num(d.duplicates.accuracy.decided)} checked (${pct(d.duplicates.accuracy.falseAlarmPct)})` : 'no flags decided yet'} />
            <Tile label="Not touched in 6 months" value={num(d.staleSixMonths)} sub="no application activity" />
            {d.staleData && <Tile label={`Stale data (older than ${d.staleData.days} days)`} value={num(d.staleData.total)} sub={d.staleData.oldest && d.staleData.oldest[0] ? `oldest: ${d.staleData.oldest[0].name} (${d.staleData.oldest[0].days} days) - salary, phone or resume not confirmed` : 'salary, phone or resume not confirmed'} />}
            <Tile label="Consent not recorded" value={num(d.consentNotRecorded)} />
            {d.invalid && <Tile label="Wrong values" value={num(d.invalid.profiles)} sub={`${pct(d.invalid.pct)} of profiles: bad e-mail, phone, date or experience`} />}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
            <div className="card section">
              <h3 style={{ marginTop: 0 }}>Completeness spread</h3>
              {Object.entries(d.spread).map(([k, n]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
                  <span style={{ width: 70 }}>{k}%</span>
                  <div style={{ flex: 1, background: 'var(--line-soft, #eee)', borderRadius: 4, height: 14 }}>
                    <div style={{ width: `${d.total ? (n / d.total) * 100 : 0}%`, background: 'var(--navy, #1e3a5f)', height: 14, borderRadius: 4 }} />
                  </div>
                  <span style={{ width: 80, textAlign: 'right' }}>{num(n)}</span>
                </div>
              ))}
            </div>
            <div className="card section">
              <h3 style={{ marginTop: 0 }}>Missing most often</h3>
              <table style={{ width: '100%' }}>
                <thead><tr><th style={{ textAlign: 'left' }}>Detail</th><th style={{ textAlign: 'right' }}>Profiles missing it</th><th style={{ textAlign: 'right' }}>%</th></tr></thead>
                <tbody>{d.missing.map((m) => <tr key={m.label}><td>{m.label}</td><td style={{ textAlign: 'right' }}>{num(m.count)}</td><td style={{ textAlign: 'right' }}>{m.pct}%</td></tr>)}</tbody>
              </table>
            </div>
            {/* WRONG VALUES (ATS audit 2026-11-18, Q707/Q708): filled in, but cannot be right */}
            {d.invalid && (
              <div className="card section">
                <h3 style={{ marginTop: 0 }}>Wrong values to fix</h3>
                {!d.invalid.byIssue.length && <div className="small-muted">No wrong e-mail, phone, date of birth or experience found.</div>}
                {d.invalid.byIssue.length > 0 && (
                  <table style={{ width: '100%', marginBottom: 8 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>Problem</th><th style={{ textAlign: 'right' }}>Profiles</th></tr></thead>
                    <tbody>{d.invalid.byIssue.map((b) => <tr key={b.key}><td>{b.label}</td><td style={{ textAlign: 'right' }}>{num(b.count)}</td></tr>)}</tbody>
                  </table>
                )}
                {d.invalid.toFix.length > 0 && (
                  <details>
                    <summary style={{ cursor: 'pointer' }}>{`Profiles to fix first (${d.invalid.toFix.length}${d.invalid.profiles > d.invalid.toFix.length ? ` of ${num(d.invalid.profiles)}` : ''})`}</summary>
                    <div style={{ maxHeight: 280, overflow: 'auto', marginTop: 6 }}>
                      {d.invalid.toFix.map((c) => <div key={c.id} style={{ fontSize: 13, padding: '3px 0', borderBottom: '1px solid var(--line-soft, #eee)' }}><b>{c.name}</b> <span className="small-muted">{c.issues.join(' · ')}</span></div>)}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
          <div className="small-muted" style={{ marginTop: 10 }}>Score weights: {d.items.map((i) => `${i.label} ${i.weight}`).join(' · ')}. Counted {new Date(d.at).toLocaleString('en-GB')}.</div>
        </>
      )}
    </div>
  );
}
