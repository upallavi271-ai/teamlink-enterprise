// Dashboard charts (hrms-24 §9). Hand-built SVG / HTML — no chart library.
export { default as ChartCard, DataTable, Legend, useTip } from './ChartCard.jsx';
export { default as BarChart } from './BarChart.jsx';
export { default as StackedBarChart } from './StackedBarChart.jsx';
export { default as TrendChart } from './TrendChart.jsx';
export { default as ChartFromSpec } from './ChartFromSpec.jsx';
export { default as InsightsPanel } from './InsightsPanel.jsx';
export { fullValue, shortValue, slotOf, niceTicks } from './format.js';
