import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';

test('파일 저장소 복원 후 두 서버가 같은 대화 기록과 서로 다른 입장 정책을 유지한다', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'nasol-restore-'));
  const original = path.join(temp, 'original');
  const restored = path.join(temp, 'restored');
  const key = randomBytes(32).toString('hex');
  const start = async (dir) => {
    const app = createServer({
      env: {
        DATA_DIR: dir,
        ADMIN_KEY: key,
        CAPACITY_MANAGED: '1',
        GAME_SERVERS: '1,2',
        GAME_WORKER_1: 'local',
        GAME_WORKER_2: 'local',
        DEV_TOOLS: '0'
      }
    });
    const port = await app.listen(0, '127.0.0.1');
    const req = async (route, body, headers = {}) => {
      const response = await fetch('http://127.0.0.1:' + port + route, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...headers },
        body: body && JSON.stringify(body)
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    return { app, req };
  };
  const current = await start(original);
  const people = ['male', 'female'].map((gender) =>
    current.app.store.createUser({ birthDate: '1995-06-15', gender, age: 29, job: 'fixture', region: 'fixture' })
  );
  const [a, b] = people;
  current.app.rel.recordGame({
    roomId: 'fixture',
    people: people.map((p) => ({ userId: p.id, alias: 'fixture' })),
    couples: [[a.id, b.id]]
  });
  const admin = { 'x-admin-key': key };
  try {
    await current.req(
      '/api/admin/capacity?server=1',
      { maintenance: true, maxRooms: 2, maxPlayers: 24 },
      admin
    );
    await current.req('/api/admin/capacity?server=2', { blocked: true, maxRooms: 1, maxPlayers: 12 }, admin);
    await current.req(
      '/api/messages',
      { to: b.id, text: 'restore fixture' },
      { Authorization: 'Bearer ' + a.token }
    );
  } finally {
    current.app.close();
  }
  await cp(original, restored, { recursive: true, errorOnExist: true });
  const copy = await start(restored);
  try {
    const one = await copy.req('/api/admin/capacity?server=1', null, admin);
    const two = await copy.req('/api/admin/capacity?server=2', null, admin);
    assert.equal(one.maxRooms, 2);
    assert(one.maintenance);
    assert.equal(two.maxRooms, 1);
    assert(two.blocked);
    assert(one.audit.length && two.audit.length);
    const inbox = await copy.req('/api/messages?with=' + a.id, null, { Authorization: 'Bearer ' + b.token });
    assert.equal(inbox.messages.at(-1).text, 'restore fixture');
  } finally {
    copy.app.close();
  }
  // The isolated temp directory has no production data and is left to the OS temp cleanup.
});
