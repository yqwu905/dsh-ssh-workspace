#!/bin/sh
# Create a disposable two-server SSH lab on this machine (Linux, run as root):
#   web1 -> user alice on 127.0.0.1:2201 (workspace ~/proj)
#   db1  -> user bob   on 127.0.0.1:2202
# and a DSH_HOME with sdk test profiles that load dsh-ssh-fleet.
#
# Usage: test/lab/setup-sshd.sh <lab-dir>
# Then:  export DSH_HOME=<lab-dir>/dshhome FLEET_LAB=<lab-dir>; npm run test:e2e
set -eu
LAB=${1:?usage: setup-sshd.sh <lab-dir>}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$LAB" && cd "$LAB" && LAB=$(pwd)

for u in alice bob; do
  id "$u" >/dev/null 2>&1 || useradd -m -s /bin/bash "$u"
  usermod -p '*' "$u"
done
[ -f client_key ] || ssh-keygen -q -t ed25519 -N '' -f client_key
for u in alice bob; do
  h=$(getent passwd "$u" | cut -d: -f6)
  mkdir -p "$h/.ssh"; cp client_key.pub "$h/.ssh/authorized_keys"
  chown -R "$u:$u" "$h/.ssh"; chmod 700 "$h/.ssh"; chmod 600 "$h/.ssh/authorized_keys"
done
mkdir -p /home/alice/proj && chown alice:alice /home/alice/proj

mkdir -p /run/sshd
: > known_hosts
for p in 2201 2202; do
  [ -f "hostkey_$p" ] || ssh-keygen -q -t ed25519 -N '' -f "hostkey_$p"
  cat > "sshd_$p.conf" <<EOF
Port $p
ListenAddress 127.0.0.1
HostKey $LAB/hostkey_$p
PidFile $LAB/sshd_$p.pid
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowTcpForwarding yes
UsePAM no
StrictModes no
EOF
  # Stop any earlier lab server on this port (possibly from another lab dir).
  pkill -f "sshd -f .*/sshd_$p.conf" 2>/dev/null || true
  sleep 0.3
  /usr/sbin/sshd -f "$LAB/sshd_$p.conf" -E "$LAB/sshd_$p.log"
  echo "[127.0.0.1]:$p $(cut -d' ' -f1,2 "hostkey_$p.pub")" >> known_hosts
done

cat > ssh_config <<EOF
Host web1
  HostName 127.0.0.1
  Port 2201
  User alice
  IdentityFile $LAB/client_key
  UserKnownHostsFile $LAB/known_hosts
  StrictHostKeyChecking yes
Host db1
  HostName 127.0.0.1
  Port 2202
  User bob
  IdentityFile $LAB/client_key
  UserKnownHostsFile $LAB/known_hosts
  StrictHostKeyChecking yes
EOF
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/config"
grep -q "Include $LAB/ssh_config" "$HOME/.ssh/config" || {
  { echo "Include $LAB/ssh_config"; cat "$HOME/.ssh/config"; } > "$HOME/.ssh/config.new"
  mv "$HOME/.ssh/config.new" "$HOME/.ssh/config"; chmod 600 "$HOME/.ssh/config"
}
ssh -o BatchMode=yes web1 true
ssh -o BatchMode=yes db1 true

export DSH_HOME="$LAB/dshhome"
mkdir -p "$DSH_HOME/ssh-fleet"
cat > "$DSH_HOME/ssh-fleet/hosts.json" <<'EOF'
{ "hosts": [
  { "id": "web1", "host": "web1", "workspace": "~/proj", "description": "lab server A", "proxy": true },
  { "id": "db1", "host": "db1", "description": "lab server B" },
  { "id": "ghost", "host": "127.0.0.1", "port": 2299, "user": "nobody", "description": "unreachable" }
] }
EOF
mkdir -p "$DSH_HOME/skills/hello-fleet/scripts"
cat > "$DSH_HOME/skills/hello-fleet/SKILL.md" <<'EOF'
---
name: hello-fleet
description: Test skill that prints where its script runs.
---
Run `sh scripts/hello.sh` from this skill's directory.
EOF
printf '#!/bin/sh\necho "hello-fleet v1 as $(whoami)"\n' > "$DSH_HOME/skills/hello-fleet/scripts/hello.sh"

(cd /tmp && dsh --profile fleet-e2e --from-default-profile sdk --help >/dev/null 2>&1 || true)
(cd /tmp && dsh plugin --profile fleet-e2e add "$ROOT" >/dev/null)
(cd /tmp && dsh plugin --profile fleet-e2e add "$ROOT/test/fixtures/command-bridge" >/dev/null)
grep -q "llm-api.fleet" /etc/hosts || echo "127.0.0.1 llm-api.fleet" >> /etc/hosts
cat > "$DSH_HOME/profiles/fleet-e2e/cordis.patch.yml" <<'EOF'
- id: ssh-fleet
  config:
    proxy:
      allow: ['llm-api.fleet']
      allowPrivate: true
EOF
echo "lab ready: export DSH_HOME=$DSH_HOME FLEET_LAB=$LAB"
