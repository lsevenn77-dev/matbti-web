import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { createServer } from '../server/index.js';
import { entryStatus } from '../server/wallet.js';

test(
  '작업 프로세스 장애 시 해당 서버 입장만 차단하고 입장권을 1회 복원한다',
  { timeout: 20000 },
  async () => {
    const key = randomBytes(32).toString('hex');
    const sensor = randomBytes(32).toString('hex');
    const app = createServer({
      dataDir: null,
      env: { CAPACITY_MANAGED: '1', GAME_SERVERS: '1,2', ADMIN_KEY: key, MONITOR_KEY_1: sensor }
    });
    const port = await app.listen(0);
    const base = 'http://127.0.0.1:' + port;
    const clients = [];
    async function api(path, id, body, headers = { 'x-admin-key': key }, expected = 200) {
      const r = await fetch(base + '/api/admin/' + path + '?server=' + id, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...headers },
        body: body && JSON.stringify(body)
      });
      assert.equal(r.status, expected);
      return r.json();
    }
    const health = () => ({
      cpuPct: 1,
      corePeakPct: 2,
      memPct: 10,
      at: Date.now(),
      p95Ratio: 1,
      errorRatio: 0,
      ioOk: true,
      networkOk: true,
      budgetOk: true
    });
    const until = async (ok) => {
      const end = Date.now() + 8500;
      while (!(await ok())) {
        assert(Date.now() < end, 'condition timeout');
        await delay(30);
      }
    };
    try {
      await api('capacity', '1', null, { 'x-monitor-key': sensor }, 401);
      await api('health-sample', '2', health(), { 'x-monitor-key': sensor }, 401);
      await api('health-sample', '1', health(), { 'x-monitor-key': sensor });
      for (const id of ['1', '2']) {
        await api('capacity', id, { maxRooms: 1, maxPlayers: 12, recoverySeconds: 0, queueTtlSeconds: 2 });
        await delay(2);
        await api('health-sample', id, health());
        await until(async () => (await api('capacity', id)).status === '원활');
      }
      for (let i = 0; i < 24; i++) {
        const user = app.store.createUser({
          age: 30,
          gender: i % 2 ? 'female' : 'male',
          job: 'fixture',
          region: 'fixture',
          photoUrl: '/x'
        });
        const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
        await once(ws, 'open');
        const hello = once(ws, 'message');
        ws.send(JSON.stringify({ t: 'hello', token: user.token }));
        await hello;
        clients.push({ ws, user, id: i < 12 ? '1' : '2' });
      }
      for (const c of clients) c.ws.send(JSON.stringify({ t: 'queue.join', serverId: c.id }));
      await until(() => [...app.rooms.values()].filter((e) => e.opened).length === 2);
      assert(clients.every((c) => entryStatus(c.user).total === 0));
      const [bad, good] = ['1', '2'].map((id) => [...app.rooms.values()].find((e) => e.serverId === id));
      bad.worker.proc.kill();
      await until(() => app.rooms.size === 1);
      assert([...app.rooms.values()][0] === good && good.worker.ready);
      assert(clients.every((c) => entryStatus(c.user).total === (c.id === '1' ? 1 : 0)));
      assert.equal((await api('capacity', '1')).status, 'FULL');
      assert.equal((await api('capacity', '2')).playing, 12);
      await until(
        async () =>
          (await api('capacity', '1')).workerHost?.at > 0 &&
          (await api('capacity', '1')).reason === '상태 미수신'
      );
      await api('health-sample', '1', health(), { 'x-monitor-key': sensor });
      assert.equal((await api('capacity', '1')).status, '원활');
      clients[0].ws.send(JSON.stringify({ t: 'queue.join', serverId: '1' }));
      await until(async () => (await api('capacity', '1')).queued === 1);
      await until(async () => (await api('capacity', '1')).queued === 0);
      assert.equal(entryStatus(clients[0].user).total, 1);
    } finally {
      for (const c of clients) c.ws.terminate();
      app.close();
    }
  }
);
