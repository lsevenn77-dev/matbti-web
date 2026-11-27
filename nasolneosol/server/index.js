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
import { RoomWorker } from './room-worker-client.js';
import { makeGate } from './capacity.js';
import { Room } from './room.js';
import { MockVoiceAdapter } from './voice.js';
import { FileStore, decodeDataUrl, validateProfile } from './store.js';
import { BotDriver, botProfile, botPhotoSvg } from './bots.js';
import { formGroup, needFor } from './matcher.js';
import { PRODUCTS, entryStatus, canEnter, consumeEntry, refundEntry, grantProduct } from './wallet.js';
import { socialConfig, verifyGoogle, verifyApple, verifyKakaoCode, kakaoAuthorizeUrl, SocialAuthError } from './social.js';
import { payConfig, newOrderId, niceApprove } from './payments.js';
import { Relations, RelationError } from './relations.js';
import { Reports, ReportError, REPORT_REASONS } from './reports.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';

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
  const reports = new Reports(store.dir);
  reports.purgeOld(); // 처리 완료 후 1년 지난 신고 기록 정리

  const social = socialConfig(env);
  const pay = payConfig(env);
  const signupTickets = new Map(); // ticket → { identity, until }  (간편 로그인 후 아직 프로필이 없는 사람)
  const kakaoStates = new Map(); // state → { linkUserId, until }
  const findHits = new Map(); // userId → [시각] 아이디 찾기 횟수 제한
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
  const size = config.slots.male + config.slots.female;
  const managed = env.CAPACITY_MANAGED === '1';
  const ids = managed ? (env.GAME_SERVERS || '1,2').split(',').map(x=>x.trim()) : ['1'];
  if (new Set(ids).size !== ids.length || ids.some(id=>!/^\d{1,4}$/.test(id))) throw new Error('Invalid GAME_SERVERS');
  // Room state is transient. The debit and its recovery marker share one atomic users.json write.
  if (managed && store.dir) {
    let reconciled = false;
    for (const user of store.users.values()) {
      const pending = user.pendingGameEntry;
      if (!pending) continue;
      if (!/^r[a-z0-9]+$/.test(pending.roomId) || !['free','sub','ticket'].includes(pending.kind)) {
        throw new Error('Invalid outstanding room entry');
      }
      if (!store.hasGameRecord(pending.roomId)) refundEntry(user, pending.kind);
      delete user.pendingGameEntry;
      reconciled = true;
    }
    if (reconciled) store.persist();
  }
  const first = ids[0];
  const workers = new Map();
  const restartDelays = new Map();
  const restartTimers = new Map();
  let shuttingDown=false;
  const gates = new Map(ids.map(id=>[id,makeGate(id,env,size,managed,store.dir)]));
  function workerEvent(serverId,m) {
    const entry=rooms.get(m.id);
    if(!entry || entry.serverId!==serverId || !entry.worker) return;
    const { room }=entry;
    if(m.kind==='opened') { entry.opened=true; return; }
    if(m.kind==='deliver' && userRoom.get(m.userId)===m.id) {
      if(m.body.t==='state') entry.views.set(m.userId,m.body.view);
      send(m.userId,m.body);
    }
    if(m.kind==='fanout') {
      for(const uid of m.users) if(userRoom.get(uid)===m.id) send(uid,m.body);
    }
    if(m.kind==='evidence') {
      room.chat.push(m.message);
      if(room.chat.length>1000) room.chat.shift();
    }
    if(m.kind==='leavers') {
      const members=new Set(entry.chosen.map((c)=>c.userId));
      for(const uid of m.users) if(members.has(uid)) recordLeave(uid,m.id);
    }
    if(m.kind==='finished') {
      entry.mockVoiceOps=m.mockVoiceOps;entry.remainingTracks=m.remainingTracks;
      room.events=m.events;room.matches=m.matches;room.phase='ended';
    }
  }
  function settleEntry(userId, roomId, refund) {
    const user = store.get(userId);
    if (user?.pendingGameEntry?.roomId !== roomId) return;
    if (refund) refundEntry(user, user.pendingGameEntry.kind);
    delete user.pendingGameEntry;
  }

  function workerFailed(serverId) {
    let changed = false;
    for(const [id,entry] of rooms) {
      if(entry.serverId!==serverId || !entry.worker || entry.room.phase==='ended') continue;
      for(const c of entry.chosen) {
        settleEntry(c.userId,id,true);
        changed = true;
        if(userRoom.get(c.userId)===id) userRoom.delete(c.userId);
        send(c.userId,{t:'roomUnavailable',error:'게임 서버 연결이 종료됐어. 대기화면에서 다시 입장해 줘.'});
      }
      rooms.delete(id);
    }
    if (changed) store.persist();
    if (!shuttingDown) broadcastQueue();
  }
  function connectWorker(id,target) {
    workers.set(id,new RoomWorker(target,m=>{
      if(m.kind==='opened') restartDelays.delete(id);
      workerEvent(id,m);
    },()=>{
      workerFailed(id);
      if(shuttingDown) return;
      gates.get(id).invalidate('게임 서버 연결 종료');
      const delay=Math.min((restartDelays.get(id) || 2500)*2,60000);
      restartDelays.set(id,delay);
      restartTimers.set(id,setTimeout(()=>connectWorker(id,target),delay));
    }));
  }
  if (managed) for(const id of ids) {
    const target=opts.dataDir===null ? 'local' : env['GAME_WORKER_'+id];
    if(target) connectWorker(id,target);
  }
  function capacity(id=first, extra=1, forming=false) {
    const active = [...rooms.values()].filter(entry => entry.serverId===id && entry.room.phase!=='ended').length;
    const queued = queue.filter(q => (q.serverId ?? first)===id).length;
    const snapshot=gates.get(id).snapshot(active,queued,extra,forming);
    if (managed && !workers.get(id)?.ready && snapshot.status!=='점검') {
      return {...snapshot,status:'FULL',reason:'게임 서버 연결 확인 중'};
    }
    return snapshot;
  }
  // ── 대기열 ──────────────────────────────────────────
  /** 대기열 + 최신 프로필 (나이 조건 매칭용) */
  function queueEntries() {
    return queue.map((q) => ({ ...q, profile: store.get(q.userId)?.profile ?? { age: 0, gender: q.gender } }));
  }

  function queueStatus(userId) {
    const g = { male: 0, female: 0 };
    const selected = queue.find(q=>q.userId===userId)?.serverId ?? first;
    const entries = queueEntries().filter(q=>(q.serverId ?? first)===selected);
    for (const q of entries) g[q.gender]++;
    const me = entries.find((q) => q.userId === userId);
    const st = { serverId: selected, serverStatus: capacity(selected).status, inQueue: !!me, male: g.male, female: g.female, need: config.slots, total: { ...g } };
    if (me) {
      // 내 나이 조건과 서로 맞는 사람만 센 인원과 남은 인원
      const n = needFor(entries, config.slots, me);
      st.male = n.matched.male;
      st.female = n.matched.female;
      st.more = { male: n.male, female: n.female };
    }
    return st;
  }

  function joinQueue(user, serverId=first) {
    if (!gates.has(serverId)) return send(user.id,{t:"queueError",error:"서버를 다시 선택해 줘"});
    if (userRoom.has(user.id) || queue.some((q) => q.userId === user.id)) return;
    const party = partyOf(user.id);
    if (party) return joinQueueParty(user, party, serverId);
    const blocked = leaveBlockMsg(user);
    if (blocked) return send(user.id, { t: 'queueError', error: blocked });
    const gate = capacity(serverId);
    if (gate.reason) return send(user.id, { t: 'queueError', error: gate.status });
    if (!canEnter(user)) return send(user.id, { t: 'queueError', error: '오늘 남은 입장권이 없어. 입장권을 사거나 내일 다시 와 줘.' });
    queue.push({ serverId, userId: user.id, gender: user.profile.gender, at: Date.now() });
    tryFormRoom();
    broadcastQueue();
  }

  /** 동반 입장: 일행 모두 조건이 될 때만 함께 대기열에 넣는다 */
  function joinQueueParty(user, party, serverId) {
    const err = (m) => send(user.id, { t: 'queueError', error: m, party: true });
    for (const id of party.members) {
      const u = store.get(id);
      const who = id === user.id ? '내' : '함께 입장하는 친구의';
      if (!u) return err('함께 입장하는 친구를 찾을 수 없어');
      if (userRoom.has(id)) return err('함께 입장하는 친구가 아직 게임 중이야');
      if (!u.isBot && !isOnline(id)) return err('함께 입장하는 친구가 접속해 있지 않아');
      if (queue.some(q => q.userId === id && (q.serverId !== serverId || q.partyId !== party.id))) return err('함께 입장하는 친구가 다른 대기열에 있어');
      const blocked = leaveBlockMsg(u, id === user.id ? '' : '함께 입장하는 친구가 ');
      if (blocked) return err(blocked);
      if (!canEnter(u)) return err(`${who} 남은 입장권이 없어`);
    }
    const gate = capacity(serverId, party.members.filter((id) => !inQueue(id)).length);
    if (gate.reason) return err(gate.status);
    const at = Date.now();
    for (const id of party.members) {
      if (queue.some((q) => q.userId === id)) continue;
      queue.push({ serverId, userId: id, gender: store.get(id).profile.gender, at, partyId: party.id });
    }
    tryFormRoom();
    broadcastQueue();
  }

  function leaveQueue(userId) {
    // 동반 입장 일행은 함께 빠진다
    const entry = queue.find((q) => q.userId === userId);
    if (!entry) return;
    const pid = entry.partyId;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].userId === userId || (pid && queue[i].partyId === pid)) queue.splice(i, 1);
    }
    broadcastQueue();
  }

  // ── 동반 입장 (같은 성별 친구, 본인 포함 최대 2명) ──
  const PARTY_MAX = 2;
  const INVITE_TTL = 2 * 60 * 1000;
  /** partyId → { id, members: [userId], at } */
  const parties = new Map();
  /** userId → partyId */
  const userParty = new Map();
  /** 초대받은 사람 userId → { from, at } */
  const partyInvites = new Map();
  /** 접속이 끊긴 일행 정리 타이머 */
  const partyGrace = new Map();
  const isOnline = (id) => (sockets.get(id)?.size ?? 0) > 0;
  const partyOf = (id) => parties.get(userParty.get(id)) ?? null;
  const inQueue = (id) => queue.some((q) => q.userId === id);

  function partyView(me) {
    const p = partyOf(me);
    const inv = partyInvites.get(me);
    const live = inv && inv.at + INVITE_TTL > Date.now() ? inv : null;
    return {
      party: p ? { id: p.id, members: p.members.map((id) => ({ ...personCard(me, id), me: id === me })) } : null,
      invite: live ? { from: personCard(me, live.from), until: live.at + INVITE_TTL } : null,
      sent: [...partyInvites].filter(([, v]) => v.from === me && v.at + INVITE_TTL > Date.now()).map(([to]) => to),
    };
  }
  function sendParty(id) {
    send(id, { t: 'party', ...partyView(id) });
  }

  class PartyError extends Error {}
  function partyInvite(me, to) {
    const fail = (m) => { throw new PartyError(m); };
    const a = store.get(me);
    const b = store.get(to);
    if (!b || me === to) fail('초대할 수 없는 상대야');
    if (!relations.areFriends(me, to) || relations.isBlocked(me, to)) fail('친구에게만 함께 입장하자고 할 수 있어');
    if (a.profile.gender !== b.profile.gender) fail('이성 친구와는 함께 입장할 수 없어. 같은 성별 친구만 돼');
    if (!isOnline(to)) fail('친구가 접속해 있지 않아');
    if (userRoom.has(me) || userRoom.has(to)) fail('게임 중에는 초대할 수 없어');
    if (inQueue(me) || inQueue(to)) fail('대기 중에는 초대할 수 없어. 대기를 취소하고 다시 해 줘');
    if (partyOf(to)) fail('친구가 이미 다른 사람과 함께 입장하기로 했어');
    const mine = partyOf(me);
    if (mine && mine.members.length >= PARTY_MAX) fail(`함께 입장은 본인 포함 ${PARTY_MAX}명까지야`);
    partyInvites.set(to, { from: me, at: Date.now() });
    sendParty(to);
    sendParty(me);
  }
  function partyRespond(me, accept) {
    const inv = partyInvites.get(me);
    partyInvites.delete(me);
    if (!inv || inv.at + INVITE_TTL < Date.now()) throw new PartyError('초대가 만료됐어');
    const from = inv.from;
    if (accept) {
      // 수락 시점에 다시 확인
      const a = store.get(from);
      const b = store.get(me);
      if (!a || !relations.areFriends(me, from) || a.profile.gender !== b.profile.gender) throw new PartyError('함께 입장할 수 없는 상대야');
      if (userRoom.has(from) || userRoom.has(me)) throw new PartyError('친구가 게임 중이야');
      if (inQueue(from)) leaveQueue(from);
      if (inQueue(me)) leaveQueue(me);
      leaveParty(me, { quiet: true });
      let p = partyOf(from);
      if (p && p.members.length >= PARTY_MAX) throw new PartyError('친구의 일행이 이미 꽉 찼어');
      if (!p) {
        p = { id: shortId(), members: [from], at: Date.now() };
        parties.set(p.id, p);
        userParty.set(from, p.id);
      }
      p.members.push(me);
      userParty.set(me, p.id);
      for (const id of p.members) sendParty(id);
    } else {
      sendParty(from);
      send(from, { t: 'partyNote', text: '친구가 함께 입장 초대를 거절했어' });
    }
    sendParty(me);
  }
  function leaveParty(me, { quiet = false } = {}) {
    const p = partyOf(me);
    if (!p) return;
    if (p.members.some(inQueue)) leaveQueue(me);
    // 2명 일행이라 한 명이 나가면 해산
    for (const id of p.members) {
      userParty.delete(id);
      clearTimeout(partyGrace.get(id));
      partyGrace.delete(id);
    }
    parties.delete(p.id);
    for (const id of p.members) {
      if (id !== me) {
        sendParty(id);
        if (!quiet) send(id, { t: 'partyNote', text: '함께 입장이 해제됐어' });
      }
    }
    sendParty(me);
  }

  function tryFormRoom() {
    for (const id of ids) tryServer(id);
  }
  function tryServer(serverId) {
    if (capacity(serverId, 0, true).reason) return;
    // 선착순 + 나이 조건: 방 안의 모든 남녀 쌍이 서로의 나이 범위 안에 들어야 한다
    // 입장권이 남아 있는 사람만 (대기 중에 날짜가 바뀌는 등)
    const ok = (id) => { const u = store.get(id); return !!u && canEnter(u) && !leaveState(u).blockedUntil; };
    // 동반 입장 일행은 한 명이라도 입장권이 없으면 일행 전체를 이번 방 후보에서 뺀다
    const group = formGroup(queueEntries().filter(q=>(q.serverId ?? first)===serverId).filter((q) => (q.partyId ? queue.filter((x) => x.partyId === q.partyId).every((x) => ok(x.userId)) : ok(q.userId))), config.slots);
    if (!group) return;
    const ids = new Set(group.map((c) => c.userId));
    const chosen = queue.filter((q) => ids.has(q.userId));
    // 방에 들어가면 받은 동반 초대는 의미가 없다
    for (const c of chosen) partyInvites.delete(c.userId);
    for (const c of chosen) queue.splice(queue.indexOf(c), 1);
    const id = `r${Date.now().toString(36)}${(++roomSeq).toString(36)}`;
    // 방이 시작될 때 입장권 1회 사용
    for (const c of chosen) {
      const u = store.get(c.userId);
      if (u && !u.isBot) {
        const kind = consumeEntry(u);
        if (managed && kind) u.pendingGameEntry = { roomId: id, kind };
      }
    }
    store.persist();
    const members = chosen.map((c) => {
      const u = store.get(c.userId);
      return { userId: u.id, profile: u.profile, isBot: u.isBot };
    });
    const room = new Room({ id, config, members, timeScale, voice });
    const worker=workers.get(serverId);
    if(worker) {
      rooms.set(id,{serverId,room,worker,chosen,views:new Map(),openingAt:Date.now()});
      for(const c of chosen) {
        userRoom.set(c.userId,id);
        room.setConnected(room.pidOfUser(c.userId),isOnline(c.userId));
      }
      worker.write({kind:'open',input:{id,config,members,timeScale}});
      return;
    }
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
    rooms.set(id, { room, bots, serverId });
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

  let queueUpdate;
  function broadcastQueue() {
    if(!managed) return flushQueue();
    if(!queueUpdate) queueUpdate=setTimeout(()=>{queueUpdate=null;flushQueue();},100);
  }
  function flushQueue() {
    const waiting=new Set(queue.map(q=>q.userId));
    const common=queueStatus(null);
    for (const userId of sockets.keys()) {
      if (!userRoom.has(userId)) send(userId, { t: 'queue', status: waiting.has(userId)?queueStatus(userId):common });
    }
  }

  function sendState(room, p, permissions) {
    send(p.userId, { t: 'state', view: room.viewFor(p.id,permissions) });
  }

  // ── 관리자 (신고 처리 · 이용 정지) ──
  // 서버 설정 ADMIN_KEY (24자 이상) 를 아는 사람만. 화면: /admin.html
  const adminKey = String(env.ADMIN_KEY ?? '');
  const adminFails = new Map(); // ip → [시각]
  function adminOk(req) {
    if (adminKey.length < 24) return { ok: false, code: 503, error: '관리자 키가 설정돼 있지 않아 (서버 ADMIN_KEY)' };
    const ip = String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    const now = Date.now();
    const fails = (adminFails.get(ip) ?? []).filter((t) => now - t < 10 * 60 * 1000);
    if (fails.length >= 10) return { ok: false, code: 429, error: '잘못된 시도가 많아. 10분 뒤 다시 해 줘' };
    const given = Buffer.from(String(req.headers['x-admin-key'] ?? ''));
    const want = Buffer.from(adminKey);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      fails.push(now);
      adminFails.set(ip, fails);
      return { ok: false, code: 401, error: '관리자 키가 맞지 않아' };
    }
    return { ok: true };
  }
  /** 관리자가 보는 회원 정보 */
  function adminCard(id) {
    const u = store.get(id);
    if (!u) return { id, deleted: true };
    const p = u.profile;
    return {
      id: u.id, gender: p.gender, age: p.age, job: p.job, region: p.region, photoUrl: p.photoUrl,
      createdAt: u.createdAt, linked: (u.identities ?? []).map((k) => k.split(':')[0]), isBot: !!u.isBot,
      online: isOnline(u.id), inGame: userRoom.has(u.id), ban: banOf(u), reportsAgainst: reports.countAgainst(u.id),
      handle: u.handle ?? null, leave: leaveState(u),
    };
  }
  async function handleAdmin(req, res, p, url) {
    const serverId = url.searchParams.get('server') ?? first;
    const monitorKey = Buffer.from(String(env['MONITOR_KEY_'+serverId] ?? ''));
    const given = Buffer.from(String(req.headers['x-monitor-key'] ?? ''));
    const monitoring = req.method==='POST' && p==='/api/admin/health-sample' &&
      monitorKey.length>=24 && given.length===monitorKey.length && timingSafeEqual(given,monitorKey);
    if(!monitoring) {
      const auth=adminOk(req);
      if(!auth.ok) return json(res,auth.code,{error:auth.error});
    }
    const gate = gates.get(serverId);
    if (!gate) return json(res,404,{error:'등록되지 않은 서버'});
    if (p === '/api/admin/capacity' && req.method === 'GET') {
      const snapshot = capacity(serverId);
      pruneLobby(Date.now());
      return json(res, 200, { ...snapshot, ...gate.details(), managed, ids, connections: wss.clients.size,
        lobbyTabs:lobbyTabs.size, lobbyCountLimited:Date.now()-presenceOverflowAt<45000,
        workerHost:workers.get(serverId)?.host ?? null,
        gameLatency:workers.get(serverId)?.recentActions() ?? {},
        workerRss: workers.get(serverId)?.rss ?? null,
        workerRxBytes: workers.get(serverId)?.received ?? null, workerTxBytes: workers.get(serverId)?.sent ?? null,
        lobbyAccounts:[...sockets.keys()].filter(uid=>!userRoom.has(uid) && !inQueue(uid)).length,
        serverConnections:[...sockets].reduce((n,[uid,set])=>n+((rooms.get(userRoom.get(uid))?.serverId===serverId ||
          queue.some(q=>q.userId===uid && q.serverId===serverId)) ? set.size : 0),0),
        onlineAccounts: sockets.size, processRss: process.memoryUsage().rss });
    }
    if (managed && req.method === 'POST' && ['/api/admin/capacity','/api/admin/health-sample'].includes(p)) {
      const body=await readBody(req,2048);
      try {
        if (p.endsWith('capacity')) gate.configure(body);
        else {
          const game = workers.get(serverId)?.recentActions();
          if (game?.gameP95Ms !== undefined && body && typeof body === 'object' &&
              (!body.details || typeof body.details === 'object' && !Array.isArray(body.details))) {
            body.details = { ...body.details, ...game };
          }
          gate.sample(body);
        }
      } catch (err) { if (err instanceof RangeError) return json(res,400,{error:err.message}); throw err; }
      tryServer(serverId);
      if (p.endsWith('capacity')) broadcastQueue();
      return json(res,200,capacity(serverId));
    }
    if (p === '/api/admin/summary' && req.method === 'GET') {
      const users = [...store.users.values()].filter((u) => !u.isBot);
      return json(res, 200, {
        serverStatus: capacity().status,
        connections: wss.clients.size,
        users: users.length,
        online: users.filter((u) => isOnline(u.id)).length,
        queue: queue.length,
        rooms: [...rooms.values()].filter(({ room }) => room.phase !== 'ended').length,
        reportsOpen: reports.list.filter((r) => r.status === 'open').length,
        banned: users.filter((u) => banOf(u)).length,
      });
    }
    if (p === '/api/admin/reports' && req.method === 'GET') {
      const status = url.searchParams.get('status') || 'open';
      const list = reports.list.filter((r) => status === 'all' || r.status === status).slice().reverse().slice(0, 200);
      return json(res, 200, list.map((r) => ({ ...r, reporterCard: adminCard(r.reporter), targetCard: adminCard(r.target) })));
    }
    if (p === '/api/admin/banned' && req.method === 'GET') {
      return json(res, 200, [...store.users.values()].filter((u) => banOf(u)).map((u) => adminCard(u.id)));
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const body = await readBody(req, 8 * 1024);
    try {
      let m;
      if ((m = /^\/api\/admin\/reports\/([0-9a-f]{12})$/.exec(p))) {
        return json(res, 200, reports.update(m[1], { status: body.status, note: body.note }));
      }
      if (p === '/api/admin/ban') {
        const days = body.days === null || body.days === 0 ? null : Number(body.days);
        if (days !== null && !(days > 0 && days <= 3650)) return json(res, 400, { error: '정지 기간이 이상해' });
        const ban = applyBan(String(body.userId ?? ''), { days, reason: body.reason });
        if (body.reportId) reports.update(String(body.reportId), { status: 'resolved', note: body.note ?? undefined, action: `정지 ${days ? `${days}일` : '영구'}` });
        return json(res, 200, { ok: true, ban });
      }
      if (p === '/api/admin/unban') {
        const u = store.get(String(body.userId ?? ''));
        if (!u) return json(res, 404, { error: '회원을 찾을 수 없어' });
        delete u.ban;
        store.persist();
        console.log(`[ban] 해제 ${u.id.slice(0, 8)}`);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/admin/clear-leave') {
        // 무단 이탈 기록·입장 제한 지우기 (통신 장애 등 억울한 경우)
        const u = store.get(String(body.userId ?? ''));
        if (!u) return json(res, 404, { error: '회원을 찾을 수 없어' });
        delete u.leaves;
        delete u.leaveBlockUntil;
        store.persist();
        console.log(`[leave] 기록 삭제 ${u.id.slice(0, 8)}`);
        return json(res, 200, { ok: true });
      }
    } catch (e) {
      if (e instanceof ReportError || /찾을 수 없어/.test(e.message)) return json(res, 400, { error: e.message });
      throw e;
    }
    return json(res, 404, { error: 'not found' });
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
    const alias = relations.aliasFor(me, otherId) || (u.isBot ? '봇' : '');
    return {
      id: u.id,
      alias,
      // 아이디는 친구이거나, 게임에서 만난 적 없이 아이디로 오간 사이에만 보인다 (게임 가명과 연결되지 않게)
      handle: relations.areFriends(me, otherId) || !alias ? u.handle ?? '' : '',
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
    const out = relations.outgoing(me);
    const outgoing = new Set(out.map((r) => r.userId));
    const incoming = keep(relations.incoming(me).map((r) => card(r.userId) && { ...card(r.userId), at: r.at }));
    const sent = keep(out.map((r) => card(r.userId) && { ...card(r.userId), at: r.at }));
    const met = keep([...(relations.met.get(me) ?? [])].reverse().map(([id, m]) => card(id) && { ...card(id), at: m.at, friend: relations.areFriends(me, id), requested: outgoing.has(id) }));
    const matches = (relations.matches.get(me) ?? []).filter((m) => !relations.isBlocked(me, m.partnerId)).map((m) => card(m.partnerId) && { ...card(m.partnerId), at: m.at, roomId: m.roomId }).filter(Boolean);
    const threads = relations.threadsOf(me).map((t) => card(t.userId) && { ...card(t.userId), last: { text: t.last.text, at: t.last.at, mine: t.last.from === me }, unread: t.unread }).filter(Boolean);
    return { friends, incoming, sent, met, matches, threads, unread: threads.reduce((n, t) => n + t.unread, 0) };
  }

  // ── 게임 루프 ───────────────────────────────────────
  let lastSweep = 0;
  const loop = setInterval(() => {
    if (managed && Date.now()-lastSweep >= 1000) {
      lastSweep=Date.now();
      for(const id of ids) gates.get(id).noteReason(capacity(id).reason);
      const expired=queue.filter(q => lastSweep-q.at >= gates.get(q.serverId).policy.queueTtlSeconds*1000);
      for (const q of expired) if (inQueue(q.userId)) leaveQueue(q.userId);
    }
    for (const [id, entry] of rooms) {
      const { room, bots, worker } = entry;
      if (worker && !entry.opened && Date.now() - entry.openingAt > 15000) {
        worker.stop();
        continue;
      }
      if(!worker) {
      bots.tick();
      room.tick();
      if (room.dirty) {
        room.dirty = false;
        const permissions=room.voicePerms();
        for (const p of room.participants.values()) if (!p.isBot) sendState(room, p, permissions);
      }
      }
      // 최종 선택이 끝나면 무단 이탈을 한 번 본다 (결과·연락처 단계에서 나가는 건 괜찮다)
      // 작업 프로세스에서 도는 방은 그쪽이 'leavers' 로 알려 준다
      if (!worker && !room.leaveChecked && ['result', 'contact', 'ended'].includes(room.phase)) {
        room.leaveChecked = true;
        for (const pid of room.leavers()) recordLeave(room.participants.get(pid).userId, id);
      }
      if (room.phase === 'ended' && !room.archived) {
        room.archived = true;
        store.saveGameRecord(id, { id, config: room.cfg, events: room.events, matches: room.matches });
        recordRelations(id, room);
        if (worker) {
          for (const c of entry.chosen) settleEntry(c.userId, id, false);
          store.persist();
        }
        // 기록 저장 후 일정 시간 뒤 방 정리 (결과 화면은 클라이언트가 유지)
        setTimeout(() => {
          for (const p of room.participants.values()) {
            if (userRoom.get(p.userId) === id) userRoom.delete(p.userId);
          }
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

  /** 로그인한 회원. 이용 정지 중이면 null (정지 안내는 /api/me 와 WS 에서 따로 알려 준다) */
  function authUser(req, { allowBanned = false } = {}) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const u = m ? store.byToken(m[1]) : null;
    if (u && !allowBanned && banOf(u)) return null;
    return u;
  }

  // ── 이용 정지 ──
  /** 정지 중이면 { reason, until(null=영구), at }, 아니면 null. 기간이 지난 정지는 지운다 */
  function banOf(u) {
    const b = u?.ban;
    if (!b) return null;
    if (b.until !== null && b.until <= Date.now()) {
      delete u.ban;
      store.persist();
      return null;
    }
    return b;
  }
  // ── 무단 이탈 ──
  const LP = config.leavePenalty;
  /** 최근 windowDays 안의 이탈 기록과 입장 제한 */
  /** 돈을 내고 이용 중인 회원 (월정액 기간 중이거나 유료 입장권이 남아 있음): 입장 제한을 하지 않는다 */
  function isPaidUser(u, now = Date.now()) {
    if (!u || u.isBot) return false;
    const s = entryStatus(u, now);
    return s.subActive || s.tickets > 0;
  }
  function leaveState(u, now = Date.now()) {
    const recent = (u?.leaves ?? []).filter((x) => now - x.at < LP.windowDays * 24 * 3600 * 1000);
    const until = u?.leaveBlockUntil > now && !isPaidUser(u, now) ? u.leaveBlockUntil : null;
    return { count: recent.length, blockedUntil: until };
  }
  function recordLeave(userId, roomId) {
    const u = store.get(userId);
    if (!u || u.isBot) return;
    const now = Date.now();
    u.leaves = [...(u.leaves ?? []).filter((x) => now - x.at < LP.windowDays * 24 * 3600 * 1000), { at: now, roomId }].slice(-20);
    const n = u.leaves.length;
    // 유료 이용자(월정액·유료 입장권)는 산 이용권을 막을 수 없어 기록·경고만 한다
    const paid = isPaidUser(u, now);
    const hours = paid ? 0 : LP.blockHours[Math.min(n, LP.blockHours.length) - 1] ?? 0;
    if (hours > 0) u.leaveBlockUntil = Math.max(u.leaveBlockUntil ?? 0, now + hours * 3600 * 1000);
    store.persist();
    console.log(`[leave] ${userId.slice(0, 8)} 무단 이탈 ${n}회 (최근 ${LP.windowDays}일)${hours ? ` → ${hours}시간 입장 제한` : paid ? ' → 유료 이용자라 기록만' : ' → 경고'}`);
    send(userId, { t: 'leavePenalty', count: n, blockedUntil: hours > 0 ? u.leaveBlockUntil : null, paid });
  }
  const untilText = (at) => new Date(at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  /** 입장 제한 중이면 안내 문구 */
  function leaveBlockMsg(u, who = '') {
    const s = leaveState(u);
    return s.blockedUntil ? `${who}게임 중 무단 이탈이 반복돼서 ${untilText(s.blockedUntil)}까지 무료 입장이 제한돼. (월정액·유료 입장권이 있으면 입장할 수 있어)` : null;
  }

  const banBody = (b) => ({ error: '이용이 정지된 계정이야', banned: { reason: b.reason, until: b.until } });
  function applyBan(userId, { days, reason }) {
    const u = store.get(userId);
    if (!u) throw new Error('회원을 찾을 수 없어');
    u.ban = { reason: String(reason ?? '').slice(0, 200) || '운영 정책 위반', until: days ? Date.now() + days * 24 * 3600 * 1000 : null, at: Date.now() };
    store.persist();
    leaveQueue(userId);
    leaveParty(userId);
    partyInvites.delete(userId);
    for (const ws of sockets.get(userId) ?? []) {
      try { ws.send(JSON.stringify({ t: 'banned', ...banBody(u.ban).banned })); } catch {}
      ws.close(4005, 'banned');
    }
    // 진행 중인 게임에서는 연결 끊김으로 처리된다 (게임 기록은 그대로)
    console.log(`[ban] ${userId.slice(0, 8)} ${days ? `${days}일` : '영구'} — ${u.ban.reason}`);
    return u.ban;
  }

  function meResponse(u) {
    return {
      id: u.id,
      handle: u.handle ?? null,
      profile: u.profile,
      leave: leaveState(u),
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
      if (banOf(existing)) return { status: 403, body: banBody(existing.ban) };
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

  const lobbyTabs = new Map();
  let presenceOverflowAt=0;
  function pruneLobby(now) {
    for(const [id,at] of lobbyTabs) {
      if(now-at<45000) break;
      lobbyTabs.delete(id);
    }
  }
  let publicSnapshot;
  let publicUntil=0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (managed && p==='/api/lobby-presence' && req.method==='POST') {
        const packet=await readBody(req,256);
        if (!packet || !/^[a-f0-9-]{36}$/.test(packet.id) || typeof packet.visible!=='boolean')
          return json(res,400,{error:'invalid presence'});
        const now=Date.now();
        pruneLobby(now);
        lobbyTabs.delete(packet.id);
        if(packet.visible) {
          if(lobbyTabs.size>=50000) {presenceOverflowAt=now;return json(res,429,{ok:false});}
          lobbyTabs.set(packet.id,now);
        }
        res.writeHead(204,{'Cache-Control':'no-store'});return res.end();
      }
      if (p === '/api/server-status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=5' });
        if(Date.now()>=publicUntil) {
          const servers=ids.filter(id=>gates.get(id).policy.enabled).map(id=>({id,status:capacity(id).status}));
          publicSnapshot=JSON.stringify({status:capacity().status,servers});
          publicUntil=Date.now()+5000;
        }
        return res.end(publicSnapshot);
      }
      if (p === '/api/signup' && req.method === 'POST') {
        const body = await readBody(req);
        const profile = validateProfile(body, { minAge: config.minAge });
        // 아이디: 가입 화면에서 받는다 (안 보내면 나중에 친구 화면에서 정한다)
        const handle = body.handle != null && body.handle !== '' ? store.checkHandle(body.handle) : null;
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
        if (handle) {
          try { store.setHandle(u.id, handle); } catch {} // 그 사이 누가 먼저 가져간 경우: 나중에 다시 정한다
        }
        if (ident) store.linkIdentity(u.id, ident.provider, ident.sub);
        return json(res, 200, { token: u.token, me: meResponse(u) });
      }
      if (p === '/api/me' && req.method === 'GET') {
        const u = authUser(req, { allowBanned: true });
        if (u && banOf(u)) return json(res, 403, banBody(u.ban));
        return u ? json(res, 200, meResponse(u)) : json(res, 401, { error: '로그인이 필요하다' });
      }
      // ── 관리자 ──
      if (p.startsWith('/api/admin/')) return handleAdmin(req, res, p, url);
      if (p === '/api/me' && req.method === 'PUT') {
        const u = authUser(req);
        if (!u) return json(res, 401, { error: '로그인이 필요하다' });
        if (userRoom.has(u.id)) return json(res, 409, { error: '게임 중에는 프로필을 바꿀 수 없다' });
        const body = await readBody(req);
        const patch = validateProfile(body, { minAge: config.minAge, partial: true });
        if (patch.gender && patch.gender !== u.profile.gender) leaveQueue(u.id);
        const oldPhoto = u.profile.photoUrl;
        if (body.photo) patch.photoUrl = store.savePhoto(...Object.values(decodeDataUrl(body.photo)));
        store.updateProfile(u.id, patch);
        if (patch.photoUrl && oldPhoto !== patch.photoUrl) store.deletePhoto(oldPhoto); // 예전 사진은 남기지 않는다
        // 나이 조건이 바뀌면 대기열 매칭을 다시 본다
        tryFormRoom();
        broadcastQueue();
        return json(res, 200, meResponse(u));
      }
      // ── 아이디 ──
      if (p === '/api/handle/check' && req.method === 'GET') {
        const me = authUser(req);
        try {
          return json(res, 200, { ok: true, handle: store.checkHandle(url.searchParams.get('h'), me?.id ?? null) });
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message });
        }
      }
      if (p === '/api/me/handle' && req.method === 'POST') {
        const u = authUser(req);
        if (!u) return json(res, 401, { error: '로그인이 필요하다' });
        const body = await readBody(req, 2 * 1024);
        // 바꾸기는 7일에 한 번 (처음 정할 때는 바로)
        const wait = u.handle && u.handleAt ? u.handleAt + 7 * 24 * 3600 * 1000 - Date.now() : 0;
        const next = String(body.handle ?? '').trim().toLowerCase().replace(/^@/, '');
        if (wait > 0 && next !== u.handle) return json(res, 400, { error: `아이디는 7일에 한 번 바꿀 수 있어. ${untilText(Date.now() + wait)}부터 다시 바꿀 수 있어` });
        store.setHandle(u.id, next);
        return json(res, 200, meResponse(u));
      }
      if (p === '/api/users/find' && req.method === 'GET') {
        const u = authUser(req);
        if (!u) return json(res, 401, { error: '로그인이 필요하다' });
        // 아이디를 하나씩 넣어 보며 회원을 훑는 걸 막는다: 1분에 20번
        const now = Date.now();
        const hits = (findHits.get(u.id) ?? []).filter((t) => now - t < 60 * 1000);
        if (hits.length >= 20) return json(res, 429, { error: '너무 많이 찾고 있어. 잠깐 뒤에 다시 해 줘' });
        hits.push(now);
        findHits.set(u.id, hits);
        const t = store.byHandle(url.searchParams.get('handle'));
        if (!t || t.isBot || banOf(t) || relations.isBlocked(u.id, t.id)) return json(res, 404, { error: '그 아이디를 쓰는 사람이 없어' });
        const outgoing = relations.outgoing(u.id).some((r) => r.userId === t.id);
        const incoming = relations.incoming(u.id).some((r) => r.userId === t.id);
        return json(res, 200, {
          id: t.id, handle: t.handle, gender: t.profile.gender, photoUrl: t.profile.photoUrl,
          self: t.id === u.id, friend: relations.areFriends(u.id, t.id), requested: outgoing, incoming,
        });
      }
      // ── 신고 ──
      if (p === '/api/report' && req.method === 'POST') {
        const u = authUser(req);
        if (!u) return json(res, 401, { error: '로그인이 필요하다' });
        const body = await readBody(req, 8 * 1024);
        let target = String(body.userId ?? '');
        let roomId = null;
        let evidence = null;
        const context = ['dm', 'met', 'game'].includes(body.context) ? body.context : 'other';
        if (body.pid) {
          // 게임 중 신고: 같은 방 참가자 번호로 받는다 (상대 회원 ID 는 화면에 없다)
          roomId = userRoom.get(u.id) ?? null;
          const entry = roomId && rooms.get(roomId);
          const tp = entry?.room.participants.get(String(body.pid));
          if (!tp) return json(res, 404, { error: '신고할 참가자를 찾을 수 없어' });
          target = tp.userId;
          evidence = { alias: tp.alias, chat: entry.room.chat.filter((m) => m.from === tp.id).slice(-30).map((m) => ({ channel: m.channel, text: m.text, at: m.at })) };
        } else if (context === 'dm') {
          evidence = { messages: relations.history(u.id, target, { markRead: false }).slice(-30).map((m) => ({ from: m.from === u.id ? 'reporter' : 'target', text: m.text, at: m.at })) };
        }
        if (!store.get(target)) return json(res, 404, { error: '신고할 상대를 찾을 수 없어' });
        if (!body.pid && !relations.hasMet(u.id, target) && !relations.areFriends(u.id, target)) return json(res, 403, { error: '함께한 적 있는 사람만 신고할 수 있어' });
        try {
          const r = reports.add({ reporter: u.id, target, reason: String(body.reason ?? ''), detail: body.detail ?? '', context, roomId, evidence });
          return json(res, 200, { ok: true, id: r.id });
        } catch (e) {
          if (e instanceof ReportError) return json(res, 400, { error: e.message });
          throw e;
        }
      }
      if (p === '/api/report/reasons' && req.method === 'GET') return json(res, 200, REPORT_REASONS);
      // ── 회원 탈퇴 ──
      if (p === '/api/me/delete' && req.method === 'POST') {
        const u = authUser(req);
        if (!u) return json(res, 401, { error: '로그인이 필요하다' });
        const body = await readBody(req, 4 * 1024);
        if (body.confirm !== '탈퇴') return json(res, 400, { error: '확인 문구가 맞지 않아' });
        if (userRoom.has(u.id)) return json(res, 409, { error: '게임 중에는 탈퇴할 수 없어. 게임이 끝난 뒤 다시 해 줘' });
        leaveQueue(u.id);
        leaveParty(u.id);
        partyInvites.delete(u.id);
        for (const [to, v] of partyInvites) if (v.from === u.id) { partyInvites.delete(to); sendParty(to); }
        const touched = new Set([...(relations.friends.get(u.id) ?? []), ...relations.threadsOf(u.id).map((t) => t.userId)]);
        relations.forget(u.id);
        store.deleteUser(u.id);
        for (const id of touched) send(id, { t: 'social' });
        for (const ws of sockets.get(u.id) ?? []) ws.close(4004, 'deleted');
        sockets.delete(u.id);
        console.log(`[account] 탈퇴 ${u.id.slice(0, 8)}`);
        return json(res, 200, { ok: true });
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
          // 아이디로 친구 신청: { handle }
          const byHandle = p === '/api/friends/request' && body.handle != null && body.userId == null ? store.byHandle(body.handle) : null;
          if (p === '/api/friends/request' && body.handle != null && body.userId == null && (!byHandle || byHandle.isBot || banOf(byHandle) || relations.isBlocked(u.id, byHandle.id))) return json(res, 404, { error: '그 아이디를 쓰는 사람이 없어' });
          const other = byHandle ? byHandle.id : String(body.userId ?? body.to ?? '');
          if (!store.get(other)) return json(res, 404, { error: '상대를 찾을 수 없어' });
          if (p === '/api/friends/request') {
            const r = relations.request(u.id, other, { direct: !!byHandle });
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
          if ((p === '/api/friends/remove' || p === '/api/block') && partyOf(u.id)?.members.includes(other)) leaveParty(u.id);
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
          dateRounds: config.randomDate.enabled ? 4 : 3,
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
          managedCapacity:managed,
          activeRooms: [...rooms.values()].filter(({room})=>room.phase!=='ended' &&
            (managed || [...room.participants.values()].some(p=>!p.isBot && p.connected))).length,
          ...(managed ? {updateSafe:queue.length===0 && [...rooms.values()].every(e=>e.room.phase==='ended') &&
            ids.every(id=>{const p=gates.get(id).policy;return !p.enabled || p.blocked || p.maintenance;})} : {}),
        });
      }
      if (p === '/api/dev/fill-bots' && req.method === 'POST') {
        if (!devTools) return json(res, 403, { error: 'DEV_TOOLS 꺼짐' });
        // 대기 중인 사람들의 나이 조건에 모두 맞는 나이로 봇을 만든다 (봇은 나이 조건 없음)
        if (managed) return json(res, 403, { error: '관리 서버에서는 봇 채우기 제한' });
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

    ws.on('message', async (raw) => {
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
        if (banOf(user)) {
          ws.send(JSON.stringify({ t: 'banned', ...banBody(user.ban).banned }));
          const u0 = user;
          user = null;
          return ws.close(4005, `banned ${u0.id.slice(0, 4)}`);
        }
        if (!sockets.has(user.id)) sockets.set(user.id, new Set());
        sockets.get(user.id).add(ws);
        ws.send(JSON.stringify({ t: 'welcome', me: meResponse(user) }));
        clearTimeout(partyGrace.get(user.id));
        partyGrace.delete(user.id);
        sendParty(user.id);
        const rid = userRoom.get(user.id);
        if (rid && rooms.has(rid)) {
          // 재접속: 서버 최신 단계로 복구
          const { room, worker, views } = rooms.get(rid);
          const pid = room.pidOfUser(user.id);
          room.setConnected(pid, true);
          if(worker) {
            if(room.phase==='ended' && views.has(user.id)) send(user.id,{t:'state',view:views.get(user.id)});
            else worker.write({kind:'connected',id:rid,pid,connected:true});
          } else sendState(room, room.participants.get(pid));
        } else {
          ws.send(JSON.stringify({ t: 'queue', status: queueStatus(user.id) }));
        }
        return;
      }
      if (msg.t === 'queue.join') return joinQueue(user, msg.serverId);
      if (msg.t === 'queue.leave') return leaveQueue(user.id);
      if (msg.t === 'party.invite' || msg.t === 'party.respond' || msg.t === 'party.leave') {
        try {
          if (msg.t === 'party.invite') partyInvite(user.id, String(msg.to ?? ''));
          if (msg.t === 'party.respond') partyRespond(user.id, !!msg.accept);
          if (msg.t === 'party.leave') leaveParty(user.id);
        } catch (e) {
          if (!(e instanceof PartyError)) throw e;
          send(user.id, { t: 'partyNote', text: e.message, error: true });
          sendParty(user.id);
        }
        return;
      }
      if (msg.t === 'act') {
        const rid = userRoom.get(user.id);
        const entry = rid && rooms.get(rid);
        if (!entry) return ws.send(JSON.stringify({ t: 'ack', reqId: msg.reqId, ok: false, error: '진행 중인 방이 없다' }));
        const pid = entry.room.pidOfUser(user.id);
        const r = entry.worker ? await entry.worker.action(rid,pid,msg.action ?? {}) : entry.room.handle(pid, msg.action ?? {});
        if(ws.readyState===1) ws.send(JSON.stringify({ t: 'ack', reqId: msg.reqId, ok: r.ok, error: r.error }));
      }
      if (msg.t === 'dev') {
        if (!devTools) return;
        const entry = rooms.get(userRoom.get(user.id));
        if (!entry || entry.worker) return;
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
        // [임시] 대기열에 있던 사람은 연결이 끊기면 대기열에서 뺀다 (동반 일행도 함께)
        if (!userRoom.has(user.id)) leaveQueue(user.id);
        // 동반 입장: 새로고침 정도는 기다려 주고, 30초 넘게 안 돌아오면 해산
        const uid = user.id;
        if (partyOf(uid) || partyInvites.has(uid)) {
          clearTimeout(partyGrace.get(uid));
          partyGrace.set(uid, setTimeout(() => {
            partyGrace.delete(uid);
            if (isOnline(uid)) return;
            partyInvites.delete(uid);
            if (!userRoom.has(uid)) leaveParty(uid);
          }, 30 * 1000).unref());
        }
        const rid = userRoom.get(user.id);
        if (rid && rooms.has(rid)) {
          const { room, worker } = rooms.get(rid);
          const pid=room.pidOfUser(user.id);
          room.setConnected(pid,false);
          worker?.write({kind:'connected',id:rid,pid,connected:false});
        }
      }
    });
  });

  return {
    server,
    rooms,
    store,
    rel: relations,
    reports,
    voice,
    config,
    listen(port, host = opts.dataDir === null ? '127.0.0.1' : undefined) {
      return new Promise((r) => server.listen(port, host, () => r(server.address().port)));
    },
    close() {
      shuttingDown=true;
      for(const timer of restartTimers.values()) clearTimeout(timer);
      clearInterval(loop);
      clearTimeout(queueUpdate);
      for(const worker of workers.values()) worker.stop();
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
