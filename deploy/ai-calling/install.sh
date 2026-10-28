#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------------------------------
# TeamLink self-hosted AI calling - ONE-SHOT INSTALL for the AI / telephony machine (Ubuntu 22.04 or 24.04, run as root).
# Installs: Ollama + qwen2.5:1.5b (yes / no / later labels), Vexyl STT (IndicConformer 600M), Vexyl TTS (Indic Parler-TTS),
# Asterisk with the TeamLink Synway trunk + AudioSocket dialplan (deploy/ai-calling/asterisk/*.conf), as services that start
# on boot. Zero paid AI APIs. Everything listens on 127.0.0.1 only: nothing is opened to the internet.
#
#   sudo ./install.sh [--teamlink-env /opt/teamlink-enterprise/backend/.env] [--synway-ip 192.168.1.20] [--skip-asterisk]
#
#   --teamlink-env   the TeamLink backend's .env on THIS machine: the AI_CALL_* lines are written there (keys never printed).
#                    Without it they go to /root/teamlink-ai-calling.env (mode 600) for you to copy.
#   --synway-ip      the Synway gateway's LAN IP (from its admin page); without it the trunk keeps SYNWAY_LAN_IP to fill in.
#   --skip-asterisk  install only the AI pieces.
#
# The Hugging Face READ token (needed once: the STT model is gated - accept its terms on huggingface.co first) is asked for
# on this screen without echo, or taken from HF_TOKEN. It is used only for the download: it is not written to any file and
# never goes to TeamLink. Re-running the script is safe (it skips what is already there, keeps the existing API keys).
#
# Needs: 16 GB RAM or more (TTS alone takes 4-6 GB on CPU), ~15 GB free disk, internet for the downloads. An NVIDIA GPU is used
# when nvidia-smi works. The TeamLink backend must run on THIS machine or the same private network (it refuses to send call
# audio anywhere else; the dialplan points AudioSocket at 127.0.0.1:9092).
# ---------------------------------------------------------------------------------------------------------------------
set -euo pipefail

TEAMLINK_ENV=""; SYNWAY_IP=""; SKIP_ASTERISK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --teamlink-env) TEAMLINK_ENV="$2"; shift 2 ;;
    --synway-ip) SYNWAY_IP="$2"; shift 2 ;;
    --skip-asterisk) SKIP_ASTERISK=1; shift ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE=/opt/vexyl
STT_DIR="$BASE/vexyl-stt"; TTS_DIR="$BASE/vexyl-tts"
STT_PORT=8090; TTS_PORT=8092; AUDIOSOCKET_PORT=9092
MODEL=qwen2.5:1.5b
say() { printf '\n==> %s\n' "$*"; }
warn() { printf '\n!!  %s\n' "$*"; }

[ "$(id -u)" = "0" ] || { echo "Run as root: sudo $0"; exit 1; }
command -v apt-get >/dev/null || { echo "This script is for Ubuntu / Debian (apt)."; exit 1; }

# ---- 0. the machine ------------------------------------------------------------------------------------------------
RAM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
DISK_GB=$(df -Pk /opt | awk 'NR==2 {printf "%d", $4/1024/1024}')
say "Machine: ${RAM_GB} GB RAM, ${DISK_GB} GB free on /opt"
[ "$RAM_GB" -ge 14 ] || warn "Less than 16 GB RAM: Vexyl TTS + STT may not both fit. Continuing, but expect slow or failed starts."
[ "$DISK_GB" -ge 15 ] || { echo "Need about 15 GB free on /opt for the models."; exit 1; }
GPU=0; if command -v nvidia-smi >/dev/null && nvidia-smi >/dev/null 2>&1; then GPU=1; say "NVIDIA GPU found: CUDA builds will be used."; fi

# ---- 1. packages -----------------------------------------------------------------------------------------------------
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl openssl python3 python3-venv python3-pip libsndfile1 ffmpeg
if [ "$SKIP_ASTERISK" = "0" ]; then apt-get install -y asterisk; fi

