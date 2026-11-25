#!/usr/bin/env bash
# 나솔너솔: 도메인 + HTTPS 연결 (install.sh 로 서버를 먼저 설치한 뒤 root 로 실행)
#   curl -fsSL https://raw.githubusercontent.com/lsevenn77-dev/matbti-web/claude/modest-clarke-uuqbr9/nasolneosol/deploy/https.sh | DOMAIN=nasol.dasi-on.co.kr bash
#
# 하는 일: Caddy(웹서버) 설치 → https://DOMAIN 을 내부 8080 포트로 연결 → 인증서(Let's Encrypt) 자동 발급·갱신
# 다시 실행해도 안전하다.
set -euo pipefail

DOMAIN="${DOMAIN:-nasol.dasi-on.co.kr}"
PORT="${PORT:-8080}"
CADDY_VER="${CADDY_VER:-2.8.4}"

[ "$(id -u)" = "0" ] || { echo "root 로 실행해 줘"; exit 1; }
say() { echo -e "\n\033[1;33m▶ $*\033[0m"; }

say "도메인 확인: $DOMAIN"
myip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
dnsip=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)
echo "  이 서버 IP: ${myip:-알 수 없음} / $DOMAIN → ${dnsip:-아직 연결 안 됨}"
if [ -z "$dnsip" ] || { [ -n "$myip" ] && [ "$dnsip" != "$myip" ]; }; then
  echo "  도메인이 아직 이 서버를 가리키지 않아. 카페24 DNS 관리에서 A 레코드를 추가하고"
  echo "  몇 분(최대 몇 시간) 뒤에 다시 실행해 줘. (인증서 발급 실패를 막으려고 여기서 멈춤)"
  exit 1
fi

say "80/443 포트를 쓰는 다른 웹서버 확인"
for svc in httpd apache2 nginx; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    if [ "${STOP_WEB:-0}" = 1 ]; then
      echo "  $svc 끄는 중 (STOP_WEB=1)"; systemctl stop "$svc"; systemctl disable "$svc" >/dev/null 2>&1 || true
    else
      echo "  $svc 가 80/443 포트를 쓰고 있어. 이 서버에서 다른 사이트를 운영 중이면 알려 줘."
      echo "  다른 사이트가 없다면 명령 앞에 STOP_WEB=1 을 붙여 다시 실행하면 끄고 진행해."
      exit 1
    fi
  fi
done

if ! /usr/local/bin/caddy version 2>/dev/null | grep -q "v$CADDY_VER"; then
  say "Caddy $CADDY_VER 설치"
  arch=$(uname -m); [ "$arch" = "x86_64" ] && arch=amd64; [ "$arch" = "aarch64" ] && arch=arm64
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VER/caddy_${CADDY_VER}_linux_$arch.tar.gz" | tar -xz -C "$tmp" caddy
  install -m 755 "$tmp/caddy" /usr/local/bin/caddy
  rm -rf "$tmp"
fi
/usr/local/bin/caddy version

say "설정 작성"
mkdir -p /etc/caddy /var/lib/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy (HTTPS for nasolneosol)
After=network-online.target
Wants=network-online.target

[Service]
Environment=XDG_DATA_HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

say "방화벽 80, 443 열기"
if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null && firewall-cmd --reload >/dev/null && echo "  firewalld 열림"
elif command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; echo "  ufw 열림"
elif command -v iptables >/dev/null && iptables -L INPUT -n 2>/dev/null | grep -qE "REJECT|DROP"; then
  iptables -I INPUT -p tcp --dport 80 -j ACCEPT; iptables -I INPUT -p tcp --dport 443 -j ACCEPT; echo "  iptables 열림"
else
  echo "  서버 자체 방화벽은 없음"
fi

systemctl daemon-reload
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

say "인증서 발급 기다리는 중 (최대 60초)"
ok=0
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/info" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ "$ok" = 1 ]; then
  say "완료! https://$DOMAIN"
else
  say "아직 https 응답이 없어. 로그: journalctl -u caddy -n 50"
  echo "  흔한 원인: 카페24 '방화벽 서비스'에서 TCP 80, 443 이 막혀 있음 → 허용 후 systemctl restart caddy"
fi
