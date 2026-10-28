# Self-hosted AI calling: server setup (zero paid AI APIs)

The path of one call:

```
Synway gateway (SIM / FXO) --SIP--> Asterisk --AudioSocket (TCP, 8 kHz)--> TeamLink backend (calling/local/audioSocket.js)
                                                                              |-> Vexyl STT  (speech -> words, self-hosted)
                                                                              |-> dialogue.js (fixed, verified sentences)
                                                                              |-> Ollama     (yes / no / later label only)
                                                                              '-> Vexyl TTS  (words -> speech, cached)
```

Nothing leaves the server or the office network. TeamLink refuses to send call audio or text to any address that is not
loopback, a private IP range, a bare service name or `*.local` / `*.lan` / `*.internal` (see `backend/src/calling/local/config.js`).
Phone call charges come from the SIM / telecom operator. They are not free.

**Do not run any of this on the live server without the founder's approval.** The steps below install software and download models.

## 1. The AI server (Linux, 16 GB+ RAM; an NVIDIA GPU with 8 GB+ is much faster)

| Piece | Licence | Disk | Run |
|---|---|---|---|
| Ollama + `qwen2.5:1.5b` | MIT / Apache-2.0 | ~1 GB | `curl -fsSL https://ollama.com/install.sh \| sh` then `ollama pull qwen2.5:1.5b` |
| Vexyl STT (IndicConformer 600M) | Apache-2.0 / MIT model | ~3 GB | `git clone https://github.com/vexyl-ai/vexyl-stt`, `./setup.sh`, then run with `VEXYL_STT_PORT=8090` |
| Vexyl TTS (Indic Parler-TTS) | Apache-2.0 | ~6 GB | `git clone https://github.com/vexyl-ai/vexyl-tts`, `./setup.sh`, then run with `VEXYL_TTS_PORT=8092 VEXYL_TTS_SAMPLE_RATE=8000` |

- **Vexyl STT** needs a Hugging Face account that has accepted the IndicConformer model terms, and a **read token** in that
  server's `.env` as `HF_TOKEN`. Never put the token in TeamLink or in chat.
- **Shared secrets:** set `VEXYL_STT_API_KEY` and `VEXYL_TTS_API_KEY` to long random strings. Put the same values in TeamLink's
  `AI_CALL_STT_KEY` and `AI_CALL_TTS_KEY`.
- **Network:** keep ports 8090, 8092 and 11434 closed to the internet (firewall). Only the TeamLink backend needs them.

## 2. Asterisk + Synway

1. Install Asterisk 18 or newer with `res_audiosocket` and `app_audiosocket` (`asterisk -rx "module show like audiosocket"`).
2. Copy `asterisk/pjsip_synway.conf` and `asterisk/extensions_teamlink.conf` into `/etc/asterisk/`. Include them from
   `pjsip.conf` / `extensions.conf`.
3. Fill in the Synway gateway's LAN IP and the channel or prefix rules from its admin page.
4. Reload: `asterisk -rx "pjsip reload"` and `asterisk -rx "dialplan reload"`.

## 3. TeamLink backend `.env`

```
AI_CALL_OLLAMA_URL=http://127.0.0.1:11434
AI_CALL_OLLAMA_MODEL=qwen2.5:1.5b
AI_CALL_STT_URL=ws://127.0.0.1:8090
AI_CALL_STT_KEY=<same as VEXYL_STT_API_KEY>
AI_CALL_TTS_URL=ws://127.0.0.1:8092
AI_CALL_TTS_KEY=<same as VEXYL_TTS_API_KEY>
AI_CALL_TTS_CACHE_DIR=/opt/teamlink-enterprise/backend/uploads/ai-call-voice
AI_CALL_AUDIOSOCKET_PORT=9092
AI_CALL_AUDIOSOCKET_HOST=127.0.0.1
```

If the AI server is another machine on the LAN, use its private IP, for example `ws://192.168.1.50:8090`.

Restart the backend. It logs `[ai-calling] self-hosted: Vexyl speech, AudioSocket 127.0.0.1:9092, Ollama qwen2.5:1.5b`.

Then check every piece:

```
cd backend && node scripts/ai-calling-local-check.js
```

This places no call. It lists the Ollama models, opens an empty STT session and renders the word "Hello".

## 4. Not built yet (Phase 3–4, after the server exists)

- Placing the outbound call: an Asterisk AMI originate that sets `AICALL_UUID` and stores it as the call's `callSid`.
  Asterisk then connects to the bridge, which already handles the whole conversation and saves the result.
- "Self-hosted (Synway)" as a calling provider next to Exotel in Administration.
- English speech: Vexyl STT has no English model. English and Tenglish calls are heard with the Telugu model. If English
  accuracy is poor, add a faster-whisper server (MIT licence).
- The first real test call goes only to the founder's own number, and only with his approval.
