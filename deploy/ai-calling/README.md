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

## 4. One-shot install (instead of steps 1-3 by hand)

```
sudo ./install.sh --teamlink-env /opt/teamlink-enterprise/backend/.env --synway-ip <gateway LAN IP>
```

It installs everything above plus the Asterisk AMI user `[teamlink]` (`/etc/asterisk/manager.d/teamlink.conf`, random secret,
127.0.0.1 only, rights: read system/call/reporting/config/dialplan, write originate/system). It asks for the Hugging Face read
token without echo, keeps every service on 127.0.0.1, writes the `AI_CALL_*` lines into TeamLink's `.env` (backup kept) and
the AMI secret into `/root/teamlink-ai-calling.env` (mode 600) for the Admin screen. Re-running it is safe.

## 5. Placing calls (built 2026-10-28)

- Administration > Integrations > AI Calling > **Calling provider: Self-hosted (Synway)**: Asterisk server address (private only),
  AMI port 5038, AMI user `teamlink`, AMI secret (stored encrypted, never shown again), trunk `synway`, gateway LAN IP, number
  format (10 digits / 0 + 10 / +91), context `teamlink-ai`, ring time.
- **Test connection** is read only (`backend/src/calling/local/ami.js`): AMI login, Ping, version, `res_audiosocket` +
  `app_audiosocket`, the trunk points at the gateway IP, `[teamlink-ai]` has AudioSocket. It never sends an Originate.
  Live is refused until this test passed for the current details. From a shell: `node scripts/ai-calling-ami-check.js`.
- A call: TeamLink saves a new UUID as the call's `callSid`, then `Originate Channel=PJSIP/<number>@synway Context=teamlink-ai
  Exten=s Variable=AICALL_UUID=<uuid> Async=true`. Asterisk's OriginateResponse sets the status: answered -> in progress (the
  bridge talks and saves Completed), Reason 5 busy, 1/3 no answer, 0/8 failed - with the same retries as Exotel. An answered
  call whose AudioSocket never connects is failed after 45 s with the reason. Every step is in the call's event log.
- Tested against an AMI simulator only (`scripts/ai-calling-ami-test.js`, 22 checks). That is not a real call.

## 6. Still open

- English speech: Vexyl STT has no English model. English and Tenglish calls are heard with the Telugu model. If English
  accuracy is poor, add a faster-whisper server (MIT licence).
- The first real test call goes only to the founder's own number, and only with his approval (switch on Test, his number as
  the only test number).
