// 입장권·월정액
// - 하루 1회 무료 (한국 시간 자정에 초기화)
// - 월정액: 30일 동안 하루 3회 (무료 1회와 별도)
// - 회차권: 1회권 / 5회권, 기한 없음
// 사용 순서: 오늘 무료 → 월정액 → 회차권. 방이 실제로 시작될 때 1회 쓴다 (대기만 하다 취소하면 안 씀).

export const PRODUCTS = {
  t1: { id: 't1', name: '입장권 1회', krw: 1000, tickets: 1 },
  t5: { id: 't5', name: '입장권 5회', krw: 4000, tickets: 5 },
  sub30: { id: 'sub30', name: '월정액 30일 (하루 3회)', krw: 9000, subDays: 30 },
};
export const FREE_PER_DAY = 1;
export const SUB_PER_DAY = 3;
const DAY = 24 * 60 * 60 * 1000;

/** 한국 시간 기준 날짜 'YYYY-MM-DD' */
export function kstDay(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function walletOf(user) {
  user.wallet ??= { tickets: 0, subUntil: 0, freeDay: null, freeUsed: 0, subDay: null, subUsed: 0 };
  return user.wallet;
}

export function entryStatus(user, now = Date.now()) {
  if (user.isBot) return { free: 1, subLeft: 0, subActive: false, subUntil: 0, tickets: 0, total: 1 };
  const w = walletOf(user);
  const today = kstDay(now);
  const free = Math.max(0, FREE_PER_DAY - (w.freeDay === today ? w.freeUsed : 0));
  const subActive = w.subUntil > now;
  const subLeft = subActive ? Math.max(0, SUB_PER_DAY - (w.subDay === today ? w.subUsed : 0)) : 0;
  return { free, subLeft, subActive, subUntil: w.subUntil, tickets: w.tickets, total: free + subLeft + w.tickets };
}

export function canEnter(user, now = Date.now()) {
  return entryStatus(user, now).total > 0;
}

/** 1회 사용. 무엇을 썼는지 돌려준다 ('free' | 'sub' | 'ticket' | null) */
export function consumeEntry(user, now = Date.now()) {
  if (user.isBot) return 'bot';
  const s = entryStatus(user, now);
  const w = walletOf(user);
  const today = kstDay(now);
  if (s.free > 0) {
    if (w.freeDay !== today) {
      w.freeDay = today;
      w.freeUsed = 0;
    }
    w.freeUsed++;
    return 'free';
  }
  if (s.subLeft > 0) {
    if (w.subDay !== today) {
      w.subDay = today;
      w.subUsed = 0;
    }
    w.subUsed++;
    return 'sub';
  }
  if (w.tickets > 0) {
    w.tickets--;
    return 'ticket';
  }
  return null;
}

/** 방이 열리지 못하고 사라졌을 때 되돌려 주기 */
export function refundEntry(user, kind, now = Date.now()) {
  const w = walletOf(user);
  const today = kstDay(now);
  if (kind === 'free' && w.freeDay === today) w.freeUsed = Math.max(0, w.freeUsed - 1);
  if (kind === 'sub' && w.subDay === today) w.subUsed = Math.max(0, w.subUsed - 1);
  if (kind === 'ticket') w.tickets++;
}

/** 결제 완료 → 상품 지급 */
export function grantProduct(user, productId, now = Date.now()) {
  const p = PRODUCTS[productId];
  if (!p) throw new Error('알 수 없는 상품');
  const w = walletOf(user);
  if (p.tickets) w.tickets += p.tickets;
  if (p.subDays) w.subUntil = Math.max(now, w.subUntil) + p.subDays * DAY;
  return w;
}