id vexyl >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --create-home --shell /usr/sbin/nologin vexyl
mkdir -p "$BASE"; chown vexyl:vexyl "$BASE"

# ---- 2. Ollama + the model -------------------------------------------------------------------------------------------
if ! command -v ollama >/dev/null; then
  say "Installing Ollama (ollama.com official installer)"
  curl -fsSL https://ollama.com/install.sh | sh
fi
systemctl enable --now ollama >/dev/null 2>&1 || true
for i in $(seq 1 30); do curl -fs http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done
say "Pulling $MODEL (about 1 GB)"
ollama pull "$MODEL"

# ---- 3. the Hugging Face token (asked once, kept only in memory) -------------------------------------------------------
if [ -z "${HF_TOKEN:-}" ] && [ ! -f "$STT_DIR/.model-ok" ]; then
  echo
  echo "Vexyl STT downloads the gated model ai4bharat/indic-conformer-600m-multilingual."
  echo "Accept its terms on huggingface.co with your account, then paste a READ token here (it is not shown and not saved)."
  read -rsp "Hugging Face read token: " HF_TOKEN; echo
fi

TORCH_INDEX=https://download.pytorch.org/whl/cpu
[ "$GPU" = "1" ] && TORCH_INDEX=https://download.pytorch.org/whl/cu121
key_of() { # keep the key an earlier run made, else a new random one
  local f="$1" name="$2"
  if [ -f "$f" ] && grep -q "^${name}=" "$f"; then grep "^${name}=" "$f" | head -1 | cut -d= -f2-; else openssl rand -hex 32; fi
}

# ---- 4. Vexyl STT ----------------------------------------------------------------------------------------------------
say "Vexyl STT (github.com/vexyl-ai/vexyl-stt, Apache-2.0)"
[ -d "$STT_DIR/.git" ] || sudo -u vexyl -H git clone --depth 1 https://github.com/vexyl-ai/vexyl-stt "$STT_DIR"
STT_KEY=$(key_of "$STT_DIR/.env" VEXYL_STT_API_KEY)
sudo -u vexyl -H bash -c "cd '$STT_DIR' && [ -d venv ] || python3 -m venv venv"
sudo -u vexyl -H bash -c "cd '$STT_DIR' && . venv/bin/activate && pip install --upgrade pip -q && pip install -q torch torchaudio --index-url '$TORCH_INDEX' && pip install -q transformers websockets numpy onnxruntime soundfile huggingface_hub"
if [ ! -f "$STT_DIR/.model-ok" ]; then
  say "Downloading the STT model (about 3 GB with its files)"
  sudo -u vexyl -H env HF_TOKEN="${HF_TOKEN:-}" bash -c "cd '$STT_DIR' && . venv/bin/activate && python3 -c \"from transformers import AutoModel; AutoModel.from_pretrained('ai4bharat/indic-conformer-600m-multilingual', trust_remote_code=True)\""
  sudo -u vexyl touch "$STT_DIR/.model-ok"
fi
cat > "$STT_DIR/.env" <<EOF
VEXYL_STT_HOST=127.0.0.1
VEXYL_STT_PORT=$STT_PORT
VEXYL_STT_DEVICE=auto
VEXYL_STT_DECODE=ctc
VEXYL_STT_API_KEY=$STT_KEY
EOF
chown vexyl:vexyl "$STT_DIR/.env"; chmod 600 "$STT_DIR/.env"

