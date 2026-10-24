#!/usr/bin/env bash
# Run ON the VPS as root (after copying the 4 files of deploy/vps/ to /root/). Safe to run again.
# It does NOT start the timer: nothing is deployed or pushed until you enable it (see the end of the output).
set -e
mkdir -p /opt/teamlink-sync
install -m 755 /root/teamlink-sync.sh /opt/teamlink-sync/teamlink-sync.sh
install -m 644 /root/teamlink-sync.service /etc/systemd/system/teamlink-sync.service
install -m 644 /root/teamlink-sync.timer /etc/systemd/system/teamlink-sync.timer
KEY=/root/.ssh/teamlink_github_ed25519
if [ ! -f "$KEY" ]; then ssh-keygen -t ed25519 -N '' -C "teamlink-vps-deploy-key" -f "$KEY" >/dev/null; fi
systemctl daemon-reload
echo "Installed. The timer is NOT started."
echo
echo "---- 1. ADD THIS KEY ON GITHUB: repo > Settings > Deploy keys > Add deploy key, tick 'Allow write access' ----"
cat "$KEY.pub"
echo
echo "---- 2. when the repo is private and the PC has pushed main, START it with:  systemctl enable --now teamlink-sync.timer ----"
echo "     watch it:   tail -f /opt/teamlink-sync/sync.log     pause: touch /opt/teamlink-sync/PAUSE"
