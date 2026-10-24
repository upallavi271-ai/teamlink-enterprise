// the prototype's on / off switch (.toggle) as a real button
export default function Toggle({ on, onChange, disabled, label, title }) {
  return (
    <button type="button" className={`toggle${on ? ' on' : ''}`} role="switch" aria-checked={!!on} aria-label={label} title={title} disabled={disabled} onClick={() => onChange && onChange(!on)}>
      <span />
    </button>
  );
}