# ---- 5. Vexyl TTS ----------------------------------------------------------------------------------------------------
say "Vexyl TTS (github.com/vexyl-ai/vexyl-tts, Apache-2.0)"
[ -d "$TTS_DIR/.git" ] || sudo -u vexyl -H git clone --depth 1 https://github.com/vexyl-ai/vexyl-tts "$TTS_DIR"
TTS_KEY=$(key_of "$TTS_DIR/.env" VEXYL_TTS_API_KEY)
sudo -u vexyl -H bash -c "cd '$TTS_DIR' && [ -d venv ] || python3 -m venv venv"
sudo -u vexyl -H bash -c "cd '$TTS_DIR' && . venv/bin/activate && pip install --upgrade pip -q && pip install -q torch --index-url '$TORCH_INDEX' && pip install -q git+https://github.com/huggingface/parler-tts.git && pip install -q transformers websockets numpy soundfile"
if [ ! -f "$TTS_DIR/.model-ok" ]; then
  say "Downloading the TTS model (about 6 GB with its files)"
  sudo -u vexyl -H bash -c "cd '$TTS_DIR' && . venv/bin/activate && python3 -c \"from parler_tts import ParlerTTSForConditionalGeneration; from transformers import AutoTokenizer; ParlerTTSForConditionalGeneration.from_pretrained('ai4bharat/indic-parler-tts'); AutoTokenizer.from_pretrained('ai4bharat/indic-parler-tts')\""
  sudo -u vexyl touch "$TTS_DIR/.model-ok"
fi
cat > "$TTS_DIR/.env" <<EOF
VEXYL_TTS_HOST=127.0.0.1
VEXYL_TTS_PORT=$TTS_PORT
VEXYL_TTS_DEVICE=auto
VEXYL_TTS_SAMPLE_RATE=8000
VEXYL_TTS_API_KEY=$TTS_KEY
EOF
chown vexyl:vexyl "$TTS_DIR/.env"; chmod 600 "$TTS_DIR/.env"
unset HF_TOKEN

# ---- 6. services (start on boot, restart on failure; the models are read from the local cache, offline) ----------------
for svc in stt tts; do
  dir="$BASE/vexyl-$svc"
  cat > "/etc/systemd/system/vexyl-$svc.service" <<EOF
[Unit]
Description=Vexyl $svc server for TeamLink AI calling (127.0.0.1 only)
After=network.target

[Service]
User=vexyl
WorkingDirectory=$dir
EnvironmentFile=$dir/.env
Environment=HF_HUB_OFFLINE=1
ExecStart=$dir/venv/bin/python3 vexyl_${svc}_server.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
done
systemctl daemon-reload
systemctl enable --now vexyl-stt vexyl-tts
say "Waiting for the speech servers to load their models (can take a few minutes on CPU)"
for port in $STT_PORT $TTS_PORT; do
  ok=0; for i in $(seq 1 120); do if curl -fs "http://127.0.0.1:$port/health" >/dev/null; then ok=1; break; fi; sleep 5; done
  [ "$ok" = "1" ] && echo "   port $port: healthy" || warn "port $port did not answer /health yet - see: journalctl -u vexyl-$([ $port = $STT_PORT ] && echo stt || echo tts) -n 50"
done

# ---- 7. Asterisk -----------------------------------------------------------------------------------------------------
if [ "$SKIP_ASTERISK" = "0" ]; then
  say "Asterisk: Synway trunk + TeamLink dialplan"
  install -m 644 "$HERE/asterisk/pjsip_synway.conf" /etc/asterisk/pjsip_synway.conf
  install -m 644 "$HERE/asterisk/extensions_teamlink.conf" /etc/asterisk/extensions_teamlink.conf
  [ -n "$SYNWAY_IP" ] && sed -i "s/SYNWAY_LAN_IP/$SYNWAY_IP/g" /etc/asterisk/pjsip_synway.conf
  grep -q 'pjsip_synway.conf' /etc/asterisk/pjsip.conf 2>/dev/null || echo '#include pjsip_synway.conf' >> /etc/asterisk/pjsip.conf
  grep -q 'extensions_teamlink.conf' /etc/asterisk/extensions.conf 2>/dev/null || echo '#include extensions_teamlink.conf' >> /etc/asterisk/extensions.conf
  # The AMI user TeamLink logs in with (calling/local/ami.js): reads the setup, receives call events, may Originate. Local only.
  AMI_SECRET=$(grep -s '^secret' /etc/asterisk/manager.d/teamlink.conf | head -1 | sed 's/^secret *= *//')
  [ -n "$AMI_SECRET" ] || AMI_SECRET=$(openssl rand -hex 24)
  mkdir -p /etc/asterisk/manager.d
  umask 077
  cat > /etc/asterisk/manager.d/teamlink.conf <<EOF
