// Dependency-free inline SVG sparkline (matches the prototype's approach).
export function Sparkline({ data, width = 96, height = 28, color = 'var(--accent)' }: {
  data: number[]; width?: number; height?: number; color?: string;
}) {
  if (data.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => `${i * step},${height - ((v - min) / span) * (height - 4) - 2}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
