// Private stdin/stdout protocol. The coordinator owns accounts, tickets, reports and game records.
import { createInterface } from 'node:readline';
import { hostMonitor } from './host-metrics.js';
import { Room } from './room.js';
import { MockVoiceAdapter } from './voice.js';
import { BotDriver } from './bots.js';

const rooms = new Map();
const measureHost = hostMonitor();
function emit(message) {
  if (process.stdout.writableLength > 16 * 1024 * 1024) process.exit(2);
  process.stdout.write(JSON.stringify(message) + '\n');
}
function deliver(room, p, body) {
  emit({ kind: 'deliver', id: room.id, userId: p.userId, body });
}
function state(room, p, permissions) {
  if (!p.isBot && (p.connected || room.phase === 'ended'))
    deliver(room, p, { t: 'state', view: room.viewFor(p.id, permissions) });
}
function open(input) {
  const voice = new MockVoiceAdapter();
  const room = new Room({ ...input, voice });
  const bots = new BotDriver(room, { realistic: input.timeScale === 1 });
  room.listeners.add((ev) => {
    if (ev.type === 'chat') {
      emit({ kind: 'evidence', id: room.id, message: ev.message });
      const users = [...room.participants.values()]
        .filter((p) => !p.isBot && room.channelsFor(p.id).includes(ev.message.channel))
        .map((p) => p.userId);
      emit({ kind: 'fanout', id: room.id, users, body: { t: 'chat', message: ev.message } });
    } else if (ev.type === 'pos' || ev.type === 'emote') {
      const { type, ...data } = ev;
      const users = [...room.participants.values()]
        .filter((p) => !p.isBot && p.id !== ev.id)
        .map((p) => p.userId);
      emit({ kind: 'fanout', id: room.id, users, body: { t: type, ...data } });
    }
  });
  for (const p of room.participants.values()) room.setConnected(p.id, true);
  rooms.set(room.id, { room, bots, voice });
  room.start();
  emit({ kind: 'opened', id: room.id });
}
const timer = setInterval(() => {
  for (const { room, bots, voice } of rooms.values()) {
    bots.tick();
    room.tick();
    if (room.dirty) {
      room.dirty = false;
      const permissions = room.voicePerms();
      for (const p of room.participants.values()) state(room, p, permissions);
    }
    if (room.phase === 'ended') {
      voice.close(room.id);
      emit({
        kind: 'finished',
        id: room.id,
        events: room.events,
        matches: room.matches,
        mockVoiceOps: voice.ops.length,
        remainingTracks: Object.values(voice.snapshot(room.id)).filter((p) => p.publish || p.subscribe.length)
          .length
      });
      rooms.delete(room.id);
    }
  }
}, 100);
const heartbeat = setInterval(
  () => emit({ kind: 'ready', rss: process.memoryUsage().rss, host: measureHost() }),
  2000
);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('close', () => {
  clearInterval(timer);
  clearInterval(heartbeat);
  process.exit(0);
});
input.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.kind === 'open') return open(m.input);
  const room = rooms.get(m.id)?.room;
  if (!room) return;
  if (m.kind === 'connected') {
    room.setConnected(m.pid, m.connected);
    if (m.connected) state(room, room.participants.get(m.pid));
  } else if (m.kind === 'act') {
    const r = room.handle(m.pid, m.action);
    emit({ kind: 'ack', id: m.id, seq: m.seq, ok: r.ok, error: r.error });
  }
});
emit({ kind: 'ready', rss: process.memoryUsage().rss, host: measureHost() });
