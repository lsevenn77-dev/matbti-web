// 나솔너솔 시제품 서버: HTTP(정적 파일·가입 API·사진) + WebSocket(대기열·게임 상태)
//
// 환경변수
//   PORT=8080
//   TIME_SCALE=1        개발 시 10 등으로 올리면 모든 단계가 그만큼 빨라진다
//   DEV_TOOLS=1         봇 채우기 등 개발 도구 허용 (운영에서는 끄기)
//   PRESET=threeDates|twoDates
//   VOTER=random|male|female
//   BOT_INTRO_SEC=8     봇 자기소개 길이(실제 초)
//   DATA_DIR=./data

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { makeConfig, PRESETS, estimateMinutes } from './config.js';
import { Room } from './room.js';
import { MockVoiceAdapter } from './voice.js';
import { FileStore, decodeDataUrl, validateProfile } from './store.js';
import { BotDriver, botProfile, botPhotoSvg } from './bots.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --dev: 윈도우/맥/리눅스 공통으로 개발 모드 기본값 (10배속 + 봇 채우기)
if (process.argv.includes('--dev')) {
  process.env.TIME_SCALE ??= '1'; // 정상 속도. 빨리 돌리기는 게임 화면 위 개발 버튼으로
  process.env.DEV_TOOLS ??= '1';
}

