import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from '../server/index.js';

const KEY = 'test-admin-key-0123456789abcdef';

async function setup(env = { ADMIN_KEY: KEY }) {
  const app = createServer({ dataDir: null, env: { DEV_TOOLS: '0', ...env } });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const mk = (gender, age) => app.store.createUser({ birthDate: '1995-06-15', gender, age, ageUp: 40, ageDown: 40, job: 'a', region: 'b', photoUrl: '/x' });
  const admin = async (path, body, key = KEY) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-admin-key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const call = async (u, path, body) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { app, port, mk, admin, call };
}

test('관리자: 키가 없거나 틀리면 막힌다', async () => {
  const s1 = await setup({});
  try {
    assert.equal((await s1.admin('/api/admin/summary')).status, 503);
  } finally {
    s1.app.close();
  }
  const s2 = await setup();
  try {
    assert.equal((await s2.admin('/api/admin/summary', null, 'wrong-key-wrong-key-wrong-key-x')).status, 401);
    assert.equal((await s2.admin('/api/admin/summary')).status, 200);
  } finally {
    s2.app.close();
  }
});

test('관리자: 신고 목록 → 정지 → 로그인·접속 막힘 → 해제', async () => {
  const { app, port, mk, admin, call } = await setup();
  try {
    const a = mk('male', 30);
    const x = mk('female', 29);
    app.rel.recordGame({ roomId: 'r', people: [{ userId: a.id, alias: '영수' }, { userId: x.id, alias: '영숙' }], couples: [[a.id, x.id]] });
    await call(x, '/api/messages', { to: a.id, text: '나쁜 말' });
    await call(a, '/api/report', { userId: x.id, reason: 'abuse', context: 'dm' });
    const s = await admin('/api/admin/summary');
    assert.equal(s.body.reportsOpen, 1);
    const list = await admin('/api/admin/reports?status=open');
    assert.equal(list.body.length, 1);
    const rep = list.body[0];
    assert.equal(rep.targetCard.id, x.id);
    assert.equal(rep.targetCard.reportsAgainst, 1);
    assert.equal(rep.evidence.messages[0].text, '나쁜 말');
    // 7일 정지 + 신고 처리 완료
    const b = await admin('/api/admin/ban', { userId: x.id, days: 7, reason: '욕설', reportId: rep.id });
    assert.equal(b.status, 200);
    assert.equal((await admin('/api/admin/reports?status=open')).body.length, 0);
    assert.equal((await admin('/api/admin/reports?status=resolved')).body[0].action, '정지 7일');
    // 정지된 사람: /api/me 는 정지 안내, 다른 API 는 막힘, WS 는 끊김
    const me = await call(x, '/api/me');
    assert.equal(me.status, 403);
    assert.equal(me.body.banned.reason, '욕설');
    assert.ok(me.body.banned.until > Date.now());
    assert.equal((await call(x, '/api/social')).status, 401);
    const closed = await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: x.token })));
      ws.on('close', (code) => res(code));
    });
    assert.equal(closed, 4005);
    assert.equal((await admin('/api/admin/banned')).body.length, 1);
    // 해제
    assert.equal((await admin('/api/admin/unban', { userId: x.id })).status, 200);
    assert.equal((await call(x, '/api/me')).status, 200);
    // 기각 처리
    await call(a, '/api/report', { userId: x.id, reason: 'spam', context: 'met' });
    const r2 = (await admin('/api/admin/reports?status=open')).body[0];
    assert.equal((await admin(`/api/admin/reports/${r2.id}`, { status: 'dismissed', note: '증거 없음' })).body.status, 'dismissed');
  } finally {
    app.close();
  }
});
