// Dashboard charts (hrms-24 §9). Hand-built SVG / HTML — no chart library.
export { default as ChartCard, DataTable, Legend, useTip } from './ChartCard.jsx';
export { default as BarChart } from './BarChart.jsx';
export { default as StackedBarChart } from './StackedBarChart.jsx';
export { default as TrendChart } from './TrendChart.jsx';
export { default as ChartFromSpec } from './ChartFromSpec.jsx';
export { default as InsightsPanel } from './InsightsPanel.jsx';
export { fullValue, shortValue, slotOf, niceTicks } from './format.js';
// ATS layout v3 kit (2026-10-03) — responsive SVG, hover tooltip, clickable
// marks, "No data for this period", hidden table for screen readers.
export { default as GroupedBarChart } from './GroupedBarChart.jsx';
export { default as FunnelChart } from './FunnelChart.jsx';
export { default as DonutChart } from './DonutChart.jsx';
export { default as LineChart } from './LineChart.jsx';
export { MiniBar, ProgressBar } from './MiniBar.jsx';
export { normTone, toneVar, slotVar } from './kit.jsx';
