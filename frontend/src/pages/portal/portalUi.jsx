import api from '../../api';
import StatusChip from '../../components/ui/StatusChip.jsx';
import './portal.css';

// Small shared pieces for the two outside-login portals (ClientPortal.jsx,
// CandidateHome.jsx). Nothing here reads a role: what each portal shows is
// decided by what /api/portal/* sends.

export const fmtDate = (d) => (d
  ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—');

export const fmtDateTime = (d) => (d
  ? new Date(d).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');

export function Chip({ label, tone }) {
  return <StatusChip status={label} tone={tone || undefined} />;
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tlp-tabs" role="tablist">
      {tabs.filter(Boolean).map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={`tlp-tab${active === t.id ? ' active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}{t.count != null ? ` (${t.count})` : ''}
        </button>
      ))}
    </div>
  );
}

export function Stat({ value, label, onClick }) {
  return (
    <button type="button" className="tlp-stat" onClick={onClick}>
      <div className="v">{value ?? 0}</div>
      <div className="l">{label}</div>
    </button>
  );
}

export function KV({ rows }) {
  return (
    <dl className="tlp-kv">
      {rows.filter(([, v]) => v !== undefined).map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

// Opens a file the API streams (resume) in a new tab, with the login token.
export async function openFile(url) {
  const r = await api.get(url, { responseType: 'blob' });
  const href = URL.createObjectURL(r.data);
  window.open(href, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}

// Plain-language interview line: "Mon, 29 Sep 2026, 11:00 · Online · Round 1".
export function InterviewLine({ iv }) {
  if (!iv) return null;
  return (
    <div className="tlp-box">
      <div>
        <b>{iv.kind || 'Interview'}</b> · {fmtDateTime(iv.at)}
        {iv.mode ? ` · ${iv.mode}` : ''}{iv.round > 1 ? ` · Round ${iv.round}` : ''}
        {' '}<Chip label={iv.status} />
      </div>
      {iv.location && <div className="tlp-meta">Place: {iv.location}</div>}
      {iv.link && (
        <div className="tlp-meta">
          Meeting link: <a className="tlp-link" href={iv.link} target="_blank" rel="noreferrer">{iv.link}</a>
        </div>
      )}
    </div>
  );
}
