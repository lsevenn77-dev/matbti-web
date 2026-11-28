import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Relations, RelationError } from '../server/relations.js';
import { createServer } from '../server/index.js';

function game(rel, couples = [['a', 'x']]) {
  rel.recordGame({
    roomId: 'r1',
    people: [
      { userId: 'a', alias: '영수' },
      { userId: 'b', alias: '영호' },
      { userId: 'x', alias: '영숙' },
      { userId: 'y', alias: '옥순' },
    ],
    couples,
  });
}

test('함께한 사람과 최종 매칭이 기록된다', () => {
  const rel = new Relations(null);
  game(rel);
  assert.ok(rel.hasMet('a', 'y'));
  assert.equal(rel.aliasFor('a', 'x'), '영숙');
  assert.ok(rel.isMatched('a', 'x') && rel.isMatched('x', 'a'));
  assert.ok(!rel.isMatched('a', 'y'));
});

test('친구 신청은 함께한 사람에게만, 수락하면 서로 친구', () => {
  const rel = new Relations(null);
  game(rel);
  assert.throws(() => rel.request('a', 'stranger'), RelationError);
  assert.equal(rel.request('a', 'b').status, 'requested');
  assert.deepEqual(rel.incoming('b').map((r) => r.userId), ['a']);
  assert.deepEqual(rel.outgoing('a').map((r) => r.userId), ['b']);
  assert.equal(rel.respond('b', 'a', true).status, 'friends');
  assert.ok(rel.areFriends('a', 'b') && rel.areFriends('b', 'a'));
  assert.throws(() => rel.request('a', 'b'), /이미 친구/);
});

test('서로 신청하면 바로 친구가 된다', () => {
  const rel = new Relations(null);
  game(rel);
  rel.request('a', 'y');
  assert.equal(rel.request('y', 'a').status, 'friends');
  assert.ok(rel.areFriends('a', 'y'));
});

test('메시지는 친구 또는 최종 매칭 상대끼리만, 안 읽은 수를 센다', () => {
  let t = 1000;
  const rel = new Relations(null, { now: () => (t += 1000) });
  game(rel);
  assert.throws(() => rel.send('a', 'y', '안녕'), /서로 고른 상대나 같은 성별 친구/);
  rel.send('a', 'x', '안녕하세요'); // 매칭 상대
  rel.send('x', 'a', '반가워요');
  assert.equal(rel.unreadTotal('a'), 1);
  assert.equal(rel.unreadTotal('x'), 0);
  assert.equal(rel.history('a', 'x').length, 2);
  assert.equal(rel.unreadTotal('a'), 0);
  assert.throws(() => rel.send('a', 'x', '   '), /내용/);
  assert.throws(() => rel.send('a', 'x', 'x'.repeat(501)), /500자/);
});

test('차단하면 친구·신청·메시지가 모두 막힌다', () => {
  let t = 1000;
  const rel = new Relations(null, { now: () => (t += 1000) });
  game(rel);
  rel.request('a', 'b');
  rel.respond('b', 'a', true);
  rel.send('a', 'x', '안녕');
  rel.block('x', 'a');
  assert.ok(!rel.canMessage('a', 'x'));
  assert.throws(() => rel.send('a', 'x', '?'), RelationError);
  assert.equal(rel.threadsOf('a').length, 0);
  rel.block('a', 'b');
  assert.ok(!rel.areFriends('a', 'b'));
  assert.throws(() => rel.request('b', 'a'), RelationError);
});

test('HTTP: 친구 신청 → 수락 → 메시지', async () => {
  const app = createServer({ dataDir: null, env: { DEV_TOOLS: '0' } });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const a = app.store.createUser({ birthDate: '1995-06-15', gender: 'male', age: 30, job: 'a', region: 'b' });
    const b = app.store.createUser({ birthDate: '1995-06-15', gender: 'male', age: 31, job: 'a', region: 'b' });
    const x = app.store.createUser({ birthDate: '1995-06-15', gender: 'female', age: 29, job: 'a', region: 'b' });
    app.rel.recordGame({ roomId: 'r', people: [{ userId: a.id, alias: '영수' }, { userId: b.id, alias: '영호' }, { userId: x.id, alias: '영숙' }], couples: [[a.id, x.id]] });
    const call = async (u, path, body) => {
      const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    let s = await call(a, '/api/social');
    assert.equal(s.status, 200);
    assert.equal(s.body.met.length, 2);
    assert.equal(s.body.matches[0].alias, '영숙');
    assert.equal((await call(a, '/api/friends/request', { userId: b.id })).body.status, 'requested');
    s = await call(b, '/api/social');
    assert.equal(s.body.incoming[0].alias, '영수');
    assert.equal((await call(b, '/api/friends/respond', { userId: a.id, accept: true })).body.status, 'friends');
    assert.equal((await call(a, '/api/messages', { to: b.id, text: '같이 하자' })).status, 200);
    s = await call(b, '/api/social');
    assert.equal(s.body.unread, 1);
    assert.equal(s.body.friends[0].id, a.id);
    const h = await call(b, `/api/messages?with=${a.id}`);
    assert.equal(h.body.messages[0].text, '같이 하자');
    assert.equal(h.body.messages[0].mine, false);
    assert.equal((await call(a, '/api/messages', { to: x.id, text: '도배' })).status, 400); // 너무 빨리 연속 전송
    await new Promise((r) => setTimeout(r, 450));
    assert.equal((await call(a, '/api/messages', { to: x.id, text: '반가워요' })).status, 200); // 매칭 상대
    assert.equal((await call(x, '/api/messages', { to: b.id, text: '?' })).status, 400); // 친구도 매칭도 아님
    // 이성은 친구 신청이 안 되고, 함께한 사람 목록에서도 친구 신청 대상이 아니다
    const fr = await call(x, '/api/friends/request', { userId: b.id });
    assert.equal(fr.status, 400);
    assert.match(fr.body.error, /같은 성별/);
    const sx = await call(x, '/api/social');
    assert.equal(sx.body.met.find((m) => m.id === b.id).canFriend, false);
    assert.equal(sx.body.met.find((m) => m.id === a.id).matched, true);
    // 예전에 맺어 둔 이성 친구: 목록에서 빠지고 대화도 막힌다 (매칭 상대는 그대로 대화)
    app.rel.friends.set(b.id, new Set([...(app.rel.friends.get(b.id) ?? []), x.id]));
    app.rel.friends.set(x.id, new Set([b.id]));
    assert.ok(!(await call(x, '/api/social')).body.friends.some((c) => c.id === b.id));
    await new Promise((r) => setTimeout(r, 450));
    assert.equal((await call(x, '/api/messages', { to: b.id, text: '?' })).status, 400);
    assert.equal((await call(x, '/api/messages', { to: a.id, text: '저도 반가워요' })).status, 200);
    assert.equal((await call(a, '/api/social')).status, 200);
    assert.equal((await fetch(base + '/api/social')).status, 401);
  } finally {
    app.close();
  }
});
