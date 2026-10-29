// ---------------------------------------------------------------------------
// ASTERISK AUDIOSOCKET - the wire format between Asterisk (free phone system) and the AI voice gateway.
// docs.asterisk.org > Channel Drivers > AudioSocket. TCP; every message = 1 byte type + 2 bytes length (big-endian) + payload.
//
//   0x00 hangup / terminate (no payload)      0x01 call UUID (16 bytes)      0x03 DTMF (1 ASCII byte)
//   0x10 audio: 16-bit signed linear PCM, mono, little-endian, 8 kHz (the phone line)      0xff error
//
// The phone line is 8 kHz: 20 ms = 160 samples = 320 bytes per frame. Asterisk expects audio at real-time pace.
// ---------------------------------------------------------------------------
const KIND = { HANGUP: 0x00, UUID: 0x01, DTMF: 0x03, AUDIO: 0x10, ERROR: 0xff };
const RATE = 8000;
const FRAME_MS = 20;
const FRAME_BYTES = (RATE / 1000) * FRAME_MS * 2; // 320

function encode(kind, payload) {
  const body = payload ? Buffer.from(payload) : Buffer.alloc(0);
  const head = Buffer.alloc(3);
  head.writeUInt8(kind, 0);
  head.writeUInt16BE(body.length, 1);
  return Buffer.concat([head, body]);
}

// A stream reader: feed(chunk) -> complete messages { kind, payload }. TCP can split or join messages anywhere.
class Reader {
  constructor() { this.buf = Buffer.alloc(0); }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 3) {
      const len = this.buf.readUInt16BE(1);
      if (this.buf.length < 3 + len) break;
      out.push({ kind: this.buf.readUInt8(0), payload: this.buf.subarray(3, 3 + len) });
      this.buf = this.buf.subarray(3 + len);
    }
    return out;
  }
}

const uuidText = (b) => {
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const uuidBytes = (s) => Buffer.from(String(s).replace(/-/g, ''), 'hex');

module.exports = { KIND, RATE, FRAME_MS, FRAME_BYTES, encode, Reader, uuidText, uuidBytes };
