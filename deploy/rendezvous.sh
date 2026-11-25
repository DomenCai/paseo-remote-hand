#!/usr/bin/env bash
# Remote hand 会合节点一键部署：在有公网 IP 的 Linux（systemd）服务器上安装 EasyTier，
# 作为直连加速的会合节点运行。只帮两端打洞，关闭数据中继，不转发业务流量。
#
# 用法（root 运行）：
#   curl -fsSL https://raw.githubusercontent.com/DomenCai/paseo-remote-hand/main/deploy/rendezvous.sh | sudo bash
#   sudo bash rendezvous.sh              # 安装或升级；重复运行会保留已有配置
#   sudo bash rendezvous.sh --uninstall  # 停止并删除服务、程序和配置
#
# 可选环境变量（与 sudo 一起用时写成 `sudo PORT=12345 bash rendezvous.sh`）：
#   PORT         监听端口，TCP 和 UDP 共用，默认 11010；只在首次生成配置时生效
#   PUBLIC_HOST  最后打印的会合节点地址；不设时向 api.ipify.org 查询本机公网 IPv4
#
# 版本和 SHA-256 与插件的 server/direct/easytier-release.ts 保持一致，升级时两处一起改。
set -euo pipefail

VERSION=2.6.4
SOURCES=(
  "https://github.com/EasyTier/EasyTier/releases/download"
  "https://dl.fullai.top/easytier"
)
NAME=remote-hand-rendezvous
SERVICE_USER=easytier-rv
INSTALL_DIR=/opt/$NAME
CONFIG_DIR=/etc/$NAME
CONFIG=$CONFIG_DIR/rendezvous.toml
UNIT=/etc/systemd/system/$NAME.service
PORT=${PORT:-11010}

log() { printf '==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root, e.g. with sudo"
[ "$(uname -s)" = Linux ] || die "only Linux is supported"
command -v systemctl >/dev/null || die "systemd is required"

if [ "${1:-}" = "--uninstall" ]; then
  log "Uninstalling $NAME"
  systemctl disable --now "$NAME" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  rm -rf "$INSTALL_DIR" "$CONFIG_DIR"
  id -u "$SERVICE_USER" >/dev/null 2>&1 && userdel "$SERVICE_USER"
  log "Done. Firewall rules for the port were left in place."
  exit 0
fi
[ $# -eq 0 ] || die "unknown argument: $1"

case "$PORT" in
  '' | *[!0-9]*) die "PORT must be a number" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "PORT must be between 1 and 65535"

case "$(uname -m)" in
  x86_64 | amd64)
    TARGET=linux-x86_64
    ZIP_SHA256=61b659eaedba658fa66fe47d17e1426cdd77e5d02fa15fed447bb4357c09dfd6
    CORE_SHA256=35b854e0c5853c02733870488c977200f6aa06d09c08d5dc7f9f9e150e7be8d5
    ;;
  aarch64 | arm64)
    TARGET=linux-aarch64
    ZIP_SHA256=f533ec25a7ea714e09f645615012200278058525795cc3bb690ff011aec1a70f
    CORE_SHA256=7bd504e87cad52edacb9ea84ece7397d0afb911101de623a3dfc4a4dbd9e6bb6
    ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
ZIP=easytier-$TARGET-v$VERSION.zip
MEMBER=easytier-$TARGET/easytier-core

command -v sha256sum >/dev/null || die "sha256sum is required"
if command -v curl >/dev/null; then
  fetch() { curl -fL --progress-bar --connect-timeout 15 --max-time 600 -o "$2" "$1"; }
elif command -v wget >/dev/null; then
  fetch() { wget -q --timeout=15 -O "$2" "$1"; }
else
  die "curl or wget is required"
fi
if command -v unzip >/dev/null; then
  extract() { unzip -p "$1" "$MEMBER" >"$2"; }
elif command -v python3 >/dev/null; then
  extract() { python3 -I -c 'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' "$1" "$MEMBER" >"$2"; }
else
  die "unzip or python3 is required"
fi

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 已安装且校验一致时跳过下载；否则按顺序换源，摘要不符视为该源失败。
if [ -f "$INSTALL_DIR/easytier-core" ] && [ "$(sha256_of "$INSTALL_DIR/easytier-core")" = "$CORE_SHA256" ]; then
  log "EasyTier v$VERSION is already installed"
