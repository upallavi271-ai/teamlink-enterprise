// Lists every route the API registers, WITHOUT starting a server or touching
// a port: loads src/index.js in this process with app.listen() stubbed out.
// TEST/SANDBOX USE ONLY - it forces TEST_MODE=1 and the sandbox database file.
//
//   const { listRoutes } = require('./lib/listRoutes');
//   const routes = listRoutes();   // [{ method:'GET', path:'/api/x/:id' }, ...]
const path = require('path');

function listRoutes() {
  const BACK = path.resolve(__dirname, '..', '..');
  process.env.TEST_MODE = '1';
  process.env.PORT = '4098';
  process.env.DATABASE_URL = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
  const express = require(path.join(BACK, 'node_modules', 'express'));
  let captured = null;
  const realListen = express.application.listen;
  express.application.listen = function stub() { captured = this; return { on() {}, close() {} }; };
  try {
    // eslint-disable-next-line global-require
    require(path.join(BACK, 'src', 'index.js'));
  } finally { express.application.listen = realListen; }
  if (!captured) throw new Error('could not capture the express app');

  const out = [];
  const unmatched = [];
  const split = (re) => {
    if (re.fast_slash) return '';
    // Express 4 mounts compile to /^\/prefix\/?(?=\/|$)/i : take the literal part.
    let s = re.source;
    if (s.startsWith('^')) s = s.slice(1);
    s = s.replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\(\?=\\\/\|\$\)$/, '').replace(/\\\/\?$/, '');
    if (/[()?*+[\]{}|^$]/.test(s.replace(/\\./g, ''))) return null; // not a plain literal prefix
    return s.replace(/\\(.)/g, '$1');
  };
  const walk = (stack, prefix) => {
    stack.forEach((layer) => {
      if (layer.route) {
        const paths = [].concat(layer.route.path);
        Object.keys(layer.route.methods).filter((k) => layer.route.methods[k]).forEach((m) => {
          paths.forEach((p) => out.push({ method: m.toUpperCase(), path: prefix + (typeof p === 'string' ? p : `<regex ${p}>`) }));
        });
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const seg = split(layer.regexp);
        if (seg === null) { unmatched.push(String(layer.regexp)); return; }
        // keys (params in the mount path) show up as ':name' via the layer's keys
        let mount = seg;
        (layer.keys || []).forEach((k) => { mount = mount.replace(/(?:\(\?:)?\([^)]*\)/, `:${k.name}`); });
        walk(layer.handle.stack, prefix + mount);
      }
    });
  };
  walk(captured._router.stack, '');
  const seen = new Set();
  const routes = out.filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
  routes.unmatched = unmatched;
  return routes;
}
module.exports = { listRoutes };
