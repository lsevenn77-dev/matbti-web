import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';

// Private IPC from lobby-load.js. The harness accepts only a stage size and always binds loopback.
assert(process.send);
const count = Number(process.argv[2]);
assert([1000, 3000, 5000, 10000].includes(count));
const app = createServer({ dataDir: null, env: { DEV_TOOLS: '0', CAPACITY_MANAGED: '1' } });
const accounts = [];
for (let i = 0; i < count; i++) {
  const member = app.store.createUser({
    gender: i % 2 ? 'female' : 'male',
    age: 30,
    job: 'test',
    region: 'test',
    photoUrl: '/x'
  });
  accounts.push({ id: member.id, token: member.token });
}
for (let i = 0; i < count; i += 2) {
  const pair = accounts.slice(i, i + 2);
  app.rel.recordGame({
    roomId: 'fixture-' + i,
    people: pair.map((u) => ({ userId: u.id, alias: 'test' })),
    couples: [pair.map((u) => u.id)]
  });
}
process.on('disconnect', () => {
  app.close();
  process.exit(0);
});
process.send({ port: await app.listen(0), accounts });
process.on('message', (command) => {
  if (command === 'summary') process.send({ rooms: app.rooms.size, rss: process.memoryUsage().rss });
});
