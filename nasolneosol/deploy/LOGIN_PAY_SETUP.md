# 간편 로그인 · 나이스페이 결제 설정

키는 서버의 `/etc/nasolneosol.env` 에만 적는다 (권한 600, 깃·채팅에 올리지 않는다).
값을 바꾼 뒤 `systemctl restart nasolneosol`. 비어 있는 항목의 기능은 화면에 나타나지 않는다.

```
nano /etc/nasolneosol.env
systemctl restart nasolneosol
```

로그인 창에 "나솔너솔" 이름이 보이도록 세 곳 모두 **나솔너솔 전용**으로 설정돼 있다 (2026-11-26).
사이그램 것과 섞지 않는다. 바꾸면 그동안 가입한 사람의 계정 연결이 끊긴다.

## 구글 — 프로젝트 `advance-seer-463713-b0` (콘솔 이름 "My First Project")
- 프로젝트 개수 한도 때문에 새 프로젝트 대신 비어 있던 이 프로젝트를 썼다.
- 브랜딩: 앱 이름 나솔너솔, 홈페이지·`/privacy.html`·`/terms.html` 링크, 승인된 도메인 `dasi-on.co.kr`
- 대상: 외부, **프로덕션** (기본 로그인 범위만 써서 심사 없음. 로고를 올리면 브랜드 확인 심사가 필요해진다)
- 클라이언트: 웹 "Nasolneosol Web", 승인된 JavaScript 원본 `https://nasol.dasi-on.co.kr`
- `GOOGLE_OAUTH_CLIENT_IDS=<그 클라이언트 ID>`

## 카카오 — 앱 "나솔너솔" (ID 1667926)
1. 카카오 로그인 → 사용 설정 ON
2. 앱 → 플랫폼 키 → REST API 키 → 수정 → **카카오 로그인 리다이렉트 URI** 에 `https://nasol.dasi-on.co.kr/auth/kakao/callback`
3. 같은 화면의 REST API 키 → `KAKAO_REST_API_KEY`, 클라이언트 시크릿(카카오 로그인) → `KAKAO_CLIENT_SECRET`, 앱 ID → `KAKAO_APP_ID=1667926`
- 회원번호만 쓴다. 이메일·전화번호 동의 항목은 필요 없다.
- 서버는 REST 방식만 써서 JavaScript 키의 웹 도메인은 필요 없다.

## Apple — Services ID `kr.dasion.nasol.web`
1. App ID `kr.dasion.nasol` (이름 Nasolneosol, Sign in with Apple 켬)을 기본 앱(Primary App ID)으로 묶었다
2. Domains: `nasol.dasi-on.co.kr`, Return URLs: `https://nasol.dasi-on.co.kr/`
3. `APPLE_SIGN_IN_AUDIENCES=kr.dasion.nasol.web`
- 애플은 이름을 영문만 받아서 동의 화면에 "Nasolneosol"로 보인다. 웹 전용이라 아이콘은 애플 기본 아이콘이다.

## 사업자 정보·약관
- 약관 `/terms.html`, 개인정보처리방침 `/privacy.html`, 환불정책 `/refund.html`
- 상호·대표·사업자번호·통신판매업 번호·주소·연락처는 `client/public/legal/business.js` 한 곳만 채우면 모든 페이지와 사이트 하단에 반영된다.

## 나이스페이 (NICEPAY Start API)
1. 나이스페이 가입·심사 후 개발자 페이지에서 **클라이언트 키 / 시크릿 키** 확인 (심사 전에는 샌드박스 키)
2. `NICEPAY_CLIENT_KEY`, `NICEPAY_SECRET_KEY`, 시험 중에는 `NICEPAY_MODE=sandbox`, 실결제는 `live`
3. 결제 결과 주소: `https://nasol.dasi-on.co.kr/pay/nice/return` (서버가 자동으로 넘김)
- 결제 승인은 서버가 주문 금액으로 다시 확인한 뒤 한다. 브라우저가 보낸 금액은 믿지 않는다.
- 월정액은 지금 **30일권(자동 갱신 없음)**. 매달 자동결제는 나이스페이 **빌링(정기결제)** 계약 후 추가.
- 실결제 전에 샌드박스에서 결제 → 승인 → 취소를 한 번씩 확인할 것. (이 코드는 실제 나이스페이와 아직 맞춰 보지 못했다)

## 상품 (server/wallet.js)
| 상품 | 가격 | 내용 |
|---|---|---|
| 무료 | 0원 | 하루 1회 (한국 시간 자정 초기화) |
| t1 | 1,000원 | 입장권 1회 |
| t5 | 4,000원 | 입장권 5회 |
| sub30 | 9,000원 | 30일 동안 하루 3회 (무료 1회와 별도) |

사용 순서: 오늘 무료 → 월정액 → 회차권. 대기열에 들어갈 때가 아니라 **방이 시작될 때** 1회 사용.
실결제(나이스페이 키가 있을 때)는 간편 로그인 계정을 연결한 사람만 할 수 있다 (입장권이 기기와 함께 사라지지 않게).
