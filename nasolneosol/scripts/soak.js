import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createServer } from '../server/index.js';
import { walletOf } from '../server/wallet.js';

const key = randomBytes(32).toString('hex');
const app = createServer({
  dataDir: null,
  env: { ADMIN_KEY: key, CAPACITY_MANAGED: '1', GAME_SERVERS: '1,2', TIME_SCALE: '240', DEV_TOOLS: '0' }
});
const port = await app.listen(0);
const base = 'http://127.0.0.1:' + port;
async function api(route, id, body) {
  const r = await fetch(base + '/api/admin/' + route + '?server=' + id, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-admin-key': key, 'content-type': 'application/json' },
    body: body && JSON.stringify(body)
  });
  assert.equal(r.status, 200);
  return r.json();
}
async function heartbeat() {
  for (const id of ['1', '2'])
    await api('health-sample', id, {
      at: Date.now(),
      cpuPct: 2,
      corePeakPct: 3,
      memPct: 4,
      p95Ratio: 1,
      errorRatio: 0,
      ioOk: true,
      networkOk: true,
      budgetOk: true
    });
}
const clients = [];
let pulse;
const start = Date.now();
async function take(label) {
  const nodes = await Promise.all(['1', '2'].map((id) => api('capacity', id)));
  console.log(
    JSON.stringify({
      label,
      seconds: (Date.now() - start) / 1000,
      retainedRooms: app.rooms.size,
      clients: clients.length,
      players: nodes.reduce((s, n) => s + n.playing, 0),
      coordinatorRss: process.memoryUsage().rss,
      heap: process.memoryUsage().heapUsed,
      workerRss: nodes.map((n) => n.workerRss)
    })
  );
}
try {
  for (const id of ['1', '2']) await api('capacity', id, { maxRooms: 1, maxPlayers: 12, recoverySeconds: 0 });
  await heartbeat();
  pulse = setInterval(() => heartbeat().catch(() => process.exit(1)), 5000);
  for (let i = 0; i < 24; i++) {
    const user = app.store.createUser({
      age: 30,
      gender: i % 2 ? 'female' : 'male',
      job: 'fixture',
      region: 'fixture',
      photoUrl: '/x'
    });
    walletOf(user).tickets = 12;
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    await once(ws, 'open');
    const welcome = once(ws, 'message');
    ws.send(JSON.stringify({ t: 'hello', token: user.token }));
    await welcome;
    const client = { ws, serverId: i < 12 ? '1' : '2', ended: null };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'state' && m.view.phase === 'ended') client.ended = m.view.roomId;
    });
    clients.push(client);
  }
  await take('start');
  for (let round = 1; round <= 10; round++) {
    for (const c of clients) {
      c.ended = null;
      c.ws.send(JSON.stringify({ t: 'queue.join', serverId: c.serverId }));
    }
    const deadline = Date.now() + 65000;
    while (clients.some((c) => !c.ended)) {
      assert(Date.now() < deadline, 'round timeout');
      await delay(100);
    }
    assert.equal(new Set(clients.map((c) => c.ended)).size, 2);
    await take('round-' + round);
    for (const c of clients) c.ws.send(JSON.stringify({ t: 'leaveResult' }));
    await delay(200);
  }
  const deadline = Date.now() + 620000;
  while (app.rooms.size) {
    assert(Date.now() < deadline, 'ended rooms not released');
    await delay(5000);
  }
  await take('after-retention');
  assert.equal(app.rooms.size, 0);
} finally {
  clearInterval(pulse);
  for (const c of clients) c.ws.terminate();
  app.close();
}