export function createServer(opts = {}) {
  const env = { ...process.env, ...opts.env };
  const timeScale = Number(env.TIME_SCALE || 1);
  const devTools = env.DEV_TOOLS === '1';
  const config = makeConfig(PRESETS[env.PRESET] ?? {}, env.VOTER ? { firstVote: { voterGender: env.VOTER } } : {}, opts.config ?? {});
  const store = new FileStore(opts.dataDir === null ? null : path.resolve(env.DATA_DIR || path.join(ROOT, 'data')));
  const voice = new MockVoiceAdapter({ log: env.VOICE_LOG === '1' });

  /** userId → Set<ws> */
  const sockets = new Map();
  /** 대기열 (선착순) */
  const queue = [];
  /** roomId → { room, bots } */
  const rooms = new Map();
  /** userId → roomId */
  const userRoom = new Map();
  let roomSeq = 0;
  let botSeq = 0;

  // ── 대기열 ──────────────────────────────────────────
  function queueStatus(userId) {
    const g = { male: 0, female: 0 };
    for (const q of queue) g[q.gender]++;
    const inQueue = queue.some((q) => q.userId === userId);
    return { inQueue, male: g.male, female: g.female, need: config.slots };
  }

  function joinQueue(user) {
    if (userRoom.has(user.id) || queue.some((q) => q.userId === user.id)) return;
    queue.push({ userId: user.id, gender: user.profile.gender, at: Date.now() });
    tryFormRoom();
    broadcastQueue();
  }

  function leaveQueue(userId) {
    const i = queue.findIndex((q) => q.userId === userId);
    if (i >= 0) queue.splice(i, 1);
    broadcastQueue();
  }

  function tryFormRoom() {
    // [임시] 나이 선호는 아직 반영하지 않음 — 순수 선착순 (결정 대기 13번)
    const pick = (g) => queue.filter((q) => q.gender === g).slice(0, config.slots[g]);
    const m = pick('male');
    const f = pick('female');
    if (m.length < config.slots.male || f.length < config.slots.female) return;
    const chosen = [...m, ...f];
    for (const c of chosen) queue.splice(queue.indexOf(c), 1);
    const id = `r${Date.now().toString(36)}${(++roomSeq).toString(36)}`;
    const members = chosen.map((c) => {
      const u = store.get(c.userId);
      return { userId: u.id, profile: u.profile, isBot: u.isBot };
    });
    const room = new Room({ id, config, members, timeScale, voice });
    // 정상 속도에서는 봇도 사람처럼 시간을 쓴다 (빨리 넘기려면 화면 위 '다음 단계' 버튼)
    const realistic = timeScale === 1 && env.BOT_PACE !== 'fast';
    const bots = new BotDriver(room, { introSec: env.BOT_INTRO_SEC ? Number(env.BOT_INTRO_SEC) : realistic ? null : 8, realistic });
    room.listeners.add((ev) => {
      if (ev.type === 'emote') {
        const msg = { t: 'emote', id: ev.id, kind: ev.kind, x: ev.x, z: ev.z, face: ev.face, y: ev.y };
        for (const p of room.participants.values()) if (!p.isBot && p.id !== ev.id) send(p.userId, msg);
      }
      if (ev.type === 'pos') {
        const msg = { t: 'pos', id: ev.id, x: Math.round(ev.x * 100) / 100, z: Math.round(ev.z * 100) / 100 };
        for (const p of room.participants.values()) if (!p.isBot && p.id !== ev.id) send(p.userId, msg);
      }
      if (ev.type === 'chat') {
        for (const p of room.participants.values()) {
          if (room.channelsFor(p.id).includes(ev.message.channel)) send(p.userId, { t: 'chat', message: ev.message });
        }
      }
    });
    rooms.set(id, { room, bots });
    for (const p of room.participants.values()) {
      userRoom.set(p.userId, id);
      room.setConnected(p.id, p.isBot || (sockets.get(p.userId)?.size ?? 0) > 0);
    }
    room.start();
    console.log(`[room] ${id} 시작 — 투표 성별 ${room.voterGender}, 예상 ${estimateMinutes(config)}분(배속 ${timeScale})`);
  }

  // ── 송신 ────────────────────────────────────────────
  function send(userId, msg) {
    const set = sockets.get(userId);
    if (!set) return;
    const s = JSON.stringify(msg);
    for (const ws of set) if (ws.readyState === 1) ws.send(s);
  }

  function broadcastQueue() {
    for (const userId of sockets.keys()) {
      if (!userRoom.has(userId)) send(userId, { t: 'queue', status: queueStatus(userId) });
    }
  }

  function sendState(room, p) {
    send(p.userId, { t: 'state', view: room.viewFor(p.id) });
  }

  // ── 게임 루프 ───────────────────────────────────────
  const loop = setInterval(() => {
    for (const [id, { room, bots }] of rooms) {
      bots.tick();
      room.tick();
      if (room.dirty) {
        room.dirty = false;
        for (const p of room.participants.values()) if (!p.isBot) sendState(room, p);
      }
      if (room.phase === 'ended' && !room.archived) {
        room.archived = true;
        store.saveGameRecord(id, { id, config: room.cfg, events: room.events, matches: room.matches });
        // 기록 저장 후 일정 시간 뒤 방 정리 (결과 화면은 클라이언트가 유지)
        setTimeout(() => {
          for (const p of room.participants.values()) userRoom.delete(p.userId);
          voice.close(id);
          rooms.delete(id);
        }, 10 * 60 * 1000).unref();
      }
    }
  }, 100);

  // ── HTTP ────────────────────────────────────────────
  const STATIC = path.join(ROOT, 'client', 'public');
  const THREE = path.join(ROOT, 'node_modules', 'three', 'build');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary' };

  function serveFile(res, file, cache) {
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache });
      res.end(buf);
    });
  }

  function json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function readBody(req, limit = 700 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('요청이 너무 크다'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          reject(new Error('잘못된 JSON'));
        }
      });
    });
  }

  function authUser(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    return m ? store.byToken(m[1]) : null;
  }

  function meResponse(u) {
    return { id: u.id, profile: u.profile, inRoom: userRoom.has(u.id) };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/api/signup' && req.method === 'POST') {
        const body = await readBody(req);
        const profile = validateProfile(body, { minAge: config.minAge });
        const { buf, mime } = decodeDataUrl(body.photo);
        profile.photoUrl = store.savePhoto(buf, mime);
        const u = store.createUser(profile);
        return json(res, 200, { token: u.token, me: meResponse(u) });
      }
      if (p === '/api/me' && req.method === 'GET') {
        const u = authUser(req);
        return u ? json(res, 200, meResponse(u)) : json(res, 401, { error: '로그인이 필요하다' });
      }
      if (p === '/api/me' && req.method === 'PUT') {
        const u = authUser(req);
        if (!u) return json(res, 401, { error: '로그인이 필요하다' });
        if (userRoom.has(u.id)) return json(res, 409, { error: '게임 중에는 프로필을 바꿀 수 없다' });
        const body = await readBody(req);
        const patch = validateProfile(body, { minAge: config.minAge, partial: true });
        if (patch.gender && patch.gender !== u.profile.gender) leaveQueue(u.id);
        if (body.photo) patch.photoUrl = store.savePhoto(...Object.values(decodeDataUrl(body.photo)));
        store.updateProfile(u.id, patch);
        return json(res, 200, meResponse(u));
      }
      if (p === '/api/info') {
        return json(res, 200, {
          devTools,
          timeScale,
          estimateMinutes: estimateMinutes(config),
          dateRounds: config.randomDate.enabled ? 3 : 2,
          slots: config.slots,
          minAge: config.minAge,
          voice: 'mock',
        });
      }
      if (p === '/api/dev/fill-bots' && req.method === 'POST') {
        if (!devTools) return json(res, 403, { error: 'DEV_TOOLS 꺼짐' });
        const g = { male: 0, female: 0 };
        for (const q of queue) g[q.gender]++;
        for (const gender of ['male', 'female']) {
          for (let i = g[gender]; i < config.slots[gender]; i++) {
            const n = ++botSeq;
            const prof = botProfile(gender, n);
            prof.photoUrl = store.savePhoto(botPhotoSvg(prof.botLabel, n), 'image/svg+xml');
            const bot = store.createUser(prof, { isBot: true });
            queue.push({ userId: bot.id, gender, at: Date.now() });
          }
        }
        tryFormRoom();
        broadcastQueue();
        return json(res, 200, { ok: true });
      }
      if (p.startsWith('/photos/')) {
        const ph = store.getPhoto(p.slice(8));
        if (!ph) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': ph.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
        return res.end(ph.buf);
      }
      if (p.startsWith('/vendor/three-addons/')) {
        // three/examples/jsm (GLTFLoader 등). 경로 밖으로 나가지 못하게 정규화
        const base = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm');
        const f = path.normalize(path.join(base, p.slice('/vendor/three-addons/'.length)));
        if (!f.startsWith(base + path.sep) || !f.endsWith('.js')) return json(res, 403, { error: 'forbidden' });
        return serveFile(res, f, 'public, max-age=31536000, immutable');
      }
      if (p.startsWith('/vendor/three/')) {
        const f = path.join(THREE, path.basename(p));
        return serveFile(res, f, 'public, max-age=31536000, immutable');
      }
      // 정적 파일
      const rel = p === '/' ? '/index.html' : p;
      const f = path.normalize(path.join(STATIC, rel));
      if (!f.startsWith(STATIC)) return json(res, 403, { error: 'forbidden' });
      const cache = rel === '/index.html' || rel === '/sw.js' || rel.endsWith('.webmanifest') ? 'no-cache' : 'public, max-age=300';
      return serveFile(res, f, cache);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  });

  // ── WebSocket ───────────────────────────────────────
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  wss.on('connection', (ws) => {
    let user = null;
    const hello = setTimeout(() => ws.close(4001, 'no hello'), 5000);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
      if (!user) {
        if (msg.t !== 'hello') return;
        user = store.byToken(msg.token);
        clearTimeout(hello);
        if (!user) return ws.close(4003, 'bad token');
        if (!sockets.has(user.id)) sockets.set(user.id, new Set());
        sockets.get(user.id).add(ws);
        ws.send(JSON.stringify({ t: 'welcome', me: meResponse(user) }));
        const rid = userRoom.get(user.id);
        if (rid && rooms.has(rid)) {
          // 재접속: 서버 최신 단계로 복구
          const { room } = rooms.get(rid);
          const pid = room.pidOfUser(user.id);
          room.setConnected(pid, true);
          sendState(room, room.participants.get(pid));
        } else {
          ws.send(JSON.stringify({ t: 'queue', status: queueStatus(user.id) }));
        }
        return;
      }
      if (msg.t === 'queue.join') return joinQueue(user);
      if (msg.t === 'queue.leave') return leaveQueue(user.id);
      if (msg.t === 'act') {
        const rid = userRoom.get(user.id);
        const entry = rid && rooms.get(rid);
        if (!entry) return ws.send(JSON.stringify({ t: 'ack', reqId: msg.reqId, ok: false, error: '진행 중인 방이 없다' }));
        const pid = entry.room.pidOfUser(user.id);
        const r = entry.room.handle(pid, msg.action ?? {});
        ws.send(JSON.stringify({ t: 'ack', reqId: msg.reqId, ok: r.ok, error: r.error }));
      }
      if (msg.t === 'dev') {
        if (!devTools) return;
        const entry = rooms.get(userRoom.get(user.id));
        if (!entry) return;
        if (msg.op === 'skip') entry.room.devSkip();
        if (msg.op === 'speed') entry.room.devSetSpeed(msg.scale);
        return;
      }
      if (msg.t === 'leaveResult') {
        // 종료된 방의 결과 화면을 닫고 대기 화면으로 돌아감
        const rid = userRoom.get(user.id);
        if (rid && rooms.get(rid)?.room.phase === 'ended') {
          userRoom.delete(user.id);
          ws.send(JSON.stringify({ t: 'queue', status: queueStatus(user.id) }));
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(hello);
      if (!user) return;
      const set = sockets.get(user.id);
      set?.delete(ws);
      if (set && set.size === 0) {
        sockets.delete(user.id);
        // [임시] 대기열에 있던 사람은 연결이 끊기면 대기열에서 뺀다
        if (!userRoom.has(user.id)) leaveQueue(user.id);
        const rid = userRoom.get(user.id);
        if (rid && rooms.has(rid)) {
          const { room } = rooms.get(rid);
          room.setConnected(room.pidOfUser(user.id), false);
        }
      }
    });
  });

  return {
    server,
    rooms,
    store,
    voice,
    config,
    listen(port) {
      return new Promise((r) => server.listen(port, () => r(server.address().port)));
    },
    close() {
      clearInterval(loop);
      wss.close();
      server.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const app = createServer();
  const port = await app.listen(Number(process.env.PORT || 8080));
  console.log(`나솔너솔 시제품 서버 http://localhost:${port}  (배속 ${process.env.TIME_SCALE || 1}, 개발도구 ${process.env.DEV_TOOLS === '1' ? 'ON' : 'OFF'}, 음성: 모의)`);
}
