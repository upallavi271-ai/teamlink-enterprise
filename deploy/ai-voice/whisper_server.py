"""
TeamLink AI voice - WHISPER server (free, MIT: openai-whisper weights via faster-whisper / CTranslate2).

Two jobs for the phone gateway (backend/src/calling/voice/engines.js whisperHttp):
  POST /detect      body: 16 kHz 16-bit mono PCM  ->  {"lang": "te"|"hi"|"en", "prob": 0..1}
                    which of OUR three languages the person spoke (others ignored), so the assistant can switch at once
  POST /transcribe  body: the same, header X-Lang: en|hi|te  ->  {"text": "..."}
                    English words (IndicConformer has no English)
  GET  /health      -> {"ok": true, "model": "..."}

Listens on 127.0.0.1 only. When WHISPER_API_KEY is set, every request must send the same value in X-API-Key.
One model, one request at a time (a lock); the phone gateway sends one sentence at a time per call.

  WHISPER_MODEL    base (default: right on phone answers, under 1.6 s on a 4-CPU server) | small (slower) | a folder
  WHISPER_HOST / WHISPER_PORT   127.0.0.1 / 8093
  WHISPER_THREADS  CPU threads (default 2)
"""
import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from faster_whisper import WhisperModel

MODEL = os.getenv("WHISPER_MODEL", "base")
HOST = os.getenv("WHISPER_HOST", "127.0.0.1")
PORT = int(os.getenv("WHISPER_PORT", "8093"))
KEY = os.getenv("WHISPER_API_KEY", "")
THREADS = int(os.getenv("WHISPER_THREADS", "2"))
OURS = ("te", "hi", "en")
MAX_BYTES = 16000 * 2 * 30  # 30 s of audio

model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
lock = threading.Lock()
print(f"[whisper] model {MODEL} loaded, listening on {HOST}:{PORT}", flush=True)


def audio_of(raw):
    return np.frombuffer(raw[: len(raw) - (len(raw) % 2)], dtype=np.int16).astype(np.float32) / 32768.0


def detect(audio):
    with lock:
        _, _, probs = model.detect_language(audio)
    p = {k: v for k, v in probs if k in OURS}
    total = sum(p.values()) or 1.0
    best = max(OURS, key=lambda k: p.get(k, 0.0))
    return {"lang": best, "prob": round(p.get(best, 0.0) / total, 3)}


def transcribe(audio, lang):
    with lock:
        segments, _ = model.transcribe(audio, language=lang if lang in OURS else None, beam_size=1,
                                       without_timestamps=True, condition_on_previous_text=False, vad_filter=False)
        text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text}


class Handler(BaseHTTPRequestHandler):
    def send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        return not KEY or hmac.compare_digest(self.headers.get("X-API-Key", ""), KEY)

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, {"ok": True, "model": MODEL})
        return self.send(404, {"error": "not found"})

    def do_POST(self):
        if not self.allowed():
            return self.send(401, {"error": "bad key"})
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self.send(400, {"error": "send 0.1 - 30 s of 16 kHz 16-bit mono PCM"})
        audio = audio_of(self.rfile.read(n))
        t = time.time()
        try:
            if self.path == "/detect":
                out = detect(audio)
            elif self.path == "/transcribe":
                out = transcribe(audio, (self.headers.get("X-Lang", "en") or "en")[:2].lower())
            else:
                return self.send(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001 - one bad clip must not stop the server
            return self.send(500, {"error": str(e)[:200]})
        out["ms"] = int((time.time() - t) * 1000)
        print(f"[whisper] {self.path} {len(audio) / 16000:.1f}s -> {out}", flush=True)
        return self.send(200, out)

    def log_message(self, *args):  # the line above is enough
        pass


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
