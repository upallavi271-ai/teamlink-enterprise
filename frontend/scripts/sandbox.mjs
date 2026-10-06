// TEST SANDBOX frontend: the same Vite app on :5184, proxying /api to the
// sandbox API on :4011 (backend/scripts/sandbox.js) instead of the real one.
//   npm run sandbox            (VITE_API_TARGET / VITE_PORT override the defaults)
// vite.config.js reads the proxy target from API_PROXY (default :4010), so the
// real dev server on 5183 is untouched.
process.env.API_PROXY = process.env.VITE_API_TARGET || 'http://localhost:4011';
const port = Number(process.env.VITE_PORT) || 5184;
if (port === 5183) throw new Error('5183 is the real dev frontend — use another port for the sandbox.');

const { createServer } = await import('vite');
const server = await createServer({ server: { port, strictPort: true } });
await server.listen();
console.log(`SANDBOX frontend — /api -> ${process.env.API_PROXY}`);
server.printUrls();
