"""
TeamLink AI voice - KOKORO speaking server for HINDI (free: Kokoro-82M weights Apache-2.0, kokoro-onnx MIT).
Piper has no free Hindi voice; Kokoro has four (hf_alpha, hf_beta female; hm_omega, hm_psi male).

  POST /speak   JSON {"text": "...", "voice": "hf_alpha", "lang": "hi", "speed": 1.0}  ->  audio/wav (16-bit mono)
  GET  /health  -> {"ok": true}

Listens on 127.0.0.1 only. When KOKORO_API_KEY is set, every request must send it in X-API-Key.

  KOKORO_MODEL   path of kokoro-v1.0(.int8).onnx      KOKORO_VOICES  path of voices-v1.0.bin
  KOKORO_HOST / KOKORO_PORT   127.0.0.1 / 8094        KOKORO_VOICE   default voice (hf_alpha)
"""
import hmac
import io
import json
import os
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from kokoro_onnx import Kokoro

HOST = os.getenv("KOKORO_HOST", "127.0.0.1")
PORT = int(os.getenv("KOKORO_PORT", "8094"))
KEY = os.getenv("KOKORO_API_KEY", "")
VOICE = os.getenv("KOKORO_VOICE", "hf_alpha")
VOICES = ("hf_alpha", "hf_beta", "hm_omega", "hm_psi")

kokoro = Kokoro(os.getenv("KOKORO_MODEL", "kokoro-v1.0.int8.onnx"), os.getenv("KOKORO_VOICES", "voices-v1.0.bin"))
lock = threading.Lock()
print(f"[kokoro] loaded, listening on {HOST}:{PORT}", flush=True)


def wav_of(samples, rate):
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body, kind="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def err(self, code, msg):
        return self.reply(code, json.dumps({"error": msg}).encode("utf-8"))

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, b'{"ok": true}')
        return self.err(404, "not found")

    def do_POST(self):
        if KEY and not hmac.compare_digest(self.headers.get("X-API-Key", ""), KEY):
            return self.err(401, "bad key")
        if self.path != "/speak":
            return self.err(404, "not found")
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n <= 0 or n > 20000:
            return self.err(400, "send JSON with text")
        try:
            b = json.loads(self.rfile.read(n).decode("utf-8"))
            text = str(b.get("text", "")).strip()[:600]
            voice = b.get("voice") if b.get("voice") in VOICES else VOICE
            speed = min(1.6, max(0.6, float(b.get("speed", 1.0))))
            if not text:
                return self.err(400, "text is empty")
            t = time.time()
            with lock:
                samples, rate = kokoro.create(text, voice=voice, speed=speed, lang=str(b.get("lang", "hi"))[:5])
            print(f"[kokoro] {len(text)} chars -> {len(samples) / rate:.1f}s audio in {int((time.time() - t) * 1000)} ms", flush=True)
            return self.reply(200, wav_of(samples, rate), "audio/wav")
        except Exception as e:  # noqa: BLE001 - one bad sentence must not stop the server
            return self.err(500, str(e)[:200])

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
