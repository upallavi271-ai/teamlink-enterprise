// The screens of a SEPARATE COMPANY, on this PC only (docs/second-company.md):  npm run company-sandbox
// The same Vite app as `npm run sandbox`, built with the company's own name (frontend/src/brand.js) and talking to the company sandbox
// API (backend: npm run company-sandbox, :4066) instead of TeamLink's.
process.env.VITE_BRAND_NAME = process.env.VITE_BRAND_NAME || 'NISHTECHNOLOGIES INDIA PVT LTD';
process.env.VITE_API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:4066';
process.env.VITE_PORT = process.env.VITE_PORT || '5185';
await import('./sandbox.mjs');
