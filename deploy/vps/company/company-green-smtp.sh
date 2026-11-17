#!/usr/bin/env bash
# ============================================================================
# COMPANY GREEN START MAILBOX - puts the company's OWN sending mailbox into its Green Start settings (docs/second-company.md section 12).
#
#   bash company-green-smtp.sh --key nish            asks for the mailbox details, tests the login, saves them
#   bash company-green-smtp.sh --key nish --check    only says which settings are filled in (never shows a value)
#
# WHY: Green Start e-mails sign-up codes, password resets and invitations, so as a real server it refuses to start without a mailbox (SMTP) of its own.
# TeamLink's mailbox is never used or copied. YOU type the details here, in this server terminal: the password is typed hidden, is never printed, is
# not stored anywhere except the company's own settings file (mode 640, only root and the Green Start user can read it), and never goes into a chat.
# ============================================================================
set -uo pipefail
KEY=""; CHECK=0
while [ $# -gt 0 ]; do case "$1" in --key) KEY=${2:-}; shift ;; --check) CHECK=1 ;; *) echo "unknown option $1"; exit 2 ;; esac; shift; done
[[ "$KEY" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "usage: company-green-smtp.sh --key <key> [--check]"; exit 2; }
ROOT=/opt/company-$KEY; G=$ROOT/green; ENVF=$G/config/gs-api.env
fail() { echo "STOPPED: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root"
[ -f "$ENVF" ] || fail "$ENVF not found: run company-green-install.sh --stage prepare --apply first"
genv() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | sed -E 's/^"(.*)"$/\1/'; }

if [ $CHECK = 1 ]; then
  for k in SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM; do if [ -n "$(genv $k)" ]; then echo "$k: filled in"; else echo "$k: EMPTY"; fi; done
  exit 0
fi

echo "The company's own sending mailbox for Green Start ($KEY)."
echo "Use a mailbox that belongs to the company (not TeamLink's). Nothing you type here is shown again or sent anywhere except to that mail server for a login test."
echo
read -r -p "Mail server (SMTP host, for example smtp.office365.com): " HOST
read -r -p "Port [587]: " PORT; PORT=${PORT:-587}
read -r -p "Mailbox login (usually the full e-mail address): " MUSER
read -r -s -p "Mailbox password (typing is hidden): " MPASS; echo
read -r -p "Send e-mails from this address [$MUSER]: " MFROM; MFROM=${MFROM:-$MUSER}
read -r -p "Name people see as the sender [Green Start]: " MNAME; MNAME=${MNAME:-Green Start}
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "the port must be a number"
[ -n "$HOST" ] && [ -n "$MUSER" ] && [ -n "$MPASS" ] && [ -n "$MFROM" ] || fail "host, login, password and from-address are all needed"
case "$HOST$MUSER$MFROM$MNAME" in *[[:space:]]*) [ "$HOST" = "${HOST//[[:space:]]/}" ] || fail "the host must not contain spaces";; esac
[[ "$MFROM" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "the from-address does not look like an e-mail address"
case "$MPASS" in *$'\n'*|*$'\r'*) fail "the password must be on one line";; esac
SECURE=false; [ "$PORT" = 465 ] && SECURE=true

echo; echo "Testing the login (no e-mail is sent) ..."
RES=$(cd "$G/gs-api" && SMTP_H="$HOST" SMTP_P="$PORT" SMTP_S="$SECURE" SMTP_U="$MUSER" SMTP_W="$MPASS" runuser -u greenstart -- env -i PATH="$PATH" HOME="$G" SMTP_H="$HOST" SMTP_P="$PORT" SMTP_S="$SECURE" SMTP_U="$MUSER" SMTP_W="$MPASS" node -e '
const nodemailer = require("nodemailer");
const t = nodemailer.createTransport({ host: process.env.SMTP_H, port: Number(process.env.SMTP_P), secure: process.env.SMTP_S === "true", auth: { user: process.env.SMTP_U, pass: process.env.SMTP_W }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
t.verify().then(() => console.log("OK")).catch((e) => console.log("FAIL: " + String(e.message || e).split("\n")[0].replace(process.env.SMTP_W, "***").slice(0, 160)));' 2>&1 | tail -1)
echo "Result: $RES"
if [ "${RES:0:2}" != "OK" ]; then
  read -r -p "The mail server did not accept this login. Save it anyway? [y/N] " A
  [ "$A" = y ] || [ "$A" = Y ] || fail "nothing was saved"
fi

SMTP_H="$HOST" SMTP_P="$PORT" SMTP_S="$SECURE" SMTP_U="$MUSER" SMTP_W="$MPASS" SMTP_F="$MFROM" SMTP_N="$MNAME" ENVF="$ENVF" node -e '
const fs = require("fs");
const q = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
const set = { SMTP_HOST: q(process.env.SMTP_H), SMTP_PORT: process.env.SMTP_P, SMTP_SECURE: process.env.SMTP_S, SMTP_USER: q(process.env.SMTP_U), SMTP_PASS: q(process.env.SMTP_W), SMTP_FROM: q(process.env.SMTP_F), SMTP_FROM_NAME: q(process.env.SMTP_N) };
let lines = fs.readFileSync(process.env.ENVF, "utf8").split("\n");
for (const [k, v] of Object.entries(set)) {
  const i = lines.findIndex((l) => l.startsWith(k + "="));
  if (i >= 0) lines[i] = `${k}=${v}`; else lines.splice(lines.findIndex((l) => l.startsWith("SMTP_FROM=")) + 1 || lines.length, 0, `${k}=${v}`);
}
fs.writeFileSync(process.env.ENVF, lines.join("\n"));' || fail "could not write the settings"
chown root:greenstart "$ENVF"; chmod 640 "$ENVF"
unset MPASS
echo "Saved. (Values are not shown.)"
for k in SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM; do if [ -n "$(genv $k)" ]; then echo "  $k: filled in"; else echo "  $k: EMPTY"; fi; done
echo
echo "Next: bash $(dirname "$0")/company-green-install.sh --key $KEY --domain <the company's Omni-Channel address> --stage start --apply"
