import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { fork } from 'node:child_process';

const stages = [1000, 3000, 5000, 10000];
async function run(n) {
  const fixture = fork(new URL('./lobby-fixture.js', import.meta.url), [String(n)], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  });
  const [{ port, accounts: users }] = await once(fixture, 'message');
  const base = 'http://127.0.0.1:' + port;
  const sockets = [];
  const times = new Map();
  const limit = setTimeout(() => {
    console.error('stage timeout');
    process.exit(1);
  }, 180000);
  function observe(label, start) {
    if (!times.has(label)) times.set(label, []);
    times.get(label).push(performance.now() - start);
  }
  try {
    for (let start = 0; start < n; start += 25) {
      await Promise.all(
        users.slice(start, start + 25).map(async (user) => {
          const t = performance.now();
          const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
          sockets.push(ws);
          await once(ws, 'open');
          const message = once(ws, 'message');
          ws.send(JSON.stringify({ t: 'hello', token: user.token }));
          const [data] = await message;
          assert.equal(JSON.parse(data).t, 'welcome');
          observe('wsLogin', t);
        })
      );
    }
    for (const route of ['/', '/api/me', '/api/server-status', '/api/social']) {
      for (let i = 0; i < n; i += 25)
        await Promise.all(
          users.slice(i, i + 25).map(async (user) => {
            const t = performance.now();
            const response = await fetch(base + route, {
              headers: { Authorization: 'Bearer ' + user.token },
              signal: AbortSignal.timeout(5000)
            });
            assert.equal(response.status, 200);
            await response.arrayBuffer();
            observe(route, t);
          })
        );
    }
    for (let start = 0; start < n; start += 50) {
      const checks = [];
      for (let i = start; i < Math.min(start + 50, n); i += 2)
        checks.push(
          (async () => {
            const from = users[i],
              to = users[i + 1];
            const t = performance.now();
            const response = await fetch(base + '/api/messages', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + from.token, 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(5000),
              body: JSON.stringify({ to: to.id, text: 'lab-' + i })
            });
            assert.equal(response.status, 200);
            const { message } = await response.json();
            observe('messageSend', t);
            const readAt = performance.now();
            const history = await fetch(base + '/api/messages?with=' + from.id, {
              headers: { Authorization: 'Bearer ' + to.token },
              signal: AbortSignal.timeout(5000)
            });
            assert.equal(history.status, 200);
            assert((await history.json()).messages.some((m) => m.id === message.id && m.text === 'lab-' + i));
            observe('messageRead', readAt);
          })()
        );
      await Promise.all(checks);
    }
    let burst = null;
    if (process.argv.includes('--burst')) {
      const started = performance.now();
      const refusals = sockets.map(
        (ws, index) =>
          new Promise((resolve, reject) => {
            function receive(raw) {
              const message = JSON.parse(raw);
              if (message.t !== 'queueError') return;
              ws.off('message', receive);
              if (message.error !== 'FULL') return reject(new Error('Unexpected admission result'));
              resolve(performance.now() - started);
            }
            ws.on('message', receive);
            ws.send(JSON.stringify({ t: 'queue.join', serverId: index % 2 ? '1' : '2' }));
          })
      );
      const rejected = (await Promise.all(refusals)).sort((a, b) => a - b);
      burst = {
        submitted: sockets.length,
        denied: rejected.length,
        p95Ms: rejected[Math.ceil(0.95 * n) - 1],
        lastMs: rejected.at(-1)
      };
    }
    const result = once(fixture, 'message');
    fixture.send('summary');
    const [server] = await result;
    assert.equal(server.rooms, 0);
    const summary = Object.fromEntries(
      [...times].map(([label, values]) => {
        values.sort((a, b) => a - b);
        return [label, { n: values.length, p95: values[Math.ceil(values.length * 0.95) - 1] }];
      })
    );
    console.log(JSON.stringify({ users: n, connections: sockets.length, server, summary, burst }));
    assert(
      Object.values(summary).every((row) => row.p95 <= 100),
      'synthetic lobby stage p95 exceeded 100 ms'
    );
  } finally {
    clearTimeout(limit);
    for (const ws of sockets) ws.terminate();
    await delay(100);
    fixture.disconnect();
  }
}
const selected = process.argv[2] ? [Number(process.argv[2])] : stages;
assert(selected.every((n) => stages.includes(n)));
for (const stage of selected) await run(stage);
