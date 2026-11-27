import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createServer } from '../server/index.js';

test(
  'managed admission protects rooms through maintenance, stale samples and bursts',
  { timeout: 65000 },
  async () => {
    const key = randomBytes(30).toString('hex');
    const app = createServer({ dataDir: null, env: { CAPACITY_MANAGED: '1', ADMIN_KEY: key } });
    const port = await app.listen(0);
    const base = 'http://127.0.0.1:' + port;
    const clients = [];
    const api = async (route, body) => {
      const r = await fetch(base + '/api/admin/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-admin-key': key, 'content-type': 'application/json' },
        body: body && JSON.stringify(body)
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    const sample = (overrides) =>
      api('health-sample', {
        at: Date.now(),
        cpuPct: 10,
        corePeakPct: 20,
        memPct: 30,
        p95Ratio: 1,
        errorRatio: 0,
        ioOk: true,
        networkOk: true,
        budgetOk: true,
        ...overrides
      });
    async function connect(user) {
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
      clients.push(ws);
      ws.events = [];
      ws.on('message', (bytes) => ws.events.push(JSON.parse(bytes)));
      await once(ws, 'open');
      ws.send(JSON.stringify({ t: 'hello', token: user.token }));
      await until(() => ws.events.some((m) => m.t === 'welcome'));
      return ws;
    }
    async function until(ok) {
      const end = Date.now() + 3000;
      while (!ok()) {
        assert(Date.now() < end, 'event deadline');
        await delay(10);
      }
    }
    try {
      assert.equal((await fetch(base + '/api/admin/capacity')).status, 401);
      assert.equal((await api('capacity')).status, 'FULL');
      await api('capacity', { maxRooms: 1, maxPlayers: 12 });
      for (let i = 0; i < 5; i++) {
        await sample({});
        if (i < 4) await delay(7600);
      }
      assert.equal((await api('capacity')).status, '원활');
      const people = Array.from({ length: 14 }, (_, i) =>
        app.store.createUser({
          gender: i % 2 ? 'female' : 'male',
          age: 30,
          job: 'test',
          region: 'test',
          photoUrl: '/x'
        })
      );
      for (const person of people) await connect(person);
      for (const ws of clients) for (let i = 0; i < 2; i++) ws.send(JSON.stringify({ t: 'queue.join' }));
      await until(() => clients.filter((ws) => ws.events.some((m) => m.t === 'queueError')).length === 2);
      const info = await (await fetch(base + '/api/info')).json();
      assert.equal(info.activeRooms, 1);
      assert.equal(info.updateSafe, false);
      let cap = await api('capacity');
      assert.deepEqual([cap.active, cap.playing, cap.queued, cap.status], [1, 12, 0, 'FULL']);
      await api('capacity', { maintenance: true });
      assert.equal((await api('capacity')).status, '점검');
      await until(() => clients.some((ws) => ws.events.some((m) => m.t === 'state')));
      const index = clients.findIndex((ws) => ws.events.some((m) => m.t === 'state'));
      clients[index].close();
      const reconnected = await connect(people[index]);
      await until(() => reconnected.events.some((m) => m.t === 'state'));
      await api('capacity', { maintenance: false, maxRooms: 2, maxPlayers: 24 });
      await sample({ p95Ratio: 1.15 });
      assert.equal((await api('capacity')).reason, '기존 서비스 보호');
      await delay(15100);
      assert.equal((await api('capacity')).reason, '상태 미수신');
    } finally {
      for (const ws of clients) ws.terminate();
      app.close();
    }
  }
);
