import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';

async function setup() {
  const app = createServer({ dataDir: null, env: { DEV_TOOLS: '0' } });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const mk = (gender, age) => app.store.createUser({ gender, age, ageUp: 40, ageDown: 40, job: 'a', region: 'b', photoUrl: '/x' });
  const call = async (u, path, body) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { app, mk, call };
}

test('신고: 함께한 사람만, 대화 신고는 최근 대화가 증거로 남는다', async () => {
  const { app, mk, call } = await setup();
  try {
    const a = mk('male', 30);
    const x = mk('female', 29);
    const stranger = mk('female', 28);
    app.rel.recordGame({ roomId: 'r', people: [{ userId: a.id, alias: '영수' }, { userId: x.id, alias: '영숙' }], couples: [[a.id, x.id]] });
    await call(x, '/api/messages', { to: a.id, text: '연락처 줘. 안 주면 가만 안 둬' });
    assert.equal((await call(a, '/api/report', { userId: stranger.id, reason: 'abuse', context: 'met' })).status, 403);
    assert.equal((await call(a, '/api/report', { userId: x.id, reason: 'nope', context: 'dm' })).status, 400);
    const r = await call(a, '/api/report', { userId: x.id, reason: 'contact', detail: '협박', context: 'dm' });
    assert.equal(r.status, 200);
    const rec = app.reports.list.at(-1);
    assert.equal(rec.target, x.id);
    assert.equal(rec.evidence.messages[0].from, 'target');
    assert.match(rec.evidence.messages[0].text, /연락처/);
    // 같은 내용 연속 신고는 막는다
    assert.equal((await call(a, '/api/report', { userId: x.id, reason: 'contact', context: 'dm' })).status, 400);
  } finally {
    app.close();
  }
});

test('회원 탈퇴: 확인 문구가 있어야 하고, 회원·관계·대화가 지워진다', async () => {
  const { app, mk, call } = await setup();
  try {
    const a = mk('male', 30);
    const b = mk('male', 31);
    app.rel.recordGame({ roomId: 'r', people: [{ userId: a.id, alias: '영수' }, { userId: b.id, alias: '영호' }], couples: [] });
    app.rel.request(a.id, b.id);
    app.rel.respond(b.id, a.id, true);
    await call(a, '/api/messages', { to: b.id, text: '안녕' });
    assert.equal((await call(a, '/api/me/delete', { confirm: '네' })).status, 400);
    assert.equal((await call(a, '/api/me/delete', { confirm: '탈퇴' })).status, 200);
    assert.equal(app.store.get(a.id), null);
    assert.equal((await call(a, '/api/me')).status, 401); // 예전 토큰으로 못 들어옴
    const s = await call(b, '/api/social');
    assert.equal(s.body.friends.length, 0);
    assert.equal(s.body.met.length, 0);
    assert.equal(s.body.threads.length, 0);
  } finally {
    app.close();
  }
});
