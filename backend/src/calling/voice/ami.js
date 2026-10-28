// ---------------------------------------------------------------------------
// ASTERISK MANAGER (AMI) - the free way to tell Asterisk "dial this number" (2026-10-28). Plain TCP, no package.
//
//   const a = new Ami({ host, port, user, secret });  await a.connect();
//   await a.action({ Action: 'Originate', ... })   -> the reply (Response: Success | Error)
//   a.on('event', (e) => ...)                      -> every event (OriginateResponse, Hangup, ...), keys as Asterisk sends them
//
// A message is "Key: Value" lines ending with an empty line. Each action carries an ActionID; its reply has the same one.
// AMI listens on 127.0.0.1 only (manager.conf), with its own user and secret.
// ---------------------------------------------------------------------------
const net = require('net');
const { EventEmitter } = require('events');

const TIMEOUT_MS = 10000;

function parse(block) {
  const m = {};
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) m[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return m;
}

function format(fields) {
  return `${Object.entries(fields).filter(([, v]) => v != null).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`])).join('\r\n')}\r\n\r\n`;
}

class Ami extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 5038, user, secret } = {}) {
    super();
    Object.assign(this, { host, port: Number(port), user, secret });
    this.sock = null; this.buf = ''; this.waiting = new Map(); this.seq = 0; this.ready = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.port, this.host);
      this.sock = sock;
      let banner = true;
      sock.setEncoding('utf8');
      sock.on('data', (d) => {
        this.buf += d;
        if (banner) { const i = this.buf.indexOf('\r\n'); if (i < 0) return; this.buf = this.buf.slice(i + 2); banner = false; } // "Asterisk Call Manager/x"
        let j;
        while ((j = this.buf.indexOf('\r\n\r\n')) >= 0) {
          const m = parse(this.buf.slice(0, j)); this.buf = this.buf.slice(j + 4);
          const w = m.ActionID && this.waiting.get(m.ActionID);
          if (m.Response && w) { this.waiting.delete(m.ActionID); clearTimeout(w.t); w.resolve(m); } else if (m.Event) this.emit('event', m);
        }
      });
      sock.on('error', (e) => { if (!this.ready) reject(e); });
      sock.on('close', () => {
        this.ready = false;
        for (const w of this.waiting.values()) { clearTimeout(w.t); w.reject(new Error('Asterisk manager closed')); }
        this.waiting.clear();
        this.emit('close');
      });
      sock.on('connect', async () => {
        try {
          const r = await this.action({ Action: 'Login', Username: this.user, Secret: this.secret, Events: 'call' });
          if (r.Response !== 'Success') throw new Error(`Asterisk manager login refused: ${r.Message || r.Response}`);
          this.ready = true; resolve(this);
        } catch (e) { sock.destroy(); reject(e); }
      });
    });
  }

  action(fields) {
    const id = fields.ActionID || `tl-${Date.now()}-${(this.seq += 1)}`;
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) { reject(new Error('Asterisk manager is not connected')); return; }
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error('Asterisk manager did not answer')); }, TIMEOUT_MS);
      this.waiting.set(id, { resolve, reject, t });
      this.sock.write(format({ ...fields, ActionID: id }));
    });
  }

  close() { if (this.sock) this.sock.destroy(); }
}

module.exports = { Ami, parse, format };
