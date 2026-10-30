"""
TeamLink AI voice - WHISPER server (free, MIT: openai-whisper weights via faster-whisper / CTranslate2).

Two jobs for the phone gateway (backend/src/calling/voice/engines.js whisperHttp):
  POST /detect      body: 16 kHz 16-bit mono PCM  ->  {"lang": "te"|"hi"|"en", "prob": 0..1}
                    which of OUR three languages the person spoke (others ignored), so the assistant can switch at once
  POST /transcribe  body: the same, header X-Lang: en|hi|te  ->  {"text": "...", "conf": {...}}
  (both take an optional header X-Prompt: the question the assistant just asked, URL-encoded, English only. Whisper
   hears a short answer far better when it knows the question - a real phone "Yes." was heard as "You" / "here".)
  POST /hear        body: the same, header X-Min-Prob  ->  {"lang", "prob", "text", "conf"}: the language, and the English words
                    only when it is English (one pass for a call that is in English)
                    English words (IndicConformer has no English)
  POST /speech      body: the same  ->  {"speechMs": n, "parts": k}: how much REAL speech the clip holds (Silero VAD, MIT,
                    bundled with faster-whisper). A click, a cough or line noise is near 0 - the gateway then ignores the clip
                    instead of hearing words in it (research 2026-10-30: noise was written as words and switched the language)
  GET  /health      -> {"ok": true, "model": "..."}

"conf" = how sure Whisper is of the words (2026-10-29: "Yes, I have" came out as "Yes, I can't tell you so much about it"):
  logprob   the lowest segment avg_logprob (0 = certain; below about -1 = a guess)
  noSpeech  the highest no_speech_prob (near 1 = it thinks there was no speech: the words may be made up from noise)
  ratio     the highest compression_ratio (above about 2.4 = repeated / looping text)
The phone gateway decides from these whether an answer was heard clearly (backend/src/calling/voice/gateway.js).

Listens on 127.0.0.1 only. When WHISPER_API_KEY is set, every request must send the same value in X-API-Key.
One model, one request at a time (a lock); the phone gateway sends one sentence at a time per call.

  WHISPER_MODEL    base (default: right on phone answers, under 1.6 s on a 4-CPU server) | small (slower) | a folder
  WHISPER_HOST / WHISPER_PORT   127.0.0.1 / 8093
  WHISPER_THREADS  CPU threads (default 2)
  WHISPER_MODEL_OPEN  a second, more exact model (e.g. small) for OPEN answers - a city, years, a notice period - asked
                   for with the header X-Model: open. Measured 2026-10-30 on this server: base ~0.9 s but "Warangal" ->
                   "Warainful"; small ~2.1 s and right. Yes / no answers stay on the quick model.
"""
import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, get_speech_timestamps

MODEL = os.getenv("WHISPER_MODEL", "base")
HOST = os.getenv("WHISPER_HOST", "127.0.0.1")
PORT = int(os.getenv("WHISPER_PORT", "8093"))
KEY = os.getenv("WHISPER_API_KEY", "")
THREADS = int(os.getenv("WHISPER_THREADS", "2"))
BEAM = max(1, int(os.getenv("WHISPER_BEAM", "1")))  # 1 (greedy): 3 was no more right on phone clips but 0.8 s slower per answer on the 2-thread server (2026-10-29)
OURS = ("te", "hi", "en")
MAX_BYTES = 16000 * 2 * 30  # 30 s of audio

model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
MODEL_OPEN = os.getenv("WHISPER_MODEL_OPEN", "")
model_open = WhisperModel(MODEL_OPEN, device="cpu", compute_type="int8", cpu_threads=THREADS) if MODEL_OPEN else None
lock_open = threading.Lock()
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


# phone settings (research 2026-10-30): short words count, short pauses split parts, little padding (we measure, not cut)
VAD_OPTS = VadOptions(threshold=0.5, min_speech_duration_ms=90, min_silence_duration_ms=150, speech_pad_ms=20)
vad_lock = threading.Lock()  # the VAD model is separate from Whisper: it never waits for a transcription


def speech(audio):
    with vad_lock:
        parts = get_speech_timestamps(audio, vad_options=VAD_OPTS)
    samples = sum(int(p["end"]) - int(p["start"]) for p in parts)
    return {"speechMs": int(samples * 1000 / 16000), "parts": len(parts)}


def prompt_of(headers):
    from urllib.parse import unquote
    p = unquote(headers.get("X-Prompt", "") or "").strip()
    p = "".join(ch for ch in p if 32 <= ord(ch) < 127)[:200]  # plain English text only
    return p or None


def _plain(t):
    return " ".join("".join(ch.lower() if ch.isalnum() else " " for ch in str(t)).split())


def transcribe(audio, lang, prompt=None, exact=False):
    use, use_lock = (model_open, lock_open) if exact and model_open else (model, lock)
    with use_lock:
        # temperature 0 = no slow retries; max_new_tokens = a phone answer is short (no "fufufu..." loops)
        segments, _ = use.transcribe(audio, language=lang if lang in OURS else None, beam_size=BEAM, temperature=0.0, initial_prompt=prompt,
                                       max_new_tokens=60, without_timestamps=True, condition_on_previous_text=False, vad_filter=False)
        segs = list(segments)
    text = " ".join(s.text.strip() for s in segs).strip()
    # THE QUESTION WRITTEN BACK (measured 2026-10-30: "Three years." came out as "How many years of experience?"): when the
    # words are just the prompt again, they are heard once more WITHOUT the prompt
    if prompt and text and _plain(text) and _plain(text) in _plain(prompt):
        return transcribe(audio, lang, None, exact)
    conf = {
        "logprob": round(min((s.avg_logprob for s in segs), default=0.0), 3),
        "noSpeech": round(max((s.no_speech_prob for s in segs), default=1.0), 3),
        "ratio": round(max((s.compression_ratio for s in segs), default=0.0), 2),
    }
    return {"text": text, "conf": conf}


def hear(audio, min_prob, prompt=None, exact=False):
    # ONE pass for an English-mode call: which of our languages; the English words only when it IS English (a Telugu /
    # Hindi answer is heard by IndicConformer instead, so Whisper does not spend time writing it as English)
    d = detect(audio)
    if d["lang"] != "en" and d["prob"] >= min_prob:
        return {"lang": d["lang"], "prob": d["prob"], "text": ""}
    t = transcribe(audio, "en", prompt, exact)
    return {"lang": "en", "prob": d["prob"], "text": t["text"], "conf": t["conf"]}


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
            return self.send(200, {"ok": True, "model": MODEL, "open": MODEL_OPEN or None})
        return self.send(404, {"error": "not found"})

    def do_POST(self):
        if not self.allowed():
            return self.send(401, {"error": "bad key"})
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self.send(400, {"error": "send 0.1 - 30 s of 16 kHz 16-bit mono PCM"})
        audio = audio_of(self.rfile.read(n))
        exact = (self.headers.get("X-Model", "") or "").lower() == "open"
        t = time.time()
        try:
            if self.path == "/detect":
                out = detect(audio)
            elif self.path == "/hear":
                out = hear(audio, float(self.headers.get("X-Min-Prob", "0.6") or 0.6), prompt_of(self.headers), exact)
            elif self.path == "/speech":
                out = speech(audio)
            elif self.path == "/transcribe":
                out = transcribe(audio, (self.headers.get("X-Lang", "en") or "en")[:2].lower(), prompt_of(self.headers), exact)
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
