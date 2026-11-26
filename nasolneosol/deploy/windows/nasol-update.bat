@echo off
chcp 65001 >nul
echo ==============================================
echo  나솔너솔 서버 업데이트
echo  비밀번호를 물어보면 서버 root 비밀번호를 입력하고 Enter
echo  (입력해도 화면에 글자가 안 보이는 게 정상)
echo ==============================================
ssh -o StrictHostKeyChecking=accept-new root@1.234.63.187 "curl -fsSL https://raw.githubusercontent.com/lsevenn77-dev/matbti-web/claude/modest-clarke-uuqbr9/nasolneosol/deploy/install.sh?v=%RANDOM% | bash"
echo.
echo 끝났어. 아무 키나 누르면 창이 닫혀.
pause >nul
