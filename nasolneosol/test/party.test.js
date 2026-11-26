import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { formGroup, needFor } from '../server/matcher.js';
import { createServer } from '../server/index.js';

const slots = { male: 6, female: 6 };
let n = 0;
const P = (gender, age = 30, extra = {}) => ({ userId: `q${++n}`, gender, profile: { gender, age, ageUp: 40, ageDown: 40 }, ...extra });

test('동반 입장 일행은 함께 들어가거나 함께 빠진다', () => {
  // 남자 자리가 1개 남았을 때 2명 일행은 들어가지 못하고 뒤 사람이 들어간다
  const q = [];
  for (let i = 0; i < 5; i++) q.push(P('male'));
  q.push(P('male', 30, { partyId: 'A' }), P('male', 30, { partyId: 'A' }));
  const solo = P('male');
  q.push(solo);
  for (let i = 0; i < 6; i++) q.push(P('female'));
  const g = formGroup(q, slots);
  assert.ok(g);
  const ids = new Set(g.map((e) => e.userId));
  assert.ok(ids.has(solo.userId));
  assert.ok(!g.some((e) => e.partyId === 'A'));
});

test('일행 중 한 명이라도 나이 조건이 안 맞으면 일행 전체가 빠진다', () => {
  const q = [];
  q.push(P('male', 30, { partyId: 'B' }), { ...P('male', 30, { partyId: 'B' }), profile: { gender: 'male', age: 30, ageUp: 0, ageDown: 0 } });
  for (let i = 0; i < 6; i++) q.push(P('male'));
  for (let i = 0; i < 6; i++) q.push(P('female', 25));
  const g = formGroup(q, slots);
  assert.ok(g);
  assert.ok(!g.some((e) => e.partyId === 'B'));
  // 일행 기준 남은 인원: 일행 2명이 함께 들어가는 경우로 센다
  const me = q[0];
  const need = needFor(q.slice(0, 2), slots, me);
  assert.equal(need.male, 4);
});

test('WS: 같은 성별 친구 초대 → 수락 → 함께 대기 → 한 명이 취소하면 둘 다 빠짐', async () => {
  const app = createServer({ dataDir: null, env: { DEV_TOOLS: '0' } });
  const port = await app.listen(0);
  const mk = (gender, age) => app.store.createUser({ gender, age, ageUp: 40, ageDown: 40, job: 'a', region: 'b', photoUrl: '/x' });
  const a = mk('male', 30);
  const b = mk('male', 31);
  const f = mk('female', 29);
  app.rel.recordGame({ roomId: 'r', people: [a, b, f].map((u) => ({ userId: u.id, alias: u.id.slice(0, 4) })), couples: [] });
  for (const [x, y] of [[a, b], [a, f]]) {
    app.rel.request(x.id, y.id);
    app.rel.respond(y.id, x.id, true);
  }
  const open = (u) => new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: u.token })));
    const t = setInterval(() => { if (ws.msgs.some((m) => m.t === 'welcome')) { clearInterval(t); res(ws); } }, 10);
  });
  const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const last = (ws, t) => [...ws.msgs].reverse().find((m) => m.t === t);
  const wa = await open(a);
  const wb = await open(b);
  const wf = await open(f);
  try {
    // 이성 친구는 초대 불가
    wa.send(JSON.stringify({ t: 'party.invite', to: f.id }));
    await wait();
    assert.match(last(wa, 'partyNote').text, /이성/);
    assert.equal(last(wf, 'party').invite, null);
    // 같은 성별 친구 초대 → 수락
    wa.send(JSON.stringify({ t: 'party.invite', to: b.id }));
    await wait();
    assert.equal(last(wb, 'party').invite.from.id, a.id);
    wb.send(JSON.stringify({ t: 'party.respond', accept: true }));
    await wait();
    assert.deepEqual(last(wa, 'party').party.members.map((m) => m.id).sort(), [a.id, b.id].sort());
    // 한 명이 입장하면 둘 다 대기열에
    wa.send(JSON.stringify({ t: 'queue.join' }));
    await wait();
    assert.equal(last(wb, 'queue').status.inQueue, true);
    // 한 명이 취소하면 둘 다 빠짐
    wb.send(JSON.stringify({ t: 'queue.leave' }));
    await wait();
    assert.equal(last(wa, 'queue').status.inQueue, false);
    // 해제
    wb.send(JSON.stringify({ t: 'party.leave' }));
    await wait();
    assert.equal(last(wa, 'party').party, null);
  } finally {
    for (const w of [wa, wb, wf]) w.close();
    app.close();
  }
});
