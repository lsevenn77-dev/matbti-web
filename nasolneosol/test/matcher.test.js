import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageAccepts, compatible, formGroup, needFor } from '../server/matcher.js';
import { validateProfile } from '../server/store.js';

const slots = { male: 6, female: 6 };
let n = 0;
const P = (gender, age, ageUp = 40, ageDown = 40) => ({ userId: `u${++n}`, gender, profile: { gender, age, ageUp, ageDown } });

test('나이 범위: 위로·아래로', () => {
  const a = { age: 30, ageUp: 3, ageDown: 2 };
  assert.ok(ageAccepts(a, { age: 33 }));
  assert.ok(!ageAccepts(a, { age: 34 }));
  assert.ok(ageAccepts(a, { age: 28 }));
  assert.ok(!ageAccepts(a, { age: 27 }));
  assert.ok(ageAccepts({ age: 30 }, { age: 70 })); // 조건 없는 예전 회원은 상관없음
  // 서로 맞아야 같은 방
  assert.ok(!compatible({ gender: 'male', age: 30, ageUp: 10, ageDown: 10 }, { gender: 'female', age: 35, ageUp: 0, ageDown: 2 }));
  assert.ok(compatible({ gender: 'male', age: 30, ageUp: 0, ageDown: 0 }, { gender: 'male', age: 50, ageUp: 0, ageDown: 0 })); // 동성은 무관
});

test('조건이 안 맞는 사람은 건너뛰고, 맞는 12명이 모이면 방이 된다', () => {
  const q = [];
  for (let i = 0; i < 6; i++) q.push(P('male', 30, 5, 5));
  q.push(P('female', 45, 3, 3)); // 남자들과 안 맞음
  for (let i = 0; i < 5; i++) q.push(P('female', 28, 5, 5));
  assert.equal(formGroup(q, slots), null);
  const me = q[0];
  assert.deepEqual({ male: needFor(q, slots, me).male, female: needFor(q, slots, me).female }, { male: 0, female: 1 });
  // 45세 여성 본인 기준: 맞는 남자가 없어 남자 6명이 더 필요
  assert.equal(needFor(q, slots, q[6]).male, 6);
  q.push(P('female', 31, 5, 5));
  const g = formGroup(q, slots);
  assert.equal(g.length, 12);
  assert.ok(!g.includes(q[6]));
});

test('생년월일: 만 19세 미만 가입 불가(한국 날짜 기준), 이상한 날짜 거부, 가입 후 수정 불가', async () => {
  const { validateBirthDate, ageFromBirthDate } = await import('../server/store.js');
  const now = Date.parse('2026-11-28T12:00:00+09:00');
  assert.equal(ageFromBirthDate('2007-11-28', now), 19); // 오늘 만 19세 생일
  assert.equal(ageFromBirthDate('2007-11-29', now), 18); // 내일 생일
  assert.equal(validateBirthDate('2007-11-28', { minAge: 19, now }).age, 19);
  assert.throws(() => validateBirthDate('2007-11-29', { minAge: 19, now }), /만 19세 이상/);
  // 한국 자정 직후: UTC로는 아직 전날이어도 한국 날짜로 생일이 지났으면 19세
  assert.equal(ageFromBirthDate('2007-11-28', Date.parse('2026-11-28T00:30:00+09:00')), 19);
  for (const bad of ['', '2000-02-30', '2000/01/01', '1899-01-01', '2030-01-01', 'abc']) assert.throws(() => validateBirthDate(bad, { minAge: 19, now }), undefined, bad);
  assert.throws(() => validateProfile({ gender: 'male', job: 'x', region: 'y' }, { minAge: 19 }), /생년월일/);
  assert.throws(() => validateProfile({ age: 25 }, { minAge: 19, partial: true }), /바꿀 수 없어/);
  assert.throws(() => validateProfile({ birthDate: '1990-01-01' }, { minAge: 19, partial: true }), /바꿀 수 없어/);
  assert.equal(validateProfile({ job: '개발자' }, { minAge: 19, partial: true }).job, '개발자');
});

test('가입: 나이 조건 검사 (비우면 40 = 상관없음)', () => {
  const base = { gender: 'male', birthDate: '1995-06-15', job: 'x', region: 'y' };
  assert.equal(validateProfile(base, { minAge: 19 }).ageUp, 40);
  assert.equal(validateProfile({ ...base, ageUp: 3, ageDown: 0 }, { minAge: 19 }).ageDown, 0);
  assert.throws(() => validateProfile({ ...base, ageUp: 41 }, { minAge: 19 }));
  assert.throws(() => validateProfile({ ...base, ageDown: -1 }, { minAge: 19 }));
});

test('입장권: 하루 무료 1회 → 월정액 3회 → 회차권, 한국 자정에 초기화', async () => {
  const { entryStatus, consumeEntry, grantProduct, kstDay } = await import('../server/wallet.js');
  const u = { id: 'x' };
  const t0 = Date.parse('2026-11-26T10:00:00+09:00');
  assert.equal(entryStatus(u, t0).total, 1);
  assert.equal(consumeEntry(u, t0), 'free');
  assert.equal(consumeEntry(u, t0), null);
  grantProduct(u, 't5', t0);
  grantProduct(u, 'sub30', t0);
  assert.equal(entryStatus(u, t0).total, 3 + 5);
  for (let i = 0; i < 3; i++) assert.equal(consumeEntry(u, t0), 'sub');
  assert.equal(consumeEntry(u, t0), 'ticket');
  assert.equal(entryStatus(u, t0).tickets, 4);
  // 다음날 (한국 시간 자정 지나서)
  const t1 = Date.parse('2026-11-27T00:05:00+09:00');
  assert.notEqual(kstDay(t0), kstDay(t1));
  assert.equal(entryStatus(u, t1).total, 1 + 3 + 4);
  // 월정액 30일 뒤 만료, 다시 사면 이어서 연장
  const t31 = t0 + 31 * 86400_000;
  assert.equal(entryStatus(u, t31).subActive, false);
  grantProduct(u, 'sub30', t0 + 10 * 86400_000);
  assert.ok(u.wallet.subUntil > t0 + 59 * 86400_000);
});

test('간편 로그인: 다른 앱용 토큰·서명이 틀린 토큰은 거부', async () => {
  const { verifyJwt } = await import('../server/social.js');
  const { generateKeyPairSync, createSign } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', kty: 'RSA' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const make = (payload) => {
    const h = enc({ alg: 'RS256', kid: 'k1' });
    const b = enc(payload);
    return `${h}.${b}.${createSign('RSA-SHA256').update(`${h}.${b}`).sign(privateKey).toString('base64url')}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const opts = { jwksUrl: 'https://test/jwks', audiences: ['my-app'], issuers: ['https://accounts.google.com'] };
  try {
    const ok = await verifyJwt(make({ iss: 'https://accounts.google.com', aud: 'my-app', sub: '42', iat: now, exp: now + 600 }), opts);
    assert.equal(ok.sub, '42');
    await assert.rejects(verifyJwt(make({ iss: 'https://accounts.google.com', aud: 'other-app', sub: '42', iat: now, exp: now + 600 }), opts));
    await assert.rejects(verifyJwt(make({ iss: 'https://accounts.google.com', aud: 'my-app', sub: '42', iat: now - 7200, exp: now - 3600 }), opts));
    const t = make({ iss: 'https://accounts.google.com', aud: 'my-app', sub: '42', iat: now, exp: now + 600 });
    await assert.rejects(verifyJwt(t.slice(0, -4) + 'AAAA', opts));
  } finally {
    globalThis.fetch = realFetch;
  }
});
