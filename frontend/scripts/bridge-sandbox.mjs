// The screens of the TEAMLINK-STYLE demo server used to try the "Companies" menu, on this PC only (docs/second-company.md section 9):  npm run bridge-sandbox
// The ordinary TeamLink screens (no company name set), talking to backend/scripts/teamlink-bridge-sandbox.js on :4067.
process.env.VITE_API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:4067';
process.env.VITE_PORT = process.env.VITE_PORT || '5186';
await import('./sandbox.mjs');
