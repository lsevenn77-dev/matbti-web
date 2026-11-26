// 결제: 나이스페이먼츠(NICEPAY Start API) + 개발용 모의 결제
// 흐름: 서버가 주문(orderId·금액)을 만든다 → 브라우저가 나이스페이 결제창을 띄운다 → 인증 결과가 returnUrl 로 POST 된다
//       → 서버가 금액을 다시 확인하고 승인 API 를 호출한다 → 승인되면 그때 상품을 지급한다.
// 금액은 항상 서버의 주문에서 가져온다 (브라우저가 보낸 금액을 믿지 않는다).
// [확인 필요] 실제 가맹 키를 받으면 샌드박스에서 결제 → 승인 → 취소까지 한 번씩 확인할 것.
// 월정액은 지금은 30일권(자동 갱신 없음). 매달 자동결제는 나이스페이 빌링(정기결제) 계약 후 추가.

import { randomBytes } from 'node:crypto';

export function payConfig(env) {
  const live = env.NICEPAY_MODE === 'live';
  return {
    clientKey: env.NICEPAY_CLIENT_KEY || '',
    secretKey: env.NICEPAY_SECRET_KEY || '',
    apiBase: live ? 'https://api.nicepay.co.kr' : 'https://sandbox-api.nicepay.co.kr',
    jsUrl: 'https://pay.nicepay.co.kr/v1/js/',
    live,
  };
}

export const newOrderId = () => `nsns_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;

/** 나이스페이 승인 API. 성공 시 응답 JSON, 실패 시 예외 */
export async function niceApprove(cfg, tid, amount) {
  const auth = Buffer.from(`${cfg.clientKey}:${cfg.secretKey}`).toString('base64');
  const r = await fetch(`${cfg.apiBase}/v1/payments/${encodeURIComponent(tid)}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.resultCode !== '0000' || (j.status && j.status !== 'paid')) {
    throw new Error(`결제 승인 실패 (${j.resultCode ?? r.status} ${j.resultMsg ?? ''})`.trim());
  }
  if (Number(j.amount) !== Number(amount)) throw new Error('승인 금액이 주문과 다르다');
  return j;
}