else
  downloaded=
  for base in "${SOURCES[@]}"; do
    log "Downloading $ZIP from $(printf '%s' "$base" | cut -d/ -f3)"
    if fetch "$base/v$VERSION/$ZIP" "$TMP/$ZIP" && [ "$(sha256_of "$TMP/$ZIP")" = "$ZIP_SHA256" ]; then
      downloaded=1
      break
    fi
    log "Download failed or checksum mismatch, trying next source"
  done
  [ -n "$downloaded" ] || die "could not download a verified $ZIP from any source"
  extract "$TMP/$ZIP" "$TMP/easytier-core"
  [ "$(sha256_of "$TMP/easytier-core")" = "$CORE_SHA256" ] || die "easytier-core checksum mismatch"
  install -d -m 755 "$INSTALL_DIR"
  install -m 755 "$TMP/easytier-core" "$INSTALL_DIR/easytier-core.new"
  mv -f "$INSTALL_DIR/easytier-core.new" "$INSTALL_DIR/easytier-core"
  log "Installed $INSTALL_DIR/easytier-core"
fi

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  nologin=$(command -v nologin || echo /usr/sbin/nologin)
  useradd --system --no-create-home --home-dir / --shell "$nologin" "$SERVICE_USER"
  log "Created system user $SERVICE_USER"
fi

# 配置里的网络名和密钥只属于会合节点自己，与插件的临时网络无关；已有配置不覆盖。
install -d -m 750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"
if [ -f "$CONFIG" ]; then
  log "Keeping existing $CONFIG"
  PORT=$(sed -n 's/.*"udp:\/\/0\.0\.0\.0:\([0-9]*\)".*/\1/p' "$CONFIG" | head -n 1)
  [ -n "$PORT" ] || die "could not read the port from $CONFIG"
else
  random_hex() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
  (
    umask 027
    cat >"$CONFIG" <<EOF
instance_name = "$NAME"
listeners = ["udp://0.0.0.0:$PORT", "tcp://0.0.0.0:$PORT"]

[network_identity]
network_name = "rv-$(random_hex)"
network_secret = "$(random_hex)"

[flags]
no_tun = true
private_mode = false
disable_upnp = true
relay_network_whitelist = ""
relay_all_peer_rpc = true
disable_relay_data = true
EOF
  )
  chown root:"$SERVICE_USER" "$CONFIG"
  chmod 640 "$CONFIG"
  log "Wrote $CONFIG"
fi

# --rpc-portal-whitelist 192.0.2.1/32 是匹配不到任何来源的文档网段，用来拒绝所有管理 RPC。
cat >"$UNIT" <<EOF
[Unit]
Description=Remote hand rendezvous (EasyTier $VERSION)
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
ExecStart=$INSTALL_DIR/easytier-core --config-file $CONFIG --disable-env-parsing --no-tun --relay-network-whitelist --relay-all-peer-rpc --rpc-portal 127.0.0.1:15888 --rpc-portal-whitelist 192.0.2.1/32 --console-log-level warn --file-log-level off
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$NAME" >/dev/null 2>&1
systemctl restart "$NAME"
sleep 3
if ! systemctl is-active --quiet "$NAME"; then
  journalctl -u "$NAME" -n 30 --no-pager >&2 || true
  die "$NAME failed to start"
fi
log "Service $NAME is running"

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow "$PORT/tcp" >/dev/null
  ufw allow "$PORT/udp" >/dev/null
  log "Opened $PORT/tcp and $PORT/udp in ufw"
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT/tcp" --add-port="$PORT/udp" >/dev/null
  firewall-cmd --reload >/dev/null
  log "Opened $PORT/tcp and $PORT/udp in firewalld"
fi

host=${PUBLIC_HOST:-}
if [ -z "$host" ] && command -v curl >/dev/null; then
  host=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
fi
host=${host:-<server-public-address>}

cat <<EOF

Rendezvous node is ready.

1. Make sure your cloud provider's security group allows port $PORT for both TCP and UDP.
2. On BOTH Paseo machines, open Plugins > Remote hand > Direct acceleration (experimental),
   turn it on, add these two rendezvous peers, and save:

     udp://$host:$PORT
     tcp://$host:$PORT

Check status: systemctl status $NAME
Uninstall:    sudo bash rendezvous.sh --uninstall
EOF
