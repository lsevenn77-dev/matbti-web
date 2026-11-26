// 사업자 정보 — 여기 한 곳만 고치면 약관·개인정보처리방침·환불정책·사이트 하단에 모두 반영된다.
// 결제 심사 전에 실제 값으로 채운다. 비어 있으면 "(등록 예정)"으로 보인다.
export const BUSINESS = {
  service: '나솔너솔',
  company: '모티브',                                // 상호
  ceo: '이종석',                                    // 대표자
  bizNo: '832-29-01450',                            // 사업자등록번호
  mailOrderNo: '2026-경기안산-1860',                // 통신판매업 신고번호
  address: '경기도 안산시 상록구 구룡체육관로 22 403호', // 사업장 주소
  phone: '070-8098-8730',                           // 고객센터 전화
  email: 'lsevenn88@gmail.com',                     // 고객센터·개인정보 문의 이메일
  privacyOfficer: '이종석 (대표)',                  // 개인정보 보호책임자
  effectiveDate: '2026년 12월 1일', // 약관·방침 시행일
};

const EMPTY = '(등록 예정)';

/** data-biz="키" 가 붙은 곳에 값을 채운다 */
export function fillBusiness(root = document) {
  for (const el of root.querySelectorAll('[data-biz]')) {
    const v = BUSINESS[el.dataset.biz];
    el.textContent = v || EMPTY;
    if (el.tagName === 'A' && v && el.dataset.biz === 'email') el.href = `mailto:${v}`;
  }
}

/** 사이트 하단: 약관 링크 + 사업자 정보 */
export function footerHtml() {
  return `
  <nav class="foot-links">
    <a href="/terms.html">이용약관</a><span>·</span>
    <a href="/privacy.html"><b>개인정보처리방침</b></a><span>·</span>
    <a href="/refund.html">환불정책</a>
  </nav>
  <p class="foot-biz">
    상호 <span data-biz="company"></span> · 대표 <span data-biz="ceo"></span><br />
    사업자등록번호 <span data-biz="bizNo"></span> · 통신판매업 <span data-biz="mailOrderNo"></span><br />
    주소 <span data-biz="address"></span><br />
    고객센터 <span data-biz="phone"></span> · <a data-biz="email"></a>
  </p>`;
}

if (typeof document !== 'undefined') {
  const mount = () => {
    for (const f of document.querySelectorAll('footer.site-foot')) if (!f.children.length) f.innerHTML = footerHtml();
    fillBusiness();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
