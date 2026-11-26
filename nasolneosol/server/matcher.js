// 대기열 매칭: 선착순 + 나이 조건
// 각자 "내 나이보다 위로 ageUp 살, 아래로 ageDown 살까지" 를 적는다.
// 한 방 안의 남녀는 서로가 서로의 범위 안에 있어야 한다 (모든 이성 쌍이 양방향으로 OK).
// 같은 성별끼리는 나이 조건을 보지 않는다.

const NO_LIMIT = 99;

/** a 가 b 의 나이를 받아들이는지 */
export function ageAccepts(a, b) {
  const up = Number.isInteger(a.ageUp) ? a.ageUp : NO_LIMIT;
  const down = Number.isInteger(a.ageDown) ? a.ageDown : NO_LIMIT;
  return b.age <= a.age + up && b.age >= a.age - down;
}

/** 두 사람이 같은 방에 있어도 되는지 (이성이면 서로 나이 범위 안) */
export function compatible(a, b) {
  if (a.gender === b.gender) return true;
  return ageAccepts(a, b) && ageAccepts(b, a);
}

/**
 * 동반 입장: 같은 partyId 를 가진 사람들은 한 덩어리로 묶는다 (모두 들어가거나 모두 빠진다).
 * 덩어리 순서는 그 안에서 가장 먼저 온 사람 기준.
 */
export function unitsOf(entries) {
  const byKey = new Map();
  const units = [];
  for (const e of entries) {
    const k = e.partyId ? `p:${e.partyId}` : `u:${e.userId}`;
    let u = byKey.get(k);
    if (!u) {
      u = [];
      byKey.set(k, u);
      units.push(u);
    }
    u.push(e);
  }
  return units;
}

/**
 * anchor 를 반드시 넣고, 나머지는 도착 순서대로 조건이 맞으면 채운다. 동반 입장 일행은 함께 들어간다.
 * @param {Array<{userId:string, gender:'male'|'female', partyId?:string, profile:{age:number, ageUp?:number, ageDown?:number, gender:string}}>} entries 도착 순
 */
export function buildGroup(entries, slots, anchor = null) {
  const chosen = [];
  const cnt = { male: 0, female: 0 };
  const tryAdd = (unit) => {
    const need = { male: 0, female: 0 };
    for (const e of unit) need[e.gender]++;
    if (cnt.male + need.male > slots.male || cnt.female + need.female > slots.female) return;
    for (const e of unit) {
      if (!chosen.every((c) => compatible(c.profile, e.profile))) return;
      if (!unit.every((o) => o === e || compatible(o.profile, e.profile))) return;
    }
    for (const e of unit) {
      chosen.push(e);
      cnt[e.gender]++;
    }
  };
  const units = unitsOf(entries);
  const anchorUnit = anchor ? units.find((u) => u.some((e) => e.userId === anchor.userId)) ?? [anchor] : null;
  if (anchorUnit) tryAdd(anchorUnit);
  for (const u of units) if (u !== anchorUnit) tryAdd(u);
  return { chosen, cnt, full: cnt.male >= slots.male && cnt.female >= slots.female };
}

/** 방을 만들 수 있으면 그 12명을, 아니면 null. 먼저 온 사람을 우선한다 */
export function formGroup(entries, slots) {
  for (const unit of unitsOf(entries)) {
    const g = buildGroup(entries, slots, unit[0]);
    if (g.full) return g.chosen;
  }
  return null;
}

/** 이 사람 기준으로 시작까지 몇 명 더 필요한지 (나이 조건이 맞는 사람만 센다) */
export function needFor(entries, slots, me) {
  const g = buildGroup(entries, slots, me);
  return { male: slots.male - g.cnt.male, female: slots.female - g.cnt.female, matched: g.cnt };
}
