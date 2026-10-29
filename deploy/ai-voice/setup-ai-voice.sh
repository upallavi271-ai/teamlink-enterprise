#!/usr/bin/env bash
# =====================================================================================================================
# TeamLink AI phone calls - server setup (Ubuntu, run as root). Free software only; the SIP minutes are the only cost.
#
#   bash setup-ai-voice.sh voices     the free voice engines: Piper (speaks), IndicConformer via VEXYL-STT (hears Telugu /
#                                     Hindi), Whisper (hears English, tells the language). Each runs as a service on
#                                     127.0.0.1 only, with a key and a memory cap. Nothing in TeamLink changes.
#   bash setup-ai-voice.sh asterisk   Asterisk (free phone system) + your SIP line, from /root/ai-voice.env.
#                                     SIP port open ONLY to the provider's IPs; manager on 127.0.0.1 only.
#   bash setup-ai-voice.sh status     what is installed and running
#   bash setup-ai-voice.sh stop       stop the voice services (nothing is removed)
#   bash setup-ai-voice.sh enable     start the voice services at every boot (when calls go live)
#
# Then add the lines it prints to backend/.env and restart the backend (pm2). AI_VOICE_PHONE_MODE=Test first: only
# TEST_NUMBERS are called. Safe to run again.
# =====================================================================================================================
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=/opt/ai-voice
ENVF=/root/ai-voice.env
VEXYL_STT_REPO=https://github.com/vexyl-ai/vexyl-stt.git
VEXYL_STT_COMMIT=4f674d94d7156a519f582425ffa673c0b2405060
PIPER_URL=https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
VOICES_URL=https://huggingface.co/rhasspy/piper-voices/resolve/main
KOKORO_URL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
VOICES="te/te_IN/padmavathi/medium/te_IN-padmavathi-medium te/te_IN/venkatesh/medium/te_IN-venkatesh-medium en/en_US/ljspeech/medium/en_US-ljspeech-medium"

say() { printf '\n== %s\n' "$*"; }
need_env() { [ -f "$ENVF" ] || { echo "Missing $ENVF - copy ai-voice.env.example there and fill it in."; exit 1; }; set -a; . "$ENVF"; set +a; }
key() { [ -f "$ROOT/.key" ] || (umask 077; head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40 > "$ROOT/.key"); cat "$ROOT/.key"; }

