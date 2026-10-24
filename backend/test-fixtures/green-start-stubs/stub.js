// Tiny stand-in programs for the Green Start supervisor tests (scripts/green-start-supervisor-test.js). NOT used by the real app.
//   node stub.js tcp <port> [delayMs]        listens on 127.0.0.1:<port> after the delay (stands in for the database and the entrance)
//   node stub.js http <port> [delayMs]       answers 200 on /api/v1/health (stands in for the Green Start server); writes its env facts to <STUB_ENV_OUT> if set
//   node stub.js redis <port>                answers +PONG to PING, +OK to the rest, exits on SHUTDOWN (stands in for Redis)
//   node stub.js idle                        does nothing for ever (stands in for the worker)
//   node stub.js crash <ms> <text...>        prints <text> on stderr, exits with code 1 after <ms>
//   node stub.js hang                        never listens, never exits (a start that does not finish)
//   node stub.js state <jsonFile>            prints the file (stands in for gs-db.cjs state)
//   node stub.js migrate <jsonFile> <n>      sets "migrations" in the file to <n> (stands in for prisma migrate deploy)
//   node stub.js seed <jsonFile>             sets users 3, contacts 12 in the file (stands in for the demo seed)
//   node stub.js backup <file>               writes a small gzip file (stands in for gs-db.cjs dump <file>)
//   node stub.js ok | fail                   exit 0 / exit 1
const net = require('net');
const http = require('http');
const fs = require('fs');
const zlib = require('zlib');

const [mode, a, b, ...rest] = process.argv.slice(2);
const after = (ms, fn) => setTimeout(fn, Number(ms) || 0);
const keepAlive = () => setInterval(() => {}, 1 << 30);

if (mode === 'tcp') {
  after(b, () => net.createServer((s) => s.end()).listen(Number(a), '127.0.0.1'));
  keepAlive();
} else if (mode === 'http') {
  after(b, () => {
    http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); }).listen(Number(a), '127.0.0.1');
    if (process.env.STUB_ENV_OUT) fs.writeFileSync(process.env.STUB_ENV_OUT, JSON.stringify({ REDIS_URL: process.env.REDIS_URL || null, hasJwt: !!process.env.JWT_SECRET, hasDbUrl: !!process.env.DATABASE_URL, port: process.env.PORT || null, nodeOptions: process.env.NODE_OPTIONS || null }));
  });
  keepAlive();
} else if (mode === 'redis') {
  net.createServer((s) => {
    s.on('data', (d) => {
      const text = d.toString('latin1');
      const words = [...text.matchAll(/\r\n\$\d+\r\n(\w+)/g)].map((m) => m[1].toUpperCase());
      let out = '';
      for (const w of words) {
        if (w === 'PING') out += '+PONG\r\n';
        else if (w === 'SHUTDOWN') { s.end('+OK\r\n'); process.exit(0); } else out += '+OK\r\n';
      }
      if (out) s.write(out);
    });
    s.on('error', () => {});
  }).listen(Number(a), '127.0.0.1');
  keepAlive();
} else if (mode === 'idle' || mode === 'hang') {
  keepAlive();
} else if (mode === 'crash') {
  process.stderr.write(`${[b, ...rest].join(' ')}\n`);
  after(a, () => process.exit(1));
  keepAlive();
} else if (mode === 'state') {
  process.stdout.write(`${fs.readFileSync(a, 'utf8').trim()}\n`);
} else if (mode === 'migrate') {
  const j = JSON.parse(fs.readFileSync(a, 'utf8')); j.migrations = Number(b); fs.writeFileSync(a, JSON.stringify(j));
  process.stdout.write('migrations applied\n');
} else if (mode === 'seed') {
  const j = JSON.parse(fs.readFileSync(a, 'utf8')); j.users = 3; j.contacts = 12; fs.writeFileSync(a, JSON.stringify(j));
  process.stdout.write('demo workspace added\n');
} else if (mode === 'backup') {
  fs.writeFileSync(a, zlib.gzipSync('{"kind":"header"}\n{"kind":"end","tables":0,"rows":0}\n'));
  process.stdout.write('{"ok":true}\n');
} else if (mode === 'fail') {
  process.stderr.write('failed on purpose\n'); process.exit(1);
} else process.exit(0);
