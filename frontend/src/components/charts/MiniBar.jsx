// MiniBar — a small in-table bar (e.g. Department overview rows).
//   <MiniBar value max tone? title? />
// ProgressBar — a labelled meter (e.g. Team snapshot workload).
//   <ProgressBar value max tone? label? valueFormat? />
// The unfilled track is a light step of the same tone, so the state reads
// across the whole bar. Tone: green / yellow / red / blue / grey (default blue).
import { toneVar, normTone, defaultFormat } from './kit.jsx';

const frac = (v, m) => {
  const max = Number(m) || 0;
  const val = Number(v) || 0;
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, val / max));
};

export function MiniBar({ value, max, tone, title }) {
  const f = frac(value, max);
  const t = normTone(tone) || 'blue';
  return (
    <span className="tlc tlk tlk-mini" title={title || `${defaultFormat(value)} of ${defaultFormat(max)}`} role="img" aria-label={title || `${defaultFormat(value)} of ${defaultFormat(max)}`}>
      <span className={`tlk-track tlk-t-${t}`}>
        {f > 0 && <span className="tlk-fill" style={{ width: `${Math.max(3, f * 100)}%`, background: toneVar(t) }} />}
      </span>
    </span>
  );
}

export function ProgressBar({ value, max, tone, label, valueFormat }) {
  const f = frac(value, max);
  const t = normTone(tone) || 'blue';
  const fmt = valueFormat || defaultFormat;
  const pctTxt = `${Math.round(f * 100)}%`;
  return (
    <div className="tlc tlk tlk-progress">
      {(label || label === 0) && (
        <div className="tlk-pg-head">
          <span>{label}</span>
          <b>{`${fmt(value)} / ${fmt(max)}`}</b>
        </div>
      )}
      <div
        className={`tlk-track tlk-t-${t}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={Number(max) || 0}
        aria-valuenow={Number(value) || 0}
        aria-label={typeof label === 'string' ? `${label}: ${pctTxt}` : pctTxt}
        title={`${fmt(value)} of ${fmt(max)} (${pctTxt})`}
      >
        {f > 0 && <span className="tlk-fill" style={{ width: `${Math.max(2, f * 100)}%`, background: toneVar(t) }} />}
      </div>
    </div>
  );
}

export default MiniBar;
