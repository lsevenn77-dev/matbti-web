import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from '../server/index.js';
import { validateHandle } from '../server/store.js';
import { Room } from '../server/room.js';
import { makeConfig } from '../server/config.js';

async function setup(env = {}) {
  const app = createServer({ dataDir: null, env: { DEV_TOOLS: '0', ...env } });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const mk = (gender, age) => app.store.createUser({ birthDate: '1995-06-15', gender, age, ageUp: 40, ageDown: 40, job: 'a', region: 'b', photoUrl: '/x' });
  const call = async (u, path, body) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(u ? { Authorization: `Bearer ${u.token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { app, mk, call };
}

test('아이디 규칙: 소문자로 맞추고, 짧거나 이상한 글자·운영자 이름은 막는다', () => {
  assert.equal(validateHandle('  @Minsu_92 '), 'minsu_92');
  for (const bad of ['abc', 'a'.repeat(16), '한글아이디', '_abc', 'abc.', 'ab..cd', '12345', 'admin', 'nasol_kr', 'test']) {
    assert.throws(() => validateHandle(bad), undefined, bad);
  }
  assert.equal(validateHandle('tester1'), 'tester1'); // test 로 시작해도 같지만 않으면 된다
});

test('아이디: 중복 불가, 가입 때 정하고, 아이디로 찾아 모르는 사람에게도 친구 신청', async () => {
  const { app, mk, call } = await setup();
  try {
    const a = mk('male', 30);
    const b = mk('male', 29);
    assert.equal((await call(a, '/api/me/handle', { handle: 'Minsu' })).body.handle, 'minsu');
    // 다른 사람이 같은 아이디(대소문자만 다른 것 포함)는 못 쓴다
    assert.equal((await call(b, '/api/me/handle', { handle: 'MINSU' })).status, 400);
    assert.equal((await call(b, '/api/handle/check?h=minsu')).body.ok, false);
    assert.equal((await call(a, '/api/handle/check?h=minsu')).body.ok, true); // 내 아이디는 괜찮다
    assert.equal((await call(b, '/api/me/handle', { handle: 'yeonhee' })).status, 200);
    // 바꾸기는 7일에 한 번
    assert.equal((await call(a, '/api/me/handle', { handle: 'minsu2' })).status, 400);
    // 찾기 + 함께한 적 없어도 아이디로 신청
    const f = await call(b, '/api/users/find?handle=@MinSu');
    assert.equal(f.status, 200);
    assert.equal(f.body.handle, 'minsu');
    assert.equal(f.body.age, undefined); // 아이디 찾기로는 나이·직업을 보여 주지 않는다
    assert.equal((await call(b, '/api/users/find?handle=nobody1')).status, 404);
    assert.equal((await call(b, '/api/friends/request', { userId: a.id })).status, 400); // 아이디 없이 회원번호로는 여전히 안 된다
    assert.equal((await call(b, '/api/friends/request', { handle: 'minsu' })).body.status, 'requested');
    const sa = await call(a, '/api/social');
    assert.equal(sa.body.incoming[0].id, b.id);
    assert.equal(sa.body.incoming[0].handle, 'yeonhee'); // 게임 가명이 없으니 아이디로 보인다
    assert.equal((await call(b, '/api/social')).body.sent[0].id, a.id);
    assert.equal((await call(a, '/api/friends/respond', { userId: b.id, accept: true })).body.status, 'friends');
    // 차단하면 아이디로 찾을 수 없다
    const c = mk('female', 27);
    await call(a, '/api/block', { userId: c.id });
    assert.equal((await call(c, '/api/users/find?handle=minsu')).status, 404);
    assert.equal((await call(c, '/api/friends/request', { handle: 'minsu' })).status, 404);
    // 탈퇴하면 아이디가 풀린다
    await call(b, '/api/me/delete', { confirm: '탈퇴' });
    assert.equal((await call(c, '/api/handle/check?h=yeonhee')).body.ok, true);
  } finally {
    app.close();
  }
});

test('아이디 신청은 하루 20번까지', async () => {
  const { app, mk, call } = await setup();
  try {
    const a = mk('male', 30);
    for (let i = 0; i < 21; i++) {
      const u = mk('male', 25);
      app.store.setHandle(u.id, `girl${i}x`);
      const r = await call(a, '/api/friends/request', { handle: `girl${i}x` });
      assert.equal(r.status, i < 20 ? 200 : 400, `#${i}`);
    }
  } finally {
    app.close();
  }
});

