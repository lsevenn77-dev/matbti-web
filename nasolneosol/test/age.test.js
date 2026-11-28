import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from '../server/index.js';

// 1x1 PNG
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ADMIN_KEY = 'k'.repeat(32);

async function setup() {
  const app = createServer({ dataDir: null, env: { DEV_TOOLS: '0', ADMIN_KEY } });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (token, path, body, method) => {
    const r = await fetch(base + path, { method: method ?? (body ? 'POST' : 'GET'), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const admin = async (path, body) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-admin-key': ADMIN_KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { app, port, call, admin };
}
const signupBody = (extra = {}) => ({ gender: 'male', job: '개발자', region: '서울', photo: PHOTO, birthDate: '1995-06-15', adultConsent: true, ...extra });

test('가입: 생년월일 필수 · 만 19세 미만 차단 · 성인 확인 동의 필수 · 나이는 생년월일로', async () => {
  const { app, call } = await setup();
  try {
    assert.match((await call(null, '/api/signup', signupBody({ birthDate: '' }))).body.error, /생년월일/);
    const young = new Date(Date.now() + 9 * 3600e3);
    const y18 = `${young.getUTCFullYear() - 18}-01-01`;
    assert.match((await call(null, '/api/signup', signupBody({ birthDate: y18 }))).body.error, /만 19세 이상/);
    assert.match((await call(null, '/api/signup', signupBody({ adultConsent: false }))).body.error, /동의/);
    // 나이를 따로 보내도 생년월일로 계산한 나이가 쓰인다
    const ok = await call(null, '/api/signup', signupBody({ age: 50 }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.me.profile.birthDate, '1995-06-15');
    assert.ok(ok.body.me.profile.age >= 30 && ok.body.me.profile.age <= 32);
    assert.equal(ok.body.me.needBirthDate, false);
    const u = app.store.byToken(ok.body.token);
    assert.ok(u.adultConsentAt > 0);
    // 가입 후 생년월일·나이는 못 바꾼다 (다른 항목은 된다)
    assert.equal((await call(ok.body.token, '/api/me', { age: 22 }, 'PUT')).status, 400);
    assert.equal((await call(ok.body.token, '/api/me', { birthDate: '2000-01-01' }, 'PUT')).status, 400);
    assert.equal((await call(ok.body.token, '/api/me/birthdate', { birthDate: '2000-01-01', adultConsent: true })).status, 409);
    const edit = await call(ok.body.token, '/api/me', { job: '디자이너' }, 'PUT');
    assert.equal(edit.status, 200);
    assert.equal(edit.body.profile.birthDate, '1995-06-15');
  } finally {
    app.close();
  }
});

test('예전 회원: 생년월일이 없으면 게임 입장 전에 한 번 입력 (동의 필수, 미성년 차단)', async () => {
  const { app, port, call } = await setup();
  try {
    const old = app.store.createUser({ gender: 'male', age: 30, ageUp: 40, ageDown: 40, job: 'a', region: 'b', photoUrl: '/x' });
    assert.equal((await call(old.token, '/api/me')).body.needBirthDate, true);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'hello', token: old.token }));
    await new Promise((r) => setTimeout(r, 80));
    ws.send(JSON.stringify({ t: 'queue.join' }));
    await new Promise((r) => setTimeout(r, 80));
    const err = msgs.find((m) => m.t === 'queueError');
    assert.ok(err?.needBirthDate);
    ws.close();
    assert.equal((await call(old.token, '/api/me/birthdate', { birthDate: '1990-03-03' })).status, 400); // 동의 없음
    assert.equal((await call(old.token, '/api/me/birthdate', { birthDate: '2015-03-03', adultConsent: true })).status, 400); // 미성년
    const r = await call(old.token, '/api/me/birthdate', { birthDate: '1990-03-03', adultConsent: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.needBirthDate, false);
    assert.equal(r.body.profile.birthDate, '1990-03-03');
    assert.equal((await call(old.token, '/api/me/birthdate', { birthDate: '1991-03-03', adultConsent: true })).status, 409); // 한 번만
  } finally {
    app.close();
  }
});

test('신고: 미성년자 의심 사유 · 자동 제재 없음 · 운영자가 대상 또는 허위 신고자를 정지하고 이력이 남는다', async () => {
  const { app, call, admin } = await setup();
  try {
    const mk = (g) => app.store.createUser({ birthDate: '1995-06-15', gender: g, age: 30, ageUp: 40, ageDown: 40, job: 'a', region: 'b', photoUrl: '/x' });
    const a = mk('male');
    const x = mk('female');
    app.rel.recordGame({ roomId: 'r', people: [{ userId: a.id, alias: '영수' }, { userId: x.id, alias: '영숙' }], couples: [] });
    const reasons = (await call(a.token, '/api/report/reasons')).body;
    assert.equal(reasons.minor, '미성년자 의심 · 나이 허위 등록');
    assert.equal((await call(a.token, '/api/report', { userId: x.id, reason: 'minor', context: 'met' })).status, 200);
    assert.equal(x.ban, undefined); // 접수만으로는 제재하지 않는다
    const list = (await admin('/api/admin/reports')).body;
    const rep = list.find((r) => r.reason === 'minor');
    assert.ok(rep);
    assert.equal(rep.targetCard.birthDate, '1995-06-15');
    // 운영자 판단: 허위 신고 → 신고자 정지
    const r = await admin('/api/admin/ban', { userId: a.id, days: 7, reason: '허위 신고', reportId: rep.id, about: 'reporter' });
    assert.equal(r.status, 200);
    assert.equal(a.sanctions.at(-1).about, 'reporter');
    assert.equal(a.sanctions.at(-1).reportId, rep.id);
    const after = app.reports.list.find((z) => z.id === rep.id);
    assert.equal(after.status, 'dismissed');
    assert.match(after.action, /허위 신고/);
    await admin('/api/admin/unban', { userId: a.id });
    assert.equal(a.ban, undefined);
    assert.deepEqual(a.sanctions.map((s) => s.action), ['ban', 'unban']); // 해제해도 이력은 남는다
  } finally {
    app.close();
  }
});
