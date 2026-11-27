import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

// A bounded auxiliary lobby on the same loopback coordinator as the game-under-test.
export async function startLobbyTraffic(app, port) {
  assert.equal(app.store.dir, null);
  const base = 'http://127.0.0.1:' + port;
  const accounts = [];
  const sockets = [];
  const timings = {};
  let stop = false;
  let cycle = 0;
  let failed = 0;
  const run = async (label, route, user, payload) => {
    const start = performance.now();
    const response = await fetch(base + route, {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' },
      body: payload && JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    (timings[label] ??= []).push(performance.now() - start);
    return value;
  };
  for (let i = 0; i < 1000; i++) {
    const u = app.store.createUser({
      age: 30,
      gender: i % 2 ? 'female' : 'male',
      job: 'fixture',
      region: 'fixture'
    });
    accounts.push(u);
    if (i % 2)
      app.rel.recordGame({
        roomId: 'lobby-fixture-' + i,
        people: [accounts[i - 1], u].map((x) => ({ userId: x.id, alias: 'fixture' })),
        couples: [[accounts[i - 1].id, u.id]]
      });
  }
  try {
    for (let i = 0; i < accounts.length; i += 25) {
      await Promise.all(
        accounts.slice(i, i + 25).map(async (u) => {
          const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
          sockets.push(ws);
          await once(ws, 'open');
          const welcome = once(ws, 'message');
          ws.send(JSON.stringify({ t: 'hello', token: u.token }));
          assert.equal(JSON.parse((await welcome)[0]).t, 'welcome');
        })
      );
    }
  } catch (error) {
    for (const ws of sockets) ws.terminate();
    throw error;
  }
  const active = (async () => {
    while (!stop) {
      const i = (cycle * 2) % accounts.length;
      try {
        const [a, b] = accounts.slice(i, i + 2);
        await Promise.all(accounts.slice(i, i + 20).map((u) => run('status', '/api/server-status', u)));
        await run('friends', '/api/social', b);
        const r = await run('dmSend', '/api/messages', a, { to: b.id, text: 'fixture ' + cycle });
        const inbox = await run('dmRead', '/api/messages?with=' + a.id, b);
        assert(inbox.messages.some((m) => m.id === r.message.id));
      } catch {
        failed++;
      }
      cycle++;
      await delay(125);
    }
  })();
  return async () => {
    stop = true;
    await active;
    for (const ws of sockets) ws.terminate();
    const stats = Object.fromEntries(
      Object.entries(timings).map(([k, v]) => {
        v.sort((a, b) => a - b);
        return [k, { requests: v.length, p95Ms: v[Math.ceil(v.length * 0.95) - 1] }];
      })
    );
    assert.equal(failed, 0);
    assert(cycle > 1);
    return { authenticated: accounts.length, cycles: cycle, failed, stats };
  };
}
