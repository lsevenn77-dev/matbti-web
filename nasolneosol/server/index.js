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
import { formGroup, needFor } from './matcher.js';
import { PRODUCTS, entryStatus, canEnter, consumeEntry, grantProduct } from './wallet.js';
import { socialConfig, verifyGoogle, verifyApple, verifyKakaoCode, kakaoAuthorizeUrl, SocialAuthError } from './social.js';
import { payConfig, newOrderId, niceApprove } from './payments.js';
import { Relations, RelationError } from './relations.js';
import { randomBytes } from 'node:crypto';

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
  const relations = new Relations(store.dir);

  const social = socialConfig(env);
  const pay = payConfig(env);
  const signupTickets = new Map(); // ticket → { identity, until }  (간편 로그인 후 아직 프로필이 없는 사람)
  const kakaoStates = new Map(); // state → { linkUserId, until }
  const authResults = new Map(); // id → { body, until }  (카카오 리다이렉트 결과 전달용)
  const shortId = () => randomBytes(18).toString('base64url');
  const sweep = (m) => { const t = Date.now(); for (const [k, v] of m) if (v.until < t) m.delete(k); };

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
  /** 대기열 + 최신 프로필 (나이 조건 매칭용) */
  function queueEntries() {
    return queue.map((q) => ({ ...q, profile: store.get(q.userId)?.profile ?? { age: 0, gender: q.gender } }));
  }

  function queueStatus(userId) {
    const g = { male: 0, female: 0 };
    for (const q of queue) g[q.gender]++;
    const entries = queueEntries();
    const me = entries.find((q) => q.userId === userId);
    const st = { inQueue: !!me, male: g.male, female: g.female, need: config.slots, total: { ...g } };
    if (me) {
      // 내 나이 조건과 서로 맞는 사람만 센 인원과 남은 인원
      const n = needFor(entries, config.slots, me);
      st.male = n.matched.male;
      st.female = n.matched.female;
      st.more = { male: n.male, female: n.female };
    }
    return st;
  }

  function joinQueue(user) {
    if (userRoom.has(user.id) || queue.some((q) => q.userId === user.id)) return;
    if (!canEnter(user)) return send(user.id, { t: 'queueError', error: '오늘 남은 입장권이 없어. 입장권을 사거나 내일 다시 와 줘.' });
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
    // 선착순 + 나이 조건: 방 안의 모든 남녀 쌍이 서로의 나이 범위 안에 들어야 한다
    // 입장권이 남아 있는 사람만 (대기 중에 날짜가 바뀌는 등)
    const group = formGroup(queueEntries().filter((q) => { const u = store.get(q.userId); return u && canEnter(u); }), config.slots);
    if (!group) return;
    const ids = new Set(group.map((c) => c.userId));
    const chosen = queue.filter((q) => ids.has(q.userId));
    for (const c of chosen) queue.splice(queue.indexOf(c), 1);
    // 방이 시작될 때 입장권 1회 사용
    for (const c of chosen) {
      const u = store.get(c.userId);
      if (u && !u.isBot) c.used = consumeEntry(u);
    }
    store.persist();
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

  // ── 게임 밖 관계 (함께한 사람 · 친구 · 나의 인연 · 메시지) ──
  /** 끝난 게임: 함께한 사람과 최종 매칭을 기록한다. 봇은 개발 모드에서만 (시험용) */
  function recordRelations(roomId, room) {
    const people = [...room.participants.values()].filter((p) => !p.isBot || devTools).map((p) => ({ userId: p.userId, alias: p.alias }));
    const uid = (pid) => room.participants.get(pid)?.userId;
    const couples = room.matches.map(([a, b]) => [uid(a), uid(b)]).filter(([a, b]) => a && b && people.some((p) => p.userId === a) && people.some((p) => p.userId === b));
    relations.recordGame({ roomId, people, couples });
    for (const p of people) send(p.userId, { t: 'social' });
  }

  /** 목록에 보여 줄 상대 정보. 공개 범위는 게임 자기소개 이후와 같다 (가명·성별·나이·사진) */
  function personCard(me, otherId) {
    const u = store.get(otherId);
    if (!u) return null;
    return {
      id: u.id,
      alias: relations.aliasFor(me, otherId) || (u.isBot ? '봇' : ''),
      gender: u.profile.gender,
      age: u.profile.age,
      photoUrl: u.profile.photoUrl,
      online: (sockets.get(u.id)?.size ?? 0) > 0,
      inGame: userRoom.has(u.id),
      isBot: !!u.isBot,
    };
  }

  function socialSummary(me) {
    const card = (id) => personCard(me, id);
    const keep = (x) => x.filter((c) => c && !relations.isBlocked(me, c.id));
    const friends = keep([...(relations.friends.get(me) ?? [])].map(card)).sort((a, b) => Number(b.online) - Number(a.online));
    const outgoing = new Set(relations.outgoing(me).map((r) => r.userId));
    const incoming = keep(relations.incoming(me).map((r) => card(r.userId) && { ...card(r.userId), at: r.at }));
    const met = keep([...(relations.met.get(me) ?? [])].reverse().map(([id, m]) => card(id) && { ...card(id), at: m.at, friend: relations.areFriends(me, id), requested: outgoing.has(id) }));
    const matches = (relations.matches.get(me) ?? []).filter((m) => !relations.isBlocked(me, m.partnerId)).map((m) => card(m.partnerId) && { ...card(m.partnerId), at: m.at, roomId: m.roomId }).filter(Boolean);
    const threads = relations.threadsOf(me).map((t) => card(t.userId) && { ...card(t.userId), last: { text: t.last.text, at: t.last.at, mine: t.last.from === me }, unread: t.unread }).filter(Boolean);
    return { friends, incoming, met, matches, threads, unread: threads.reduce((n, t) => n + t.unread, 0) };
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
        recordRelations(id, room);
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
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };

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
    return {
      id: u.id,
      profile: u.profile,
      inRoom: userRoom.has(u.id),
      wallet: entryStatus(u),
      linked: (u.identities ?? []).map((k) => k.split(':')[0]),
    };
  }

  function readForm(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) { reject(new Error('요청이 너무 크다')); req.destroy(); } else chunks.push(c);
      });
      req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
      req.on('error', reject);
    });
  }

  function publicUrl(req) {
    if (social.publicUrl) return social.publicUrl;
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
    return `${proto}://${req.headers.host}`;
  }

  /** 간편 로그인 결과 → 로그인 / 계정 연결 / 신규 가입 티켓 */
  function resolveIdentity(ident, linkUser) {
    const existing = store.byIdentity(ident.provider, ident.sub);
    if (existing) {
      if (linkUser && linkUser.id !== existing.id) return { status: 409, body: { error: '이 계정은 이미 다른 프로필에 연결돼 있어' } };
      return { status: 200, body: { token: existing.token, me: meResponse(existing) } };
    }
    if (linkUser) {
      store.linkIdentity(linkUser.id, ident.provider, ident.sub);
      return { status: 200, body: { token: linkUser.token, me: meResponse(linkUser), linked: true } };
    }
    sweep(signupTickets);
    const ticket = shortId();
    signupTickets.set(ticket, { identity: ident, until: Date.now() + 10 * 60 * 1000 });
    return { status: 200, body: { signupTicket: ticket, provider: ident.provider } };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/api/signup' && req.method === 'POST') {
        const body = await readBody(req);
        const profile = validateProfile(body, { minAge: config.minAge });
        // 간편 로그인으로 시작한 경우 그 계정에 연결
        let ident = null;
        if (body.signupTicket) {
          const t = signupTickets.get(String(body.signupTicket));
          if (!t || t.until < Date.now()) return json(res, 400, { error: '간편 로그인 시간이 지났어. 다시 로그인해 줘' });
          if (store.byIdentity(t.identity.provider, t.identity.sub)) return json(res, 409, { error: '이미 가입된 계정이야. 다시 로그인해 줘' });
          ident = t.identity;
          signupTickets.delete(String(body.signupTicket));
        }
        const { buf, mime } = decodeDataUrl(body.photo);
        profile.photoUrl = store.savePhoto(buf, mime);
        const u = store.createUser(profile);
        if (ident) store.linkIdentity(u.id, ident.provider, ident.sub);
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
        // 나이 조건이 바뀌면 대기열 매칭을 다시 본다
        tryFormRoom();
        broadcastQueue();
        return json(res, 200, meResponse(u));
      }
      // ── 친구 · 나의 인연 · 메시지 ──
      if (p.startsWith('/api/social') || p.startsWith('/api/friends') || p.startsWith('/api/messages') || p === '/api/block') {
        const u = authUser(req);
        if (!u) return json(res, 401, { error: '로그인이 필요하다' });
        try {
          if (p === '/api/social' && req.method === 'GET') return json(res, 200, socialSummary(u.id));
          if (req.method === 'GET' && p === '/api/messages') {
            const other = String(url.searchParams.get('with') ?? '');
            const peer = personCard(u.id, other);
            if (!peer) return json(res, 404, { error: '상대를 찾을 수 없어' });
            const list = relations.history(u.id, other).map((m) => ({ id: m.id, mine: m.from === u.id, text: m.text, at: m.at }));
            return json(res, 200, { peer, canMessage: relations.canMessage(u.id, other), friend: relations.areFriends(u.id, other), matched: relations.isMatched(u.id, other), messages: list });
          }
          if (req.method !== 'POST') return json(res, 405, { error: 'method' });
          const body = await readBody(req, 8 * 1024);
          const other = String(body.userId ?? body.to ?? '');
          if (!store.get(other)) return json(res, 404, { error: '상대를 찾을 수 없어' });
          if (p === '/api/friends/request') {
            const r = relations.request(u.id, other);
            send(other, { t: 'social' });
            return json(res, 200, r);
          }
          if (p === '/api/friends/respond') {
            const r = relations.respond(u.id, other, !!body.accept);
            send(other, { t: 'social' });
            return json(res, 200, r);
          }
          if (p === '/api/friends/cancel') {
            relations.cancel(u.id, other);
            send(other, { t: 'social' });
            return json(res, 200, { ok: true });
          }
          if (p === '/api/friends/remove') {
            relations.unfriend(u.id, other);
            send(other, { t: 'social' });
            return json(res, 200, { ok: true });
          }
          if (p === '/api/block') {
            if (body.unblock) relations.unblock(u.id, other);
            else relations.block(u.id, other);
            return json(res, 200, { ok: true });
          }
          if (p === '/api/messages') {
            const m = relations.send(u.id, other, body.text);
            const out = (mine) => ({ t: 'dm', peer: mine ? other : u.id, message: { id: m.id, mine, text: m.text, at: m.at } });
            send(other, out(false));
            send(u.id, out(true));
            return json(res, 200, { message: { id: m.id, mine: true, text: m.text, at: m.at } });
          }
          return json(res, 404, { error: 'not found' });
        } catch (e) {
          if (e instanceof RelationError) return json(res, 400, { error: e.message });
          throw e;
        }
      }
      // ── 간편 로그인 ──
      if ((p === '/api/auth/google' || p === '/api/auth/apple') && req.method === 'POST') {
        const body = await readBody(req, 16 * 1024);
        try {
          const ident = p.endsWith('google') ? await verifyGoogle(social, body.credential) : await verifyApple(social, body.credential);
          const r = resolveIdentity(ident, authUser(req));
          return json(res, r.status, r.body);
        } catch (e) {
          return json(res, 401, { error: e instanceof SocialAuthError ? e.message : '로그인 확인에 실패했어' });
        }
      }
      if (p === '/api/auth/kakao/start' && req.method === 'POST') {
        if (!social.kakaoRestKey) return json(res, 400, { error: '카카오 로그인 설정이 아직 없어' });
        sweep(kakaoStates);
        const state = shortId();
        kakaoStates.set(state, { linkUserId: authUser(req)?.id ?? null, until: Date.now() + 10 * 60 * 1000 });
        return json(res, 200, { url: kakaoAuthorizeUrl({ ...social, publicUrl: publicUrl(req) }, state) });
      }
      if (p === '/auth/kakao/callback' && req.method === 'GET') {
        const st0 = kakaoStates.get(url.searchParams.get('state') ?? '');
        kakaoStates.delete(url.searchParams.get('state') ?? '');
        let out;
        try {
          if (!st0 || st0.until < Date.now()) throw new SocialAuthError('로그인 요청이 만료됐어. 다시 시도해 줘');
          if (url.searchParams.get('error')) throw new SocialAuthError('카카오 로그인을 취소했어');
          const ident = await verifyKakaoCode({ ...social, publicUrl: publicUrl(req) }, url.searchParams.get('code'));
          out = resolveIdentity(ident, st0.linkUserId ? store.get(st0.linkUserId) : null);
        } catch (e) {
          out = { status: 401, body: { error: e instanceof SocialAuthError ? e.message : '카카오 로그인에 실패했어' } };
        }
        sweep(authResults);
        const id = shortId();
        authResults.set(id, { ...out, until: Date.now() + 5 * 60 * 1000 });
        res.writeHead(302, { Location: `/?auth=${id}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (p === '/api/auth/result' && req.method === 'POST') {
        const body = await readBody(req, 4096);
        const r = authResults.get(String(body.id ?? ''));
        authResults.delete(String(body.id ?? ''));
        if (!r) return json(res, 404, { error: '로그인 결과가 만료됐어. 다시 시도해 줘' });
        return json(res, r.status, r.body);
      }

      // ── 결제 ──
      if (p === '/api/pay/order' && req.method === 'POST') {
        const u = authUser(req);
        if (!u) return json(res, 401, { error: '로그인이 필요하다' });
        const body = await readBody(req, 4096);
        const prod = PRODUCTS[body.product];
        if (!prod) return json(res, 400, { error: '알 수 없는 상품' });
        const realPay = !!(pay.clientKey && pay.secretKey);
        if (!realPay && !devTools) return json(res, 503, { error: '결제 준비 중이야' });
        // 결제한 입장권이 사라지지 않도록, 실제 결제는 간편 로그인 계정이 연결된 사람만
        if (realPay && !(u.identities ?? []).length) return json(res, 403, { error: '결제 전에 카카오·구글·애플 계정을 연결해 줘', needLink: true });
        const order = store.saveOrder({ orderId: newOrderId(), userId: u.id, product: prod.id, amount: prod.krw, goodsName: `나솔너솔 ${prod.name}`, status: 'ready', createdAt: Date.now(), mode: realPay ? 'nice' : 'mock' });
        return json(res, 200, {
          orderId: order.orderId,
          amount: order.amount,
          goodsName: order.goodsName,
          nice: realPay ? { clientId: pay.clientKey, jsUrl: pay.jsUrl, returnUrl: `${publicUrl(req)}/pay/nice/return` } : null,
          mock: !realPay,
        });
      }
      if (p === '/api/pay/mock' && req.method === 'POST') {
        if (!devTools) return json(res, 403, { error: 'DEV_TOOLS 꺼짐' });
        const u = authUser(req);
        const body = await readBody(req, 4096);
        const o = store.orders.get(String(body.orderId ?? ''));
        if (!u || !o || o.userId !== u.id || o.mode !== 'mock') return json(res, 404, { error: '주문을 찾을 수 없어' });
        if (o.status !== 'paid') {
          grantProduct(u, o.product);
          o.status = 'paid';
          o.paidAt = Date.now();
          store.saveOrder(o);
          store.persist();
        }
        return json(res, 200, { ok: true, me: meResponse(u) });
      }
      if (p === '/pay/nice/return' && req.method === 'POST') {
        const f = await readForm(req);
        const o = store.orders.get(String(f.orderId ?? ''));
        let to = '/?pay=fail';
        try {
          if (!o || o.mode !== 'nice') throw new Error('주문 없음');
          if (o.status === 'paid') to = `/?pay=ok&order=${o.orderId}`;
          else if (f.authResultCode !== '0000') {
            o.status = 'failed';
            o.failMsg = String(f.authResultMsg ?? '').slice(0, 80);
            store.saveOrder(o);
            to = `/?pay=cancel`;
          } else {
            if (Number(f.amount) !== o.amount) throw new Error('금액 불일치');
            const r = await niceApprove(pay, String(f.tid), o.amount);
            const u = store.get(o.userId);
            grantProduct(u, o.product);
            Object.assign(o, { status: 'paid', paidAt: Date.now(), tid: String(f.tid), receiptUrl: r.receiptUrl ?? null });
            store.saveOrder(o);
            store.persist();
            to = `/?pay=ok&order=${o.orderId}`;
          }
        } catch (e) {
          if (o) {
            o.status = 'error';
            o.failMsg = String(e.message).slice(0, 120);
            store.saveOrder(o);
          }
          console.error('[pay] 승인 실패', f.orderId, e.message);
        }
        res.writeHead(303, { Location: to, 'Cache-Control': 'no-store' });
        return res.end();
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
          auth: {
            google: social.googleClientIds[0] ?? null,
            kakao: !!(social.kakaoRestKey && social.kakaoAppId),
            apple: social.appleAudiences[0] ?? null,
          },
          pay: { nice: !!(pay.clientKey && pay.secretKey), mock: devTools && !(pay.clientKey && pay.secretKey), products: Object.values(PRODUCTS) },
          // 자동 업데이트가 게임 중에는 재시작하지 않도록: 사람이 들어 있는 진행 중인 방 수
          activeRooms: [...rooms.values()].filter(({ room }) => room.phase !== 'ended' && [...room.participants.values()].some((x) => !x.isBot && x.connected)).length,
        });
      }
      if (p === '/api/dev/fill-bots' && req.method === 'POST') {
        if (!devTools) return json(res, 403, { error: 'DEV_TOOLS 꺼짐' });
        // 대기 중인 사람들의 나이 조건에 모두 맞는 나이로 봇을 만든다 (봇은 나이 조건 없음)
        const humans = queueEntries().filter((q) => !store.get(q.userId)?.isBot);
        let lo = config.minAge;
        let hi = 80;
        for (const h of humans) {
          const pf = h.profile;
          lo = Math.max(lo, pf.age - (Number.isInteger(pf.ageDown) ? pf.ageDown : 99));
          hi = Math.min(hi, pf.age + (Number.isInteger(pf.ageUp) ? pf.ageUp : 99));
        }
        const g = { male: 0, female: 0 };
        for (const q of queue) g[q.gender]++;
        for (const gender of ['male', 'female']) {
          for (let i = g[gender]; i < config.slots[gender]; i++) {
            const n = ++botSeq;
            const prof = botProfile(gender, n);
            if (lo <= hi) prof.age = lo + Math.floor(Math.random() * (hi - lo + 1));
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
        if (!f.startsWith(base + path.sep) || !/\.(js|wasm)$/.test(f)) return json(res, 403, { error: 'forbidden' });
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
      // 앱 코드(html·js·css·json)는 항상 최신을 확인 (Cloudflare·브라우저가 옛 코드를 붙잡지 않게). 아이콘·이미지만 캐시
      const cache = /\.(html|js|css|json|webmanifest)$/.test(rel) ? 'no-cache' : 'public, max-age=3600';
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
    rel: relations,
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
