# 간편 로그인 · 나이스페이 결제 설정

키는 서버의 `/etc/nasolneosol.env` 에만 적는다 (권한 600, 깃·채팅에 올리지 않는다).
값을 바꾼 뒤 `systemctl restart nasolneosol`. 비어 있는 항목의 기능은 화면에 나타나지 않는다.

```
nano /etc/nasolneosol.env
systemctl restart nasolneosol
```

## 구글 (사이그램 구글 프로젝트 재사용 가능)
1. Google Cloud Console → API 및 서비스 → 사용자 인증 정보
2. **웹 애플리케이션** 유형 OAuth 클라이언트 (사이그램 서버용 웹 클라이언트를 같이 써도 되고 새로 만들어도 됨)
3. 승인된 JavaScript 원본에 `https://nasol.dasi-on.co.kr` 추가
4. `GOOGLE_OAUTH_CLIENT_IDS=<클라이언트 ID>.apps.googleusercontent.com`
- 사이그램 프로젝트를 쓰면 로그인 창에 앱 이름이 "사이그램"으로 보인다. 정식 출시 전에는 나솔너솔용 프로젝트를 따로 만드는 것을 권장.
- 동의 화면이 "테스트" 상태면 등록한 테스트 사용자만 로그인된다.

## 카카오 (사이그램 앱 ID 1567877 재사용 가능)
1. developers.kakao.com → 내 애플리케이션 → 앱 설정 → 플랫폼 → **Web** 사이트 도메인에 `https://nasol.dasi-on.co.kr`
2. 카카오 로그인 → 활성화 ON, **Redirect URI** 에 `https://nasol.dasi-on.co.kr/auth/kakao/callback`
3. 앱 키의 **REST API 키** → `KAKAO_REST_API_KEY`, 앱 ID → `KAKAO_APP_ID`
4. (보안 → Client Secret 을 켰다면) `KAKAO_CLIENT_SECRET`
- 회원번호만 쓴다. 이메일·전화번호 동의 항목은 필요 없다.

## Apple
1. Apple Developer → Identifiers → **Services ID** 생성 (예: `kr.dasion.nasol.web`), Sign in with Apple 켜기
2. Domains: `nasol.dasi-on.co.kr`, Return URLs: `https://nasol.dasi-on.co.kr/`
3. `APPLE_SIGN_IN_AUDIENCES=<Services ID>`
- 사이그램은 애플 로그인이 미완성 상태였다. 웹용 Services ID 는 새로 만들어야 한다.

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
