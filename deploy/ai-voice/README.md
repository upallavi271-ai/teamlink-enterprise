# AI phone calls with free voices (own SIP line)

A recruiter presses **Call with AI (phone)** in the AI call window. TeamLink dials the candidate through our own SIP line. When the candidate answers, the AI assistant talks to them in Telugu, Hindi or English, then saves the answers and the outcome like any AI call.

Only the SIP minutes cost money. Everything else is free software running on our server.

| Part | What it does | Free software (licence) |
|---|---|---|
| Asterisk | Dials through the SIP line and passes the call audio to TeamLink | Asterisk (GPL) |
| Gateway | Listens, detects when the candidate interrupts, decides the reply | `backend/src/calling/voice/` (ours) |
| Speaking | Says the assistant's lines | Piper (MIT). Telugu voices: AI4Bharat IndicVoices-R (CC-BY-4.0). English voice: ljspeech (public domain) |
| Hearing Telugu / Hindi | Turns speech into text | IndicConformer 600M (MIT), through VEXYL-STT (Apache-2.0) |
| Hearing English, spotting the language | Turns English speech into text and tells which language was spoken | Whisper, through faster-whisper (MIT) |

## Setup on the VPS (as root)

1. Copy this folder to the server and create the settings file:
   ```bash
   cp ai-voice.env.example /root/ai-voice.env && chmod 600 /root/ai-voice.env
   ```
   Fill in the file. Keep the passwords there only, never in chat or git.
2. Install the voice engines:
   ```bash
   bash setup-ai-voice.sh voices
   ```
   This needs `HF_TOKEN`. The script stops if free memory is under 3.5 GB.
3. Set up Asterisk and connect the phone line. There are two ways (`SIP_MODE` in the settings file):
   - **`gateway`**: our own GSM gateway box with SIMs (Synway SMG) in the office. The box connects to this server. The script prints what to type into the box's web page. It needs `OFFICE_IPS`.
   - **`trunk`**: a SIP trunk from a licensed telecom provider. It needs the `SIP_*` settings. This is the safer way for large daily volumes.

   Then run:
   ```bash
   bash setup-ai-voice.sh asterisk
   ```
   It also needs `TEST_NUMBERS`.
4. Add the lines the script prints to `backend/.env`, then restart the backend with pm2.
5. Test mode: only `TEST_NUMBERS` can be called. Call your own phone first. When it works, change `AI_VOICE_PHONE_MODE=Live`.

Status and stopping:

```bash
bash setup-ai-voice.sh status
```

```bash
bash setup-ai-voice.sh stop
```

## Safety

- **Same rules as every AI call:** consent, opt-out, DND, calling hours, daily limits.
- **No SIP or Asterisk settings, no button:** without them the button stays hidden.
- **Access:**
  - The voice services listen only on 127.0.0.1 and need a key.
  - The Asterisk manager listens only on 127.0.0.1.
  - The SIP port and voice ports should be open only to the provider's IPs.
- **Incoming calls:** hung up for now.
- **Resource limits:** each voice service is capped at 4 GB or 2 GB of memory and 2 CPUs, so TeamLink always comes first.
