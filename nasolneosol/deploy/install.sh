#!/usr/bin/env bash
# 나솔너솔 시제품 서버 설치 (리눅스 서버에서 root 로 실행)
#   curl -fsSL https://raw.githubusercontent.com/lsevenn77-dev/matbti-web/claude/modest-clarke-uuqbr9/nasolneosol/deploy/install.sh | bash
#
# 하는 일: Node.js 20 설치(없으면) → 코드 받기/갱신 → 패키지 설치 → systemd 서비스로 상시 실행 → 방화벽 포트 열기
# 다시 실행하면 최신 코드로 갱신하고 재시작한다.
set -euo pipefail

REPO="https://github.com/lsevenn77-dev/matbti-web.git"
BRANCH="${BRANCH:-claude/modest-clarke-uuqbr9}"
DIR="${DIR:-/opt/nasolneosol-src}"
PORT="${PORT:-8080}"
TIME_SCALE="${TIME_SCALE:-1}"    # 정상 속도. 개발 중 빨리 돌리기는 게임 화면 위 버튼(DEV_TOOLS=1)
DEV_TOOLS="${DEV_TOOLS:-1}"      # 1 이면 봇 채우기·빨리 돌리기·다음 단계 버튼 사용 가능
DATA_DIR="${DATA_DIR:-/var/lib/nasolneosol}"

[ "$(id -u)" = "0" ] || { echo "root 로 실행해 줘 (sudo -i 후 다시 실행)"; exit 1; }

say() { echo -e "\n\033[1;33m▶ $*\033[0m"; }

pm=""
if command -v apt-get >/dev/null; then pm=apt; elif command -v dnf >/dev/null; then pm=dnf; elif command -v yum >/dev/null; then pm=yum; fi

say "기본 도구 설치 (git, curl, tar, xz)"
case "$pm" in
  apt) apt-get update -y >/dev/null && apt-get install -y git curl ca-certificates tar xz-utils >/dev/null ;;
  dnf) dnf install -y git curl ca-certificates tar xz >/dev/null ;;
  yum) yum install -y git curl ca-certificates tar xz >/dev/null ;;
  *) echo "apt/dnf/yum 을 찾지 못했어. git, curl 을 직접 설치한 뒤 다시 실행해 줘"; ;;
esac

need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 20 ] && need_node=0
fi

if [ "$need_node" = 1 ]; then
  say "Node.js 20 설치"
  glibc=$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+$' || echo 0)
  arch=$(uname -m); [ "$arch" = "x86_64" ] && arch=x64; [ "$arch" = "aarch64" ] && arch=arm64
  NV=v20.18.1
  if awk "BEGIN{exit !($glibc < 2.28)}"; then
    # CentOS 7 등 오래된 glibc: 공식 빌드가 안 돌아가서 glibc 2.17 용 비공식 빌드 사용
    url="https://unofficial-builds.nodejs.org/download/release/$NV/node-$NV-linux-$arch-glibc-217.tar.xz"
  else
    url="https://nodejs.org/dist/$NV/node-$NV-linux-$arch.tar.xz"
  fi
  echo "  $url"
  mkdir -p /opt/node && curl -fsSL "$url" | tar -xJ -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
fi
NODE_BIN=$(command -v node)
echo "  node $(node -v)"

say "코드 받기 ($BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q --depth 1 origin "$BRANCH"
  git -C "$DIR" reset -q --hard FETCH_HEAD
else
  git clone -q --depth 1 -b "$BRANCH" "$REPO" "$DIR"
fi
git -C "$DIR" log --oneline -1

say "패키지 설치"
cd "$DIR/nasolneosol"
npm install --omit=dev --no-audit --no-fund >/dev/null
mkdir -p "$DATA_DIR"

say "서비스 등록 (부팅 시 자동 실행, 꺼지면 자동 재시작)"
cat > /etc/systemd/system/nasolneosol.service <<EOF
[Unit]
Description=Nasolneosol prototype server
After=network.target

[Service]
WorkingDirectory=$DIR/nasolneosol
ExecStart=$NODE_BIN server/index.js
Environment=PORT=$PORT
Environment=TIME_SCALE=$TIME_SCALE
Environment=DEV_TOOLS=$DEV_TOOLS
Environment=DATA_DIR=$DATA_DIR
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable nasolneosol >/dev/null 2>&1
systemctl restart nasolneosol
sleep 2
systemctl --no-pager --lines=3 status nasolneosol | head -5 || true

say "자동 업데이트 켜기 (2분마다 새 버전 확인, 게임 중이면 끝난 뒤 적용)"
if [ "${AUTO_UPDATE:-1}" = "1" ]; then
  cat > /etc/systemd/system/nasolneosol-update.service <<EOF
[Unit]
Description=Nasolneosol auto update
After=network-online.target

[Service]
Type=oneshot
Environment=DIR=$DIR
Environment=BRANCH=$BRANCH
Environment=PORT=$PORT
ExecStart=/bin/bash $DIR/nasolneosol/deploy/auto-update.sh
EOF
  cat > /etc/systemd/system/nasolneosol-update.timer <<EOF
[Unit]
Description=Nasolneosol auto update every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now nasolneosol-update.timer >/dev/null 2>&1
  echo "  켜짐 (로그: journalctl -u nasolneosol-update -n 20, 끄기: systemctl disable --now nasolneosol-update.timer)"
else
  systemctl disable --now nasolneosol-update.timer >/dev/null 2>&1 || true
  echo "  꺼짐 (AUTO_UPDATE=0)"
fi

say "방화벽 포트 $PORT 열기"
if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port=$PORT/tcp >/dev/null && firewall-cmd --reload >/dev/null && echo "  firewalld 열림"
elif command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow $PORT/tcp >/dev/null && echo "  ufw 열림"
elif command -v iptables >/dev/null && iptables -L INPUT -n 2>/dev/null | grep -qE "REJECT|DROP"; then
  iptables -I INPUT -p tcp --dport $PORT -j ACCEPT && echo "  iptables 열림 (재부팅 시 초기화될 수 있음)"
else
  echo "  서버 자체 방화벽은 없음"
fi

ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/info" >/dev/null; then
  say "완료! 브라우저에서 열기:  http://$ip:$PORT"
  echo "  (안 열리면 카페24 관리 화면의 '방화벽 서비스'에서 TCP $PORT 포트를 허용해 줘)"
else
  say "서버가 응답하지 않아. 로그 확인: journalctl -u nasolneosol -n 50"
fi
