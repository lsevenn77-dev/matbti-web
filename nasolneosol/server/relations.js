// 게임 밖 관계: 함께한 사람 · 친구 · 나의 인연(최종 매칭) · 1:1 메시지 · 차단
//
// 규칙
// - 친구 신청은 같은 게임에서 만난 사람에게만 할 수 있다 (모르는 사람의 신청·스팸 방지)
// - 1:1 메시지는 친구이거나 최종 매칭된 상대끼리만 주고받는다
// - 한쪽이라도 차단하면 신청·메시지가 모두 막히고 목록에서 숨는다
//
// 시제품: data/relations.json 한 파일에 저장한다. [임시] 실제 서비스에서는 DB 로 옮긴다.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const LIMITS = {
  metPerUser: 60, // 함께한 사람 목록 최대 (오래된 것부터 정리)
  pendingOut: 30, // 보낸 친구 신청 최대
  friends: 200,
  messageLen: 500,
  threadKeep: 500, // 대화방마다 보관하는 메시지 수
  minGapMs: 400, // 메시지 연속 전송 간격
};

export class RelationError extends Error {}
const fail = (m) => { throw new RelationError(m); };
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class Relations {
  constructor(dir, { now = Date.now } = {}) {
    this.file = dir ? path.join(dir, 'relations.json') : null;
    this.now = now;
    this.met = new Map(); // userId → Map(otherId → { at, roomId, alias })
    this.matches = new Map(); // userId → [{ partnerId, roomId, at, alias }]
    this.friends = new Map(); // userId → Set(otherId)
    this.requests = new Map(); // toId → Map(fromId → at)
    this.blocks = new Map(); // userId → Set(blockedId)
    this.threads = new Map(); // pairKey → [{ id, from, text, at }]
    this.readAt = new Map(); // `${userId}>${pairKey}` → 마지막으로 읽은 시각
    this.lastSent = new Map(); // userId → at (메모리만)
    this.load();
  }

  // ───────── 저장 ─────────
  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const [u, list] of Object.entries(j.met ?? {})) this.met.set(u, new Map(list.map((x) => [x.id, { at: x.at, roomId: x.roomId, alias: x.alias }])));
    for (const [u, list] of Object.entries(j.matches ?? {})) this.matches.set(u, list);
    for (const [u, list] of Object.entries(j.friends ?? {})) this.friends.set(u, new Set(list));
    for (const [to, m] of Object.entries(j.requests ?? {})) this.requests.set(to, new Map(Object.entries(m)));
    for (const [u, list] of Object.entries(j.blocks ?? {})) this.blocks.set(u, new Set(list));
    for (const [k, list] of Object.entries(j.threads ?? {})) this.threads.set(k, list);
    for (const [k, at] of Object.entries(j.readAt ?? {})) this.readAt.set(k, at);
  }

  persist() {
    if (!this.file) return;
    const o = (m, f) => Object.fromEntries([...m].map(([k, v]) => [k, f(v)]));
    const j = {
      met: o(this.met, (m) => [...m].map(([id, x]) => ({ id, ...x }))),
      matches: o(this.matches, (x) => x),
      friends: o(this.friends, (s) => [...s]),
      requests: o(this.requests, (m) => Object.fromEntries(m)),
      blocks: o(this.blocks, (s) => [...s]),
      threads: o(this.threads, (x) => x),
      readAt: Object.fromEntries(this.readAt),
    };
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(j));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  // ───────── 게임 기록 ─────────
  /**
   * 끝난 게임 한 판을 기록한다.
   * @param {{ roomId: string, people: { userId: string, alias: string }[], couples: [string, string][] }} game  couples 는 userId 쌍
   */
  recordGame({ roomId, people, couples }) {
    const at = this.now();
    for (const a of people) {
      const m = this.met.get(a.userId) ?? new Map();
      for (const b of people) {
        if (a.userId === b.userId) continue;
        m.delete(b.userId); // 다시 만나면 최신으로
        m.set(b.userId, { at, roomId, alias: b.alias });
      }
      while (m.size > LIMITS.metPerUser) m.delete(m.keys().next().value);
      this.met.set(a.userId, m);
    }
    const aliasOf = new Map(people.map((p) => [p.userId, p.alias]));
    for (const [x, y] of couples) {
      for (const [me, other] of [[x, y], [y, x]]) {
        const list = this.matches.get(me) ?? [];
        list.unshift({ partnerId: other, roomId, at, alias: aliasOf.get(other) ?? '' });
        this.matches.set(me, list.slice(0, 100));
      }
    }
    this.persist();
  }

  // ───────── 조회 ─────────
  isBlocked(a, b) {
    return !!(this.blocks.get(a)?.has(b) || this.blocks.get(b)?.has(a));
  }
  areFriends(a, b) {
    return !!this.friends.get(a)?.has(b);
  }
  isMatched(a, b) {
    return (this.matches.get(a) ?? []).some((m) => m.partnerId === b);
  }
  hasMet(a, b) {
    return !!this.met.get(a)?.has(b);
  }
  canMessage(a, b) {
    return a !== b && !this.isBlocked(a, b) && (this.areFriends(a, b) || this.isMatched(a, b));
  }
  /** 이 사람을 부를 이름: 함께한 게임에서의 가명 */
  aliasFor(me, other) {
    return this.met.get(me)?.get(other)?.alias ?? '';
  }
  incoming(me) {
    return [...(this.requests.get(me) ?? new Map())].filter(([from]) => !this.isBlocked(me, from)).map(([from, at]) => ({ userId: from, at }));
  }
  outgoing(me) {
    const out = [];
    for (const [to, m] of this.requests) if (m.has(me) && !this.isBlocked(me, to)) out.push({ userId: to, at: m.get(me) });
    return out;
  }

  // ───────── 친구 ─────────
  request(from, to) {
    if (from === to) fail('나에게는 신청할 수 없어');
    if (this.isBlocked(from, to)) fail('친구 신청을 보낼 수 없는 상대야');
    if (!this.hasMet(from, to)) fail('같은 게임에서 만난 사람에게만 신청할 수 있어');
    if (this.areFriends(from, to)) fail('이미 친구야');
    if ((this.friends.get(from)?.size ?? 0) >= LIMITS.friends) fail('친구가 너무 많아');
    // 상대가 이미 나에게 신청했다면 바로 친구가 된다
    if (this.requests.get(from)?.has(to)) return this.respond(from, to, true);
    if (this.outgoing(from).length >= LIMITS.pendingOut) fail('보낸 신청이 너무 많아. 기다리는 신청을 정리해 줘');
    const m = this.requests.get(to) ?? new Map();
    m.set(from, this.now());
    this.requests.set(to, m);
    this.persist();
    return { status: 'requested' };
  }

  respond(me, from, accept) {
    const m = this.requests.get(me);
    if (!m?.has(from)) fail('받은 신청이 없어');
    m.delete(from);
    if (accept && !this.isBlocked(me, from)) {
      for (const [a, b] of [[me, from], [from, me]]) {
        const s = this.friends.get(a) ?? new Set();
        s.add(b);
        this.friends.set(a, s);
      }
      this.persist();
      return { status: 'friends' };
    }
    this.persist();
    return { status: 'declined' };
  }

  cancel(from, to) {
    this.requests.get(to)?.delete(from);
    this.persist();
  }

  unfriend(a, b) {
    this.friends.get(a)?.delete(b);
    this.friends.get(b)?.delete(a);
    this.persist();
  }

  block(me, other) {
    if (me === other) fail('나를 차단할 수는 없어');
    const s = this.blocks.get(me) ?? new Set();
    s.add(other);
    this.blocks.set(me, s);
    this.unfriend(me, other);
    this.requests.get(me)?.delete(other);
    this.requests.get(other)?.delete(me);
    this.persist();
  }

  unblock(me, other) {
    this.blocks.get(me)?.delete(other);
    this.persist();
  }

  /** 회원 탈퇴: 이 사람이 들어 있는 관계·대화를 모두 지운다 */
  forget(userId) {
    this.met.delete(userId);
    for (const m of this.met.values()) m.delete(userId);
    this.matches.delete(userId);
    for (const [k, list] of this.matches) this.matches.set(k, list.filter((x) => x.partnerId !== userId));
    this.friends.delete(userId);
    for (const s of this.friends.values()) s.delete(userId);
    this.requests.delete(userId);
    for (const m of this.requests.values()) m.delete(userId);
    this.blocks.delete(userId);
    for (const s of this.blocks.values()) s.delete(userId);
    for (const key of [...this.threads.keys()]) {
      if (key.split('|').includes(userId)) this.threads.delete(key);
    }
    for (const key of [...this.readAt.keys()]) {
      if (key.startsWith(`${userId}>`) || key.split('>')[1].split('|').includes(userId)) this.readAt.delete(key);
    }
    this.lastSent.delete(userId);
    this.persist();
  }

  // ───────── 메시지 ─────────
  send(from, to, text) {
    const t = String(text ?? '').replace(/\s+$/u, '').replace(/^\s+/u, '');
    if (!t) fail('내용을 입력해 줘');
    if (t.length > LIMITS.messageLen) fail(`메시지는 ${LIMITS.messageLen}자까지 보낼 수 있어`);
    if (!this.canMessage(from, to)) fail('친구이거나 최종 매칭된 상대에게만 메시지를 보낼 수 있어');
    const now = this.now();
    if (now - (this.lastSent.get(from) ?? 0) < LIMITS.minGapMs) fail('너무 빨리 보내고 있어. 잠깐만 기다려 줘');
    this.lastSent.set(from, now);
    const key = pairKey(from, to);
    const list = this.threads.get(key) ?? [];
    const msg = { id: randomBytes(6).toString('hex'), from, text: t, at: now };
    list.push(msg);
    if (list.length > LIMITS.threadKeep) list.splice(0, list.length - LIMITS.threadKeep);
    this.threads.set(key, list);
    this.readAt.set(`${from}>${key}`, now);
    this.persist();
    return msg;
  }

  /** 대화 내용 (읽음 처리) */
  history(me, other, { markRead = true } = {}) {
    const key = pairKey(me, other);
    const list = this.threads.get(key) ?? [];
    if (markRead && list.length) {
      this.readAt.set(`${me}>${key}`, list[list.length - 1].at);
      this.persist();
    }
    return list;
  }

  /** 내 대화방 목록: 최근 메시지 순 */
  threadsOf(me) {
    const out = [];
    for (const [key, list] of this.threads) {
      const [a, b] = key.split('|');
      if (a !== me && b !== me) continue;
      const other = a === me ? b : a;
      if (this.isBlocked(me, other) || !list.length) continue;
      const read = this.readAt.get(`${me}>${key}`) ?? 0;
      const unread = list.filter((m) => m.from !== me && m.at > read).length;
      out.push({ userId: other, last: list[list.length - 1], unread });
    }
    return out.sort((x, y) => y.last.at - x.last.at);
  }

  unreadTotal(me) {
    return this.threadsOf(me).reduce((n, t) => n + t.unread, 0);
  }
}
