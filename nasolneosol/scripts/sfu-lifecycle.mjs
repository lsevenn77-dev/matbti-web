import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Room } from '../server/room.js';
import { makeConfig, PRESETS } from '../server/config.js';

// Exercise the existing AIFECT SFU client with a local fetch double. No media or credentials.
const modulePath = process.argv[2];
assert(modulePath && path.isAbsolute(modulePath));
const { Sfu } = await import(pathToFileURL(modulePath));
const allocated = new Map();
const counts = { create: 0, publish: 0, subscribe: 0, answer: 0, inspect: 0, close: 0 };
async function response(url, init) {
  const segments = new URL(url).pathname.split('/');
  const i = segments.indexOf('sessions');
  assert(i >= 0);
  const [id, operation, action] = segments.slice(i + 1);
  const body = init.body ? JSON.parse(init.body) : null;
  if (id === 'new') {
    const session = 'fixture-' + ++counts.create;
    allocated.set(session, new Map());
    return Response.json({ sessionId: session });
  }
  const tracks = allocated.get(id);
  assert(tracks);
  if (init.method === 'GET') {
    counts.inspect++;
    return Response.json({ tracks: [...tracks.values()] });
  }
  if (operation === 'renegotiate') {
    counts.answer++;
    return Response.json({});
  }
  assert.equal(operation, 'tracks');
  if (action === 'new') {
    const result = body.tracks.map((t) => {
      if (t.location === 'remote') {
        assert(
          [...allocated.get(t.sessionId).values()].some(
            (row) => row.trackName === t.trackName && row.status === 'active'
          )
        );
        counts.subscribe++;
      } else {
        assert.equal(t.location, 'local');
        counts.publish++;
      }
      const row = { ...t, mid: String(tracks.size), status: 'active' };
      tracks.set(row.mid, row);
      return row;
    });
    return Response.json({ tracks: result });
  }
  assert.equal(action, 'close');
  for (const { mid } of body.tracks) {
    tracks.get(mid).status = 'inactive';
    counts.close++;
  }
  return Response.json({ tracks: body.tracks });
}
const sfu = new Sfu({ REALTIME_SFU_APP_ID: 'fixture', REALTIME_SFU_APP_SECRET: 'fixture' }, response);
const members = Array.from({ length: 12 }, (_, i) => ({
  userId: 'fixture-' + i,
  profile: { gender: i % 2 ? 'female' : 'male', age: 25 }
}));
const room = new Room({ id: 'fixture', config: makeConfig(PRESETS.threeDates), members, rng: () => 0.3 });
for (const pid of room.participants.keys()) room.setConnected(pid, true);
const sessions = new Map();
let checks = 0;
async function closeSessions() {
  for (const session of sessions.values()) assert((await sfu.close(session, [])).resolved);
  sessions.clear();
  assert(
    [...allocated.values()].every((tracks) => [...tracks.values()].every((t) => t.status === 'inactive'))
  );
}
async function applyPhase() {
  // One fresh session per active user per phase in this fixture. Teardown before authorizing new groups.
  await closeSessions();
  const permissions = room.voicePerms();
  for (const [id, perm] of Object.entries(permissions)) {
    if (perm.publish || perm.subscribe.length) sessions.set(id, await sfu.create());
    if (perm.publish)
      await sfu.tracks(sessions.get(id), { tracks: [{ location: 'local', mid: '0', trackName: id }] });
  }
  for (const [id, perm] of Object.entries(permissions)) {
    if (!perm.subscribe.length) continue;
    const tracks = perm.subscribe.map((who) => ({
      location: 'remote',
      sessionId: sessions.get(who),
      trackName: who
    }));
    await sfu.tracks(sessions.get(id), { tracks });
    await sfu.answer(sessions.get(id), { type: 'answer', sdp: 'fixture' });
  }
  for (const [id, sid] of sessions) {
    const active = [...allocated.get(sid).values()].filter((t) => t.status === 'active');
    assert.deepEqual(
      active
        .filter((t) => t.location === 'remote')
        .map((t) => t.trackName)
        .sort(),
      [...permissions[id].subscribe].sort()
    );
  }
  checks++;
}
room.start();
while (room.phase !== 'ended') {
  await applyPhase();
  if (room.phase === 'date1') {
    room.setConnected('p1', false);
    await applyPhase();
    assert(!sessions.has('p1'));
    room.setConnected('p1', true);
    await applyPhase();
  }
  room.devSkip();
}
await closeSessions();
assert(counts.publish && counts.subscribe && counts.answer && counts.close);
console.log(JSON.stringify({ phaseChecks: checks, counts, activeTracks: 0, externalCalls: 0 }));