test('무단 이탈: 3분 넘게 한 번에 나가 있던 사람만, 최종 선택이 끝나기 전까지', () => {
  let now = 1_000_000;
  const members = [];
  for (let i = 0; i < 12; i++) members.push({ userId: `u${i}`, isBot: false, profile: { gender: i < 6 ? 'male' : 'female', age: 30, ageUp: 40, ageDown: 40, photoUrl: '/x' } });
  const room = new Room({ id: 'r', config: makeConfig(), members, now: () => now });
  const pids = [...room.participants.keys()];
  for (const pid of pids) room.setConnected(pid, true);
  room.setConnected(pids[11], false); // 시작부터 안 들어온 사람
  room.start();
  const step = (sec) => { now += sec * 1000; };
  // 2분 끊겼다 돌아옴 → 괜찮음
  room.setConnected(pids[0], false); step(120); room.setConnected(pids[0], true);
  // 1분씩 여러 번 → 한 번에 3분이 아니라 괜찮음
  for (let i = 0; i < 4; i++) { room.setConnected(pids[1], false); step(60); room.setConnected(pids[1], true); }
  // 4분 나갔다 돌아옴 → 이탈
  room.setConnected(pids[2], false); step(240); room.setConnected(pids[2], true);
  // 나가서 안 돌아옴 → 이탈
  room.setConnected(pids[3], false); step(200);
  assert.deepEqual(room.leavers(now).sort(), [pids[2], pids[3], pids[11]].sort());
});

test('WS: 게임 중 나가서 안 돌아오면 이탈 기록 → 30일 안 2회째는 24시간 입장 제한, 끝까지 한 사람은 그대로', async () => {
  const app = createServer({ dataDir: null, env: { DEV_TOOLS: '1' }, config: { leavePenalty: { absentSec: 0.3 } } });
  const port = await app.listen(0);
  const mk = (gender) => app.store.createUser({ birthDate: '1995-06-15', gender, age: 30, ageUp: 40, ageDown: 40, job: 'a', region: 'b', photoUrl: '/x' });
  const users = [];
  for (let i = 0; i < 6; i++) users.push(mk('male'), mk('female'));
  const [leaver, stayer, repeat] = users;
  repeat.leaves = [{ at: Date.now() - 5 * 24 * 3600 * 1000, roomId: 'old' }]; // 지난주에 한 번 이탈한 사람
  const paid = users[4]; // 월정액 이용자: 이탈해도 기록만 하고 입장은 막지 않는다
  paid.leaves = [{ at: Date.now() - 5 * 24 * 3600 * 1000, roomId: 'old' }];
  paid.wallet = { tickets: 0, subUntil: Date.now() + 20 * 24 * 3600 * 1000, freeDay: null, freeUsed: 0, subDay: null, subUsed: 0 };
  const open = (u) => new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', token: u.token })); setTimeout(() => res(ws), 60); });
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sockets = [];
  try {
    for (const u of users) sockets.push(await open(u));
    for (const ws of sockets) ws.send(JSON.stringify({ t: 'queue.join' }));
    await wait(200);
    const [{ room }] = [...app.rooms.values()];
    assert.ok(room, '방이 시작돼야 한다');
    // 두 사람이 나가고 돌아오지 않는다
    sockets[0].close();
    sockets[2].close();
    sockets[4].close();
    await wait(500);
    // 남은 사람이 단계를 넘겨 결과까지
    for (let i = 0; i < 40 && !['result', 'contact', 'ended'].includes(room.phase); i++) {
      sockets[1].send(JSON.stringify({ t: 'dev', op: 'skip' }));
      await wait(30);
    }
    await wait(200);
    assert.equal(leaver.leaves.length, 1);
    assert.equal(leaver.leaveBlockUntil, undefined); // 첫 이탈은 경고만
    assert.equal(repeat.leaves.length, 2);
    assert.ok(repeat.leaveBlockUntil > Date.now() + 23 * 3600 * 1000);
    assert.equal(stayer.leaves, undefined);
    assert.equal(paid.leaves.length, 2);
    assert.equal(paid.leaveBlockUntil, undefined);
    // 제한 중이던 사람도 유료 입장권을 사면 입장할 수 있다
    repeat.wallet.tickets = 1;
    const meTicket = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { Authorization: `Bearer ${repeat.token}` } }).then((r) => r.json());
    assert.equal(meTicket.leave.blockedUntil, null);
    repeat.wallet.tickets = 0;
    assert.ok(sockets[1].msgs.every((m) => m.t !== 'leavePenalty'));
    const me = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { Authorization: `Bearer ${repeat.token}` } }).then((r) => r.json());
    assert.equal(me.leave.count, 2);
    assert.ok(me.leave.blockedUntil > Date.now());
    // 입장 제한 중인 사람은 대기열에 못 들어간다
    const blocked = mk('male');
    blocked.leaveBlockUntil = Date.now() + 3600 * 1000;
    const ws = await open(blocked);
    sockets.push(ws);
    ws.send(JSON.stringify({ t: 'queue.join' }));
    await wait(150);
    assert.match(ws.msgs.find((m) => m.t === 'queueError')?.error ?? '', /무단 이탈/);
  } finally {
    for (const ws of sockets) ws.close();
    app.close();
  }
});

test('무단 이탈 기록은 30일이 지나면 세지 않는다', async () => {
  const { app, mk, call } = await setup();
  try {
    const a = mk('male', 30);
    assert.deepEqual((await call(a, '/api/me')).body.leave, { count: 0, blockedUntil: null });
    a.leaves = [{ at: Date.now() - 31 * 24 * 3600 * 1000, roomId: 'old' }];
    assert.equal((await call(a, '/api/me')).body.leave.count, 0);
  } finally {
    app.close();
  }
});