[teamlink]
secret = $AMI_SECRET
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = system,call,reporting,config,dialplan
write = originate,system
EOF
  umask 022
  chown asterisk:asterisk /etc/asterisk/manager.d/teamlink.conf 2>/dev/null || true
  if ! grep -q '^enabled *= *yes' /etc/asterisk/manager.conf 2>/dev/null; then
    cp -p /etc/asterisk/manager.conf "/etc/asterisk/manager.conf.before-teamlink.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
    printf '[general]\nenabled = yes\nport = 5038\nbindaddr = 127.0.0.1\n\n#include manager.d/*.conf\n' > /etc/asterisk/manager.conf
  elif ! grep -q 'manager.d' /etc/asterisk/manager.conf; then
    echo '#include manager.d/*.conf' >> /etc/asterisk/manager.conf
  fi
  systemctl enable --now asterisk
  sleep 3
  asterisk -rx "manager reload" >/dev/null 2>&1 || true
  asterisk -rx "module load res_audiosocket.so" >/dev/null 2>&1 || true
  asterisk -rx "module load app_audiosocket.so" >/dev/null 2>&1 || true
  asterisk -rx "pjsip reload" >/dev/null 2>&1 || true
  asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
  if asterisk -rx "module show like audiosocket" 2>/dev/null | grep -q audiosocket; then echo "   AudioSocket modules: loaded"; else warn "This Asterisk has no AudioSocket module (needs Asterisk 18+ with res_audiosocket / app_audiosocket)."; fi
  [ -n "$SYNWAY_IP" ] || warn "Synway IP not given: edit /etc/asterisk/pjsip_synway.conf (SYNWAY_LAN_IP), then: asterisk -rx 'pjsip reload'"
fi

# ---- 8. TeamLink backend settings --------------------------------------------------------------------------------------
LINES="AI_CALL_OLLAMA_URL=http://127.0.0.1:11434
AI_CALL_OLLAMA_MODEL=$MODEL
AI_CALL_STT_URL=ws://127.0.0.1:$STT_PORT
AI_CALL_STT_KEY=$STT_KEY
AI_CALL_TTS_URL=ws://127.0.0.1:$TTS_PORT
AI_CALL_TTS_KEY=$TTS_KEY
AI_CALL_AUDIOSOCKET_PORT=$AUDIOSOCKET_PORT
AI_CALL_AUDIOSOCKET_HOST=127.0.0.1"
if [ -n "$TEAMLINK_ENV" ] && [ -f "$TEAMLINK_ENV" ]; then
  cp -p "$TEAMLINK_ENV" "$TEAMLINK_ENV.before-ai-calling.$(date +%Y%m%d%H%M%S)"
  echo "$LINES" | while IFS= read -r l; do
    k="${l%%=*}"
    if grep -q "^${k}=" "$TEAMLINK_ENV"; then sed -i "s|^${k}=.*|${l}|" "$TEAMLINK_ENV"; else echo "$l" >> "$TEAMLINK_ENV"; fi
  done
  say "TeamLink settings written to $TEAMLINK_ENV (a backup was kept). Restart the TeamLink backend, then run:"
  echo "   cd $(dirname "$TEAMLINK_ENV") && node scripts/ai-calling-local-check.js"
else
  umask 077; echo "$LINES" > /root/teamlink-ai-calling.env
  [ -n "${AMI_SECRET:-}" ] && printf '\n# Admin > Integrations > AI Calling > Self-hosted (Synway): Asterisk server 127.0.0.1, AMI port 5038, user teamlink, secret:\n# %s\n' "$AMI_SECRET" >> /root/teamlink-ai-calling.env
  say "TeamLink settings saved to /root/teamlink-ai-calling.env (mode 600). Copy these lines into the TeamLink backend .env"
  echo "   on the machine that runs TeamLink (it must be this machine or the same private network), restart it, then run"
  echo "   node scripts/ai-calling-local-check.js  (it places NO call)."
fi
say "Done. No call has been placed. The first test call goes only to the founder's own number, with his OK."