voices() {
  [ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }
  local MODEL_DIR=$ROOT/models/indic-conformer # copied here from a PC that already has it = no Hugging Face token on this server
  if [ ! -f "$MODEL_DIR/config.json" ] && [ -z "${HF_TOKEN:-}" ]; then
    echo "IndicConformer is not in $MODEL_DIR and HF_TOKEN is empty in $ENVF: copy the model folder here, or set the token."; exit 1
  fi
  local free; free=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  say "free memory: ${free} MB (the four engines need about 4 GB together)"
  [ "$free" -ge 5000 ] || { echo "Not enough free memory now. Stopping so the live site is not slowed."; exit 1; }
  apt-get update -qq && apt-get install -y -qq python3-venv python3-pip git curl ffmpeg >/dev/null
  id aivoice >/dev/null 2>&1 || useradd --system --home "$ROOT" --shell /usr/sbin/nologin aivoice
  mkdir -p "$ROOT/voices" "$ROOT/hf" "$ROOT/kokoro"
  K=$(key)

  say "Piper (MIT) + voices: Telugu padmavathi / venkatesh (CC-BY-4.0, AI4Bharat IndicVoices-R), English ljspeech (public domain)"
  [ -x "$ROOT/piper/piper" ] || curl -fsSL "$PIPER_URL" | tar -xz -C "$ROOT"
  for v in $VOICES; do n=$(basename "$v"); for x in onnx onnx.json; do [ -s "$ROOT/voices/$n.$x" ] || curl -fsSL -o "$ROOT/voices/$n.$x" "$VOICES_URL/$v.$x"; done; done
  echo "Piper test:" && echo 'నమస్తే, నేను టీమ్‌లింక్ AI అసిస్టెంట్.' | "$ROOT/piper/piper" -m "$ROOT/voices/te_IN-padmavathi-medium.onnx" --length_scale 0.75 -f /tmp/ai-voice-test.wav && ls -l /tmp/ai-voice-test.wav

  say "VEXYL-STT (Apache-2.0) with IndicConformer 600M (MIT) - Telugu / Hindi"
  [ -d "$ROOT/vexyl-stt/.git" ] || git clone -q "$VEXYL_STT_REPO" "$ROOT/vexyl-stt"
  git -C "$ROOT/vexyl-stt" checkout -q -- . && git -C "$ROOT/vexyl-stt" checkout -q "$VEXYL_STT_COMMIT"
  # one line: the model comes from VEXYL_STT_MODEL (a local folder) instead of always the Hugging Face name
  sed -i 's|^\(\s*\)"ai4bharat/indic-conformer-600m-multilingual",|\1os.getenv("VEXYL_STT_MODEL", "ai4bharat/indic-conformer-600m-multilingual"),|' "$ROOT/vexyl-stt/vexyl_stt_server.py"
  grep -q 'os.getenv("VEXYL_STT_MODEL"' "$ROOT/vexyl-stt/vexyl_stt_server.py" || { echo "Could not set the local model in vexyl_stt_server.py"; exit 1; }
  [ -x "$ROOT/venv-stt/bin/python" ] || python3 -m venv "$ROOT/venv-stt"
  "$ROOT/venv-stt/bin/pip" install -q torch torchaudio --index-url https://download.pytorch.org/whl/cpu
  "$ROOT/venv-stt/bin/pip" install -q -r "$ROOT/vexyl-stt/requirements.txt"
  {
    echo "VEXYL_STT_HOST=127.0.0.1"; echo "VEXYL_STT_PORT=8091"; echo "PORT=8091"; echo "VEXYL_STT_API_KEY=$K"
    echo "VEXYL_STT_DEVICE=cpu"; echo "VEXYL_STT_MAX_CONN=20"; echo "OMP_NUM_THREADS=2"; echo "HF_HOME=$ROOT/hf"; echo "PYTHONUNBUFFERED=1"
    if [ -f "$MODEL_DIR/config.json" ]; then echo "VEXYL_STT_MODEL=$MODEL_DIR"; echo "HF_HUB_OFFLINE=1"; else echo "HF_TOKEN=$HF_TOKEN"; fi
  } > "$ROOT/stt.env"

  say "Whisper (MIT, faster-whisper) - English + which language"
  [ -x "$ROOT/venv-whisper/bin/python" ] || python3 -m venv "$ROOT/venv-whisper"
  "$ROOT/venv-whisper/bin/pip" install -q faster-whisper
  install -m 644 "$HERE/whisper_server.py" "$ROOT/whisper_server.py"
  cat > "$ROOT/whisper.env" <<EOF
WHISPER_MODEL=base
WHISPER_HOST=127.0.0.1
WHISPER_PORT=8093
WHISPER_API_KEY=$K
WHISPER_THREADS=2
HF_HOME=$ROOT/hf
PYTHONUNBUFFERED=1
EOF

  say "Kokoro (weights Apache-2.0, kokoro-onnx MIT) - Hindi voice"
  [ -x "$ROOT/venv-kokoro/bin/python" ] || python3 -m venv "$ROOT/venv-kokoro"
  "$ROOT/venv-kokoro/bin/pip" install -q kokoro-onnx soundfile
  for f in kokoro-v1.0.int8.onnx voices-v1.0.bin; do [ -s "$ROOT/kokoro/$f" ] || curl -fsSL -o "$ROOT/kokoro/$f" "$KOKORO_URL/$f"; done
  install -m 644 "$HERE/kokoro_server.py" "$ROOT/kokoro_server.py"
  cat > "$ROOT/kokoro.env" <<EOF
KOKORO_MODEL=$ROOT/kokoro/kokoro-v1.0.int8.onnx
KOKORO_VOICES=$ROOT/kokoro/voices-v1.0.bin
KOKORO_HOST=127.0.0.1
KOKORO_PORT=8094
KOKORO_API_KEY=$K
OMP_NUM_THREADS=2
PYTHONUNBUFFERED=1
EOF
  chmod 600 "$ROOT"/*.env; chown -R aivoice:aivoice "$ROOT"

  # services: 127.0.0.1 only, memory and CPU capped so TeamLink always comes first
  unit() { cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=TeamLink AI voice - $1
After=network.target
[Service]
User=aivoice
WorkingDirectory=$2
EnvironmentFile=$3
ExecStart=$4
Restart=on-failure
RestartSec=10
MemoryMax=$5
CPUQuota=200%
Nice=5
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
EOF
  }
  unit ai-voice-stt "$ROOT/vexyl-stt" "$ROOT/stt.env" "$ROOT/venv-stt/bin/python vexyl_stt_server.py" 4G
  unit ai-voice-whisper "$ROOT" "$ROOT/whisper.env" "$ROOT/venv-whisper/bin/python whisper_server.py" 2G
  unit ai-voice-kokoro "$ROOT" "$ROOT/kokoro.env" "$ROOT/venv-kokoro/bin/python kokoro_server.py" 2G
  systemctl daemon-reload
  # started now, NOT switched on at boot: "bash setup-ai-voice.sh enable" does that once calls go live
  systemctl start ai-voice-stt ai-voice-whisper ai-voice-kokoro
  say "started (Whisper downloads its model on the first start). Watch: journalctl -fu ai-voice-stt"
  print_env
}

asterisk_setup() {
  need_env
  mkdir -p "$ROOT"
  local MODE=${SIP_MODE:-gateway}
  if [ "$MODE" = gateway ]; then
    for v in OFFICE_IPS TEST_NUMBERS; do [ -n "${!v:-}" ] || { echo "$v is empty in $ENVF"; exit 1; }; done
    ALLOW_IPS=$OFFICE_IPS
    SIP_USER=teamlink-gw
    SIP_PASS=$( [ -f "$ROOT/.gw" ] && cat "$ROOT/.gw" || (umask 077; head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24 | tee "$ROOT/.gw") )
  else
    for v in SIP_HOST SIP_USER SIP_PASS SIP_PROVIDER_IPS TEST_NUMBERS; do [ -n "${!v:-}" ] || { echo "$v is empty in $ENVF"; exit 1; }; done
    ALLOW_IPS=$SIP_PROVIDER_IPS
  fi
  say "Asterisk (GPL, free) - line: $MODE"
  apt-get update -qq && apt-get install -y -qq asterisk >/dev/null
  asterisk -V
  [ -d /etc/asterisk.orig ] || cp -a /etc/asterisk /etc/asterisk.orig
  local PUB; PUB=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  local AMI_SECRET; AMI_SECRET=$( [ -f "$ROOT/.ami" ] && cat "$ROOT/.ami" || (umask 077; head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 | tee "$ROOT/.ami") )
  local IPS; IPS=$(echo "$ALLOW_IPS" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$')

  # only what we need; the package's sample files (which can be unsafe) are replaced
  cat > /etc/asterisk/pjsip.conf <<EOF
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
external_media_address=$PUB
external_signaling_address=$PUB

[provider-auth]
type=auth
auth_type=userpass
username=$SIP_USER
password=$SIP_PASS
EOF
  if [ "$MODE" = gateway ]; then
    # the SIM gateway in the office registers HERE (it sits behind the office router, so it calls us, not we it)
    # The AOR and endpoint carry its login name (teamlink-gw): its REGISTER has to find them by that name.
    cat >> /etc/asterisk/pjsip.conf <<EOF

[$SIP_USER]
type=aor
max_contacts=1
remove_existing=yes
qualify_frequency=30

[$SIP_USER]
type=endpoint
transport=transport-udp
context=from-provider
disallow=all
allow=alaw,ulaw
auth=provider-auth
aors=$SIP_USER
identify_by=username,auth_username
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes

[provider-acl]
type=acl
deny=0.0.0.0/0.0.0.0
$(echo "$IPS" | sed 's/^/permit=/')
EOF
  else
    cat >> /etc/asterisk/pjsip.conf <<EOF

[provider-reg]
type=registration
outbound_auth=provider-auth
server_uri=sip:$SIP_HOST:${SIP_PORT:-5060}
client_uri=sip:$SIP_USER@$SIP_HOST
retry_interval=60

[provider]
type=aor
contact=sip:$SIP_HOST:${SIP_PORT:-5060}

[provider]
type=endpoint
transport=transport-udp
context=from-provider
disallow=all
allow=alaw,ulaw
outbound_auth=provider-auth
aors=provider
from_user=$SIP_USER
from_domain=$SIP_HOST
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes

[provider-identify]
type=identify
endpoint=provider
$(echo "$IPS" | sed 's/^/match=/')
EOF
  fi
  # incoming calls are not handled yet: hang up (and nothing can dial out from here)
  cat > /etc/asterisk/extensions.conf <<'EOF'
[general]
static=yes
writeprotect=yes
[from-provider]
exten => _X.,1,Hangup()
exten => s,1,Hangup()
EOF
  cat > /etc/asterisk/manager.conf <<EOF
[general]
enabled=yes
port=5038
bindaddr=127.0.0.1
[teamlink]
secret=$AMI_SECRET
deny=0.0.0.0/0.0.0.0
permit=127.0.0.1/255.255.255.255
read=call
write=originate,call
EOF
  cat > /etc/asterisk/rtp.conf <<'EOF'
[general]
rtpstart=10000
rtpend=10200
EOF
  : > /etc/asterisk/sip.conf; : > /etc/asterisk/iax.conf
  chown asterisk:asterisk /etc/asterisk/*.conf 2>/dev/null || true; chmod 640 /etc/asterisk/pjsip.conf /etc/asterisk/manager.conf
  systemctl restart asterisk && sleep 3
  asterisk -rx "module load app_audiosocket.so" >/dev/null 2>&1 || true
  asterisk -rx "module show like audiosocket" | grep -q app_audiosocket || { echo "This Asterisk has no AudioSocket module - it needs Asterisk 18 or newer."; exit 1; }

  say "firewall: SIP + voice ports only from the provider"
  if ufw status | grep -q "Status: active"; then
    for ip in $(echo "$ALLOW_IPS" | tr ',' ' '); do ufw allow from "$ip" to any port 5060 proto udp; ufw allow from "$ip" to any port 10000:10200 proto udp; done
  else
    echo "ufw is not active. NOT switching it on here (it could lock you out). Make sure UDP 5060 and 10000-10200 are open only to: $ALLOW_IPS"
  fi
  if [ "$MODE" = gateway ]; then
    say "type THIS in the gateway's web page (Synway: SIP / SIP Trunk / Register settings), then save:"
    echo "  SIP server / registrar : $PUB   port 5060 (UDP)"
    echo "  register               : yes"
    echo "  username / auth ID     : $SIP_USER"
    echo "  password               : the text in $ROOT/.gw on this server (read it here; do not send it in chat)"
    echo "  codec                  : G.711 A-law and U-law"
    echo "  route                  : calls FROM this SIP server go out through the SIM ports (IP -> GSM / Tel)"
    echo "then check here:  asterisk -rx 'pjsip show contacts'   (the gateway shows up once it is connected)"
  else
    say "SIP line registration:"
    asterisk -rx "pjsip show registrations"
  fi
  print_env "$AMI_SECRET" "$( [ "$MODE" = gateway ] && echo "$SIP_USER" || echo provider )"
}

# The backend settings go to a root-only file, never to the screen (they hold the voice key and the AMI secret).
print_env() {
  local K; K=$(key)
  local OUT="$ROOT/backend.env"
  ( umask 077; print_env_lines "$K" "${1:-}" "${2:-provider}" > "$OUT" )
  say "backend settings written to $OUT (root only, not shown). Add its lines to backend/.env, then: pm2 restart <teamlink backend> --update-env"
  sed 's/=.*//' "$OUT" | tr '
' ' '; echo
}
print_env_lines() {
  local K=$1
  cat <<EOF
AI_VOICE_GATEWAY=1
AI_VOICE_TTS=piper
AI_VOICE_PIPER_EXE=$ROOT/piper/piper
AI_VOICE_PIPER_TELUGU=$ROOT/voices/te_IN-padmavathi-medium.onnx
AI_VOICE_PIPER_ENGLISH=$ROOT/voices/en_US-ljspeech-medium.onnx
AI_VOICE_SPEED=0.75
AI_VOICE_KEY=$K
AI_VOICE_STT_URL=ws://127.0.0.1:8091
AI_VOICE_WHISPER_URL=http://127.0.0.1:8093
AI_VOICE_KOKORO_URL=http://127.0.0.1:8094
EOF
  if [ -n "${2:-}" ]; then cat <<EOF
AI_VOICE_AMI_USER=teamlink
AI_VOICE_AMI_SECRET=$2
AI_VOICE_SIP_TRUNK=$3
AI_VOICE_DIAL_FORMAT=${DIAL_FORMAT:-10}
AI_VOICE_CALLER_ID=${CALLER_ID:-}
AI_VOICE_PHONE_MODE=Test
AI_VOICE_TEST_NUMBERS=$TEST_NUMBERS
EOF
  fi
}

status() {
  for s in ai-voice-stt ai-voice-whisper ai-voice-kokoro asterisk; do printf '%-18s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || true)"; done
  curl -fsS http://127.0.0.1:8093/health 2>/dev/null && echo || echo "whisper: not answering"
  command -v asterisk >/dev/null && asterisk -rx "pjsip show registrations" 2>/dev/null | tail -n +1 || true
  free -m | head -2
}

case "${1:-}" in
  voices) voices ;;
  asterisk) asterisk_setup ;;
  status) status ;;
  stop) systemctl stop ai-voice-stt ai-voice-whisper ai-voice-kokoro ;;
  enable) systemctl enable --now ai-voice-stt ai-voice-whisper ai-voice-kokoro ;;
  *) sed -n '2,16p' "$0" ;;
esac
