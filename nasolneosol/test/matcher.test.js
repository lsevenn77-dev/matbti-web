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

test('가입: 나이 조건 검사 (비우면 40 = 상관없음)', () => {
  const base = { gender: 'male', age: 30, job: 'x', region: 'y' };
  assert.equal(validateProfile(base, { minAge: 19 }).ageUp, 40);
  assert.equal(validateProfile({ ...base, ageUp: 3, ageDown: 0 }, { minAge: 19 }).ageDown, 0);
  assert.throws(() => validateProfile({ ...base, ageUp: 41 }, { minAge: 19 }));
  assert.throws(() => validateProfile({ ...base, ageDown: -1 }, { minAge: 19 }));
});
