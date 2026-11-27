#!/usr/bin/env bash
# 나솔너솔 자동 업데이트: 브랜치에 새 커밋이 있으면 받아서 재시작한다 (systemd 타이머가 2분마다 실행)
# 사람이 들어 있는 게임이 진행 중이면 기다렸다가 끝난 뒤 적용한다.
set -euo pipefail
DIR="${DIR:-/opt/nasolneosol-src}"
BRANCH="${BRANCH:-claude/modest-clarke-uuqbr9}"
PORT="${PORT:-8080}"
cd "$DIR"
git fetch -q --depth 1 origin "$BRANCH"
new=$(git rev-parse FETCH_HEAD)
cur=$(git rev-parse HEAD)
[ "$new" = "$cur" ] && exit 0
# In managed mode the operator drains all nodes before the updater can proceed.
# Missing status also defers the update, preserving games that may reconnect.
if ! info=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/info"); then
  echo "게임 상태 조회 실패, 업데이트 보류"
  exit 0
fi
if ! node -e '
  const fs = require("node:fs");
  const info = JSON.parse(fs.readFileSync(0, "utf8"));
  process.exit(info.activeRooms === 0 && (info.updateSafe === undefined || info.updateSafe === true) ? 0 : 1);
' <<< "$info"; then
  echo "게임 종료 및 점검 완료 대기 중"
  exit 0
fi
old_pkg=$(git show HEAD:nasolneosol/package.json 2>/dev/null | md5sum)
git reset -q --hard FETCH_HEAD
new_pkg=$(md5sum < nasolneosol/package.json)
if [ "$old_pkg" != "$new_pkg" ]; then
  (cd nasolneosol && npm install --omit=dev --no-audit --no-fund >/dev/null)
fi
systemctl restart nasolneosol
echo "업데이트 완료: ${cur:0:7} → ${new:0:7}"
