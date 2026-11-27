// 한 회차(방)의 진행 엔진.
//
// - 모든 판정은 서버에서 한다. 클라이언트는 행동(action)만 보낸다.
// - 시간은 서버 시각(now) 기준 endsAt 으로 관리한다. tick(now) 가 단계를 넘긴다.
// - 공개 정보는 viewFor(참가자) 에서 서버가 골라 보낸다. 비공개 필드는 아예 전송하지 않는다.
// - now / rng 를 주입받아 테스트에서 결정적으로 돌릴 수 있다.

import { ALIASES, CHARACTERS, TREASURE_SPOTS } from './config.js';

const OTHER = { male: 'female', female: 'male' };
const DATE_PHASES = new Set(['date1', 'date2', 'date3', 'date4']);
// 자유 구경 이동 범위 (client/public/scene.js 의 월드 배치와 맞춘다)
export const WORLD = { minX: -24, maxX: 24, minZ: -26, maxZ: 10 };

export class Room {
  /**
   * @param {object} o
   * @param {string} o.id
   * @param {object} o.config  makeConfig() 결과
   * @param {Array<{userId:string, profile:object}>} o.members  성별별 입장 순서대로
   * @param {() => number} [o.now]
   * @param {() => number} [o.rng]
   * @param {number} [o.timeScale]  1 = 실제 시간, 10 = 10배 빠르게
   * @param {object} [o.voice]  음성 어댑터
   */
  constructor({ id, config, members, now = Date.now, rng = Math.random, timeScale = 1, voice = null }) {
    this.id = id;
    this.cfg = config;
    this.now = now;
    this.rng = rng;
    this.timeScale = timeScale;
    this.voice = voice;
    this.dirty = true;
    this.events = []; // 영속 저장 대상 이벤트 (투표·데이트권·최종 선택 결과 등)
    this.chat = []; // { id, channel, from, text, at }
    this.chatSeq = 0;
    this.listeners = new Set();

    const counters = { male: 0, female: 0 };
    this.participants = new Map();
    for (const m of members) {
      const g = m.profile.gender;
      const idx = counters[g]++;
      if (idx >= config.slots[g]) throw new Error(`${g} 슬롯 초과`);
      const slot = g === 'male' ? idx : config.slots.male + idx;
      const pid = `p${slot + 1}`;
      this.participants.set(pid, {
        id: pid,
        userId: m.userId,
        gender: g,
        slotIndex: idx,
        alias: ALIASES[g][idx],
        characterId: CHARACTERS[slot % CHARACTERS.length].id,
        profile: m.profile, // 비공개 필드 포함 — viewFor 에서만 걸러서 내보낸다
        connected: false,
        revealed: false,
        pos: null,
        isBot: !!m.isBot,
      });
    }
    if (counters.male !== config.slots.male || counters.female !== config.slots.female) {
      throw new Error('성별 슬롯 인원이 맞지 않는다');
    }

    this.phases = buildPhaseList(config);
    this.phaseIndex = -1;
    this.phase = 'waiting';
    this.phaseStartedAt = now();
    this.phaseEndsAt = null;

    this.voterGender = null;
    this.votes = {}; // firstVote: voter → target | null(기권)
    this.dates = { date1: [], date2: [], date3: [], date4: [] }; // [{ id, members:[pid] }]
    this.intro = null;
    this.minigame = null;
    this.pick = null;
    this.finalVotes = {};
    this.matches = [];
    this.contact = {}; // pid → { consent, contact }
  }

  // ───────────────────────── 시간 ─────────────────────────

  ms(sec) {
    return Math.round((sec * 1000) / this.timeScale);
  }

  start() {
    if (this.phase !== 'waiting') return;
    // 시작할 때 이미 접속해 있지 않은 사람은 지금부터 나가 있는 것으로 센다
    for (const p of this.participants.values()) if (!p.isBot && !p.connected && p.absentSince == null) p.absentSince = this.now();
    this.enterPhase(0);
  }

  /** 지금까지 한 번에 가장 오래 나가 있던 시간 (지금 나가 있는 중이면 그 시간도 포함) */
  longestAbsenceMs(pid, t = this.now()) {
    const p = this.participants.get(pid);
    if (!p) return 0;
    return Math.max(p.maxAbsentMs ?? 0, p.absentSince != null ? t - p.absentSince : 0);
  }

  /** 무단 이탈한 참가자 (봇 제외). 최종 선택이 끝난 뒤 한 번 본다 */
  leavers(t = this.now()) {
    const lim = this.ms(this.cfg.leavePenalty?.absentSec ?? 180);
    return [...this.participants.values()].filter((p) => !p.isBot && this.longestAbsenceMs(p.id, t) >= lim).map((p) => p.id);
  }

  tick() {
    const t = this.now();
    if (this.phase === 'waiting' || this.phase === 'ended') return;
    if (this.phase === 'selfIntro') this.tickIntro(t);
    if (this.phase === 'minigame') this.tickMinigame(t);
    if (this.phase === 'date3Pick') this.tickPick(t);
    if (this.phase === 'randomAssign') this.tickLadder(t);
    if (this.phaseEndsAt != null && t >= this.phaseEndsAt) this.advance();
  }

  /** 개발 도구: 배속 바꾸기. 진행 중인 단계의 남은 시간도 새 배속에 맞춘다 */
  devSetSpeed(scale) {
    scale = Math.max(1, Math.min(60, Number(scale) || 1));
    const t = this.now();
    const k = this.timeScale / scale;
    const re = (x) => (x == null ? x : t + Math.max(0, x - t) * k);
    this.phaseEndsAt = re(this.phaseEndsAt);
    if (this.pick?.turnEndsAt != null) this.pick.turnEndsAt = re(this.pick.turnEndsAt);
    if (this.ladder && !this.ladder.revealed) this.ladder.revealAt = re(this.ladder.revealAt);
    if (this.intro) for (const key of ['speakerEndsAt', 'gapUntil']) if (this.intro[key] != null) this.intro[key] = re(this.intro[key]);
    this.timeScale = scale;
    this.markDirty();
  }

  /** 개발 도구: 지금 단계를 끝내고 다음 단계로 */
  devSkip() {
    if (this.phase === 'waiting' || this.phase === 'ended') return;
    this.advance();
  }

  advance() {
    this.exitPhase(this.phase);
    this.enterPhase(this.phaseIndex + 1);
  }

  enterPhase(i) {
    this.phaseIndex = i;
    this.phase = this.phases[i] ?? 'ended';
    const t = this.now();
    this.phaseStartedAt = t;
    for (const p of this.participants.values()) p.pos = null; // 단계가 바뀌면 각자 정해진 자리에서 시작
    const d = this.cfg.durations[this.phase];
    this.phaseEndsAt = d != null ? t + this.ms(d) : null;
    const fn = this[`enter_${this.phase}`];
    if (fn) fn.call(this, t);
    this.log('phase', { phase: this.phase });
    this.syncVoice();
    this.markDirty();
  }

  exitPhase(phase) {
    const fn = this[`exit_${phase}`];
    if (fn) fn.call(this);
  }

  // ───────────────────────── 단계별 진입/종료 ─────────────────────────

  enter_intro() {
    // 첫인상 투표는 남녀 전원이 한다. 1차는 voterGender 의 선택으로, 2차는 반대 성별의 선택으로 데이트한다
    const vg = this.cfg.firstVote.voterGender;
    this.voterGender = vg === 'random' ? (this.rng() < 0.5 ? 'male' : 'female') : vg;
    this.secondGender = OTHER[this.voterGender];
    this.log('voterGender', { voterGender: this.voterGender, secondGender: this.secondGender });
  }

  enter_firstVote() {
    this.votes = {};
  }

  /** 한 성별의 첫인상 선택 → 데이트 그룹 (고른 사람 + 같은 사람을 고른 사람들) */
  groupsFromVotes(gender, prefix) {
    const groups = new Map();
    for (const p of this.byGender(gender)) {
      const target = this.votes[p.id];
      if (!target) continue;
      if (!groups.has(target)) groups.set(target, []);
      groups.get(target).push(p.id);
    }
    const cap = this.cfg.firstVote.groupCap;
    const list = [];
    for (const [target, voters] of groups) {
      // 상한이 있으면 먼저 투표한 순서대로 자른다 [임시]
      const kept = cap ? voters.slice(0, cap) : voters;
      list.push({ id: `${prefix}-${list.length}`, members: [target, ...kept], focus: target });
    }
    return list;
  }

  exit_firstVote() {
    // 미제출은 기권 처리 [임시]
    for (const p of this.participants.values()) if (!(p.id in this.votes)) this.votes[p.id] = null;
    this.dates.date1 = this.groupsFromVotes(this.voterGender, 'd1');
    this.dates.date2 = this.groupsFromVotes(this.secondGender, 'd2');
    this.log('date1Groups', { gender: this.voterGender, groups: this.dates.date1.map((g) => g.members) });
    this.log('date2Groups', { gender: this.secondGender, groups: this.dates.date2.map((g) => g.members) });
  }

  enter_date1() {}

  enter_freeRoam() {}

  enter_selfIntro(t) {
    const all = [...this.participants.values()];
    let order;
    if (this.cfg.selfIntro.order === 'alternate') {
      const first = this.byGender(this.voterGender);
      const second = this.byGender(OTHER[this.voterGender]);
      order = [];
      for (let i = 0; i < Math.max(first.length, second.length); i++) {
        if (first[i]) order.push(first[i].id);
        if (second[i]) order.push(second[i].id);
      }
    } else {
      order = all.map((p) => p.id);
    }
    this.intro = { order, index: -1, speakerId: null, speakerEndsAt: null, gapUntil: null, done: [], skipped: [] };
    this.phaseEndsAt = null; // 발표자 진행이 끝나면 넘어간다
    this.nextSpeaker(t, false);
  }

  nextSpeaker(t, withGap = true) {
    const it = this.intro;
    if (it.speakerId) {
      it.done.push(it.speakerId);
      if (this.cfg.profileReveal === 'afterEach') this.reveal(it.speakerId);
    }
    it.index += 1;
    it.speakerId = null;
    if (it.index >= it.order.length) {
      // 전원 소개 종료 → 다음 단계
      it.finished = true;
      this.phaseEndsAt = t; // 다음 tick 에서 advance
      this.syncVoice();
      this.markDirty();
      return;
    }
    if (withGap && this.cfg.durations.introGap > 0) {
      it.gapUntil = t + this.ms(this.cfg.durations.introGap);
      it.speakerEndsAt = null;
    } else {
      this.startSpeaker(t);
    }
    this.syncVoice();
    this.markDirty();
  }

  startSpeaker(t) {
    const it = this.intro;
    it.gapUntil = null;
    it.speakerId = it.order[it.index];
    it.speakerStartedAt = t;
    it.qna = false;
    it.qnaStartedAt = null;
    it.speakerEndsAt = t + this.ms(this.cfg.durations.introPerSpeaker);
    this.syncVoice();
    this.markDirty();
  }

  /** 소개가 끝나면 질문 시간: 청중은 채팅으로 묻고 발표자는 음성으로 답한다 */
  startQnA(t) {
    const it = this.intro;
    it.qna = true;
    it.qnaStartedAt = t;
    it.speakerEndsAt = t + this.ms(this.cfg.durations.introQnA);
    this.markDirty();
  }

  /** 발표자 시간이 끝났을 때: 소개 → 질문 → 다음 사람 */
  endSpeakerPart(t) {
    if (!this.intro.qna && (this.cfg.durations.introQnA ?? 0) > 0) this.startQnA(t);
    else this.nextSpeaker(t);
  }

  tickIntro(t) {
    const it = this.intro;
    if (!it || it.finished) return;
    if (it.gapUntil != null) {
      if (t >= it.gapUntil) this.startSpeaker(t);
      return;
    }
    if (!it.speakerId) return;
    const sp = this.participants.get(it.speakerId);
    if (!sp.connected && t - it.speakerStartedAt >= this.ms(this.cfg.selfIntro.skipIfAbsentSec)) {
      it.skipped.push(sp.id);
      this.log('introSkipped', { pid: sp.id });
      this.nextSpeaker(t);
      return;
    }
    if (t >= it.speakerEndsAt) this.endSpeakerPart(t);
  }

  exit_selfIntro() {
    for (const p of this.participants.values()) this.reveal(p.id);
  }

  enter_minigame(t) {
    const mg = this.cfg.minigame;
    // 남녀 전원이 참여한다. 데이트권은 성별마다 따로 (남자 보물·여자 보물)
    const players = [...this.participants.keys()];
    if (mg.type === 'treasure') {
      const per = this.cfg.pick.ticketsPerGender;
      const total = { male: Math.min(per, this.byGender('male').length), female: Math.min(per, this.byGender('female').length) };
      const at = t + this.ms(mg.firstSpawnSec);
      this.minigame = { type: 'treasure', players, total, found: [], active: { male: null, female: null }, seq: 0, lastSpot: -1, nextSpawnAt: { male: at, female: at }, ranking: null };
      this.markDirty();
      return;
    }
    this.minigame = { type: 'reaction', players, round: -1, rounds: [], results: {}, ranking: null };
    this.startMinigameRound(t + this.ms(2));
  }

  // ── 보물찾기 ──
  /** 참가자 위치 (아직 안 움직였으면 마당 가운데에서 시작) */
  hunterPos(pid) {
    return this.participants.get(pid)?.pos ?? { x: 0, z: 0 };
  }

  /** gender 성별이 찾을 보물을 하나 놓는다 (다른 성별 보물과 다른 곳, 사람들에게서 떨어진 곳) */
  spawnTreasure(gender, t) {
    const m = this.minigame;
    const mg = this.cfg.minigame;
    const hunters = m.players.map((pid) => this.hunterPos(pid));
    const other = m.active[OTHER[gender]];
    const far = (x, z) => hunters.every((h) => Math.hypot(h.x - x, h.z - z) >= mg.minSpawnDist) && (!other || Math.hypot(other.x - x, other.z - z) >= 6);
    const prev = m.active[gender]?.spot ?? -1;
    let idxs = TREASURE_SPOTS.map((_, i) => i).filter((i) => i !== prev && far(...TREASURE_SPOTS[i]));
    if (!idxs.length) idxs = TREASURE_SPOTS.map((_, i) => i).filter((i) => i !== prev);
    const i = idxs[Math.floor(this.rng() * idxs.length)];
    const [sx, sz] = TREASURE_SPOTS[i];
    m.active[gender] = { id: `t${++m.seq}`, gender, spot: i, x: Math.round((sx + (this.rng() - 0.5) * 1.2) * 100) / 100, z: Math.round((sz + (this.rng() - 0.5) * 1.2) * 100) / 100, since: t };
    const a = m.active[gender];
    this.log('treasureSpawn', { id: a.id, gender, x: a.x, z: a.z });
    this.markDirty();
  }

  foundCount(gender) {
    return this.minigame.found.filter((f) => f.gender === gender).length;
  }

  /** 이동할 때마다 보물 위에 섰는지 본다 */
  checkTreasure(p, prev, t) {
    const m = this.minigame;
    const mg = this.cfg.minigame;
    if (!m || m.type !== 'treasure' || m.ranking) return;
    const tr = m.active[p.gender];
    if (!tr || !m.players.includes(p.id) || m.found.some((f) => f.pid === p.id)) return;
    // 순간이동 막기: 직전 위치에서 너무 빨리 왔으면 인정하지 않는다
    if (prev) {
      const dt = Math.max(0.05, ((t - prev.at) / 1000) * this.timeScale);
      if (Math.hypot(p.pos.x - prev.x, p.pos.z - prev.z) > mg.maxSpeed * dt + 1) return;
    }
    if (Math.hypot(p.pos.x - tr.x, p.pos.z - tr.z) > mg.touchRadius) return;
    m.found.push({ pid: p.id, gender: p.gender, at: t, sec: Math.round((t - this.phaseStartedAt) / 100) / 10, treasure: tr.id });
    this.log('treasureFound', { pid: p.id, id: tr.id });
    m.active[p.gender] = null;
    const [a, b] = mg.nextSpawnSec;
    m.nextSpawnAt[p.gender] = t + this.ms(a + this.rng() * (b - a));
    this.markDirty();
  }

  /** 이 성별의 보물찾기가 끝났는지: 데이트권을 다 찾았거나 찾을 사람이 남지 않음 */
  treasureDone(gender) {
    const m = this.minigame;
    const left = this.byGender(gender).filter((p) => !m.found.some((f) => f.pid === p.id));
    return this.foundCount(gender) >= m.total[gender] || !left.length;
  }

  tickTreasure(t) {
    const m = this.minigame;
    const mg = this.cfg.minigame;
    if (this.treasureDone('male') && this.treasureDone('female')) return this.finishMinigame();
    for (const g of ['male', 'female']) {
      if (this.treasureDone(g)) {
        m.active[g] = null;
        continue;
      }
      const a = m.active[g];
      if (!a && t >= m.nextSpawnAt[g]) this.spawnTreasure(g, t);
      else if (a && t - a.since >= this.ms(mg.relocateSec)) {
        this.log('treasureMoved', { id: a.id });
        this.spawnTreasure(g, t); // 오래 못 찾으면 다른 곳으로
      }
    }
  }

  startMinigameRound(t) {
    const m = this.minigame;
    const mg = this.cfg.minigame;
    m.round += 1;
    const delay = mg.minDelaySec + this.rng() * (mg.maxDelaySec - mg.minDelaySec);
    // 신호 시각은 미리 알려주지 않는다 (viewFor 에서 goAt 은 신호 이후에만 노출)
    m.rounds[m.round] = { startAt: t, goAt: t + this.ms(delay), endAt: t + this.ms(delay + mg.windowSec), taps: {} };
    this.markDirty();
  }

  tickMinigame(t) {
    const m = this.minigame;
    if (!m || m.ranking) return;
    if (m.type === 'treasure') return this.tickTreasure(t);
    const r = m.rounds[m.round];
    if (r && !r.goSent && t >= r.goAt) {
      r.goSent = true;
      this.markDirty();
    }
    const allIn = m.players.every((p) => p in r.taps);
    if (t >= r.endAt || (allIn && t >= r.goAt)) {
      if (m.round + 1 < this.cfg.minigame.rounds) this.startMinigameRound(t + this.ms(1.5));
      else this.finishMinigame();
    }
  }

  finishMinigame() {
    const m = this.minigame;
    if (m.type === 'treasure') {
      // 데이트권: 찾은 사람(찾은 순서) + 성별마다 못 찾은 표는 남은 사람 중 추첨. 지목 순서는 찾은 사람 먼저, 추첨된 사람은 뒤에
      m.active = { male: null, female: null };
      const drawn = [];
      for (const g of ['male', 'female']) {
        const need = m.total[g] - this.foundCount(g);
        const pool = this.byGender(g).map((p) => p.id).filter((pid) => !m.found.some((f) => f.pid === pid)).map((pid) => ({ pid, r: this.rng() })).sort((a, b) => a.r - b.r);
        for (const x of pool.slice(0, Math.max(0, need))) drawn.push({ pid: x.pid, gender: g, r: this.rng() });
      }
      drawn.sort((a, b) => a.r - b.r);
      const holders = [...m.found.map((f) => ({ pid: f.pid, gender: f.gender, found: true, sec: f.sec })), ...drawn.map((d) => ({ pid: d.pid, gender: d.gender, found: false, drawn: true }))];
      m.ranking = holders.map((h, i) => ({ ...h, rank: i + 1 }));
      this.log('minigameResult', { type: 'treasure', ranking: m.ranking });
      this.phaseEndsAt = Math.min(this.phaseEndsAt, this.now() + this.ms(6));
      this.markDirty();
      return;
    }
    const pen = this.cfg.minigame.missPenaltyMs;
    const scores = m.players.map((pid) => {
      const total = m.rounds.reduce((s, r) => s + (r.taps[pid]?.ms ?? pen), 0);
      return { pid, total, tie: this.rng() };
    });
    // 동률은 무작위로 정하고 기록한다 [임시]
    scores.sort((a, b) => a.total - b.total || a.tie - b.tie);
    m.ranking = scores.map((s, i) => ({ pid: s.pid, rank: i + 1, totalMs: s.total }));
    this.log('minigameResult', { ranking: m.ranking });
    this.phaseEndsAt = Math.min(this.phaseEndsAt, this.now() + this.ms(6)); // 결과 6초 보여주고 넘어감
    this.markDirty();
  }

  exit_minigame() {
    if (!this.minigame.ranking) this.finishMinigame();
  }

  enter_date3Pick(t) {
    const c = this.cfg.pick;
    let pickers = this.minigame.ranking.map((r) => r.pid);
    if (this.minigame.type !== 'treasure') {
      // 반응 속도 게임: 성별마다 상위 N명만 데이트권
      const cnt = { male: 0, female: 0 };
      pickers = pickers.filter((pid) => cnt[this.participants.get(pid).gender]++ < c.ticketsPerGender);
    }
    this.log('tickets', { pickers });
    this.pick = { pickers, index: 0, picks: {}, skipped: [], turnEndsAt: t + this.ms(c.pickTimeoutSec) };
    this.skipPairedPickers();
  }

  /** 이미 짝이 정해진 사람 (누군가 지목했거나 내가 지목함) */
  pairedIds() {
    const s = new Set();
    for (const [a, b] of Object.entries(this.pick.picks)) if (b) { s.add(a); s.add(b); }
    return s;
  }

  pickOptions(pickerId) {
    const taken = this.pairedIds();
    const me = this.participants.get(pickerId);
    return this.byGender(OTHER[me.gender]).map((p) => p.id).filter((id) => !taken.has(id));
  }

  /** 차례가 왔는데 이미 다른 사람에게 지목돼 짝이 있으면 지목 없이 넘어간다 */
  skipPairedPickers() {
    const pk = this.pick;
    while (pk.index < pk.pickers.length && (this.pairedIds().has(pk.pickers[pk.index]) || !this.pickOptions(pk.pickers[pk.index]).length)) {
      pk.skipped.push(pk.pickers[pk.index]);
      this.log('pickSkipped', { picker: pk.pickers[pk.index] });
      pk.index += 1;
    }
    pk.turnEndsAt = this.now() + this.ms(this.cfg.pick.pickTimeoutSec);
    if (pk.index >= pk.pickers.length) this.phaseEndsAt = Math.min(this.phaseEndsAt ?? Infinity, this.now() + this.ms(3));
  }

  commitPick(pickerId, target, auto = false) {
    this.pick.picks[pickerId] = target;
    this.log('pick', { picker: pickerId, target, auto });
    this.pick.index += 1;
    this.skipPairedPickers();
    this.markDirty();
  }

  tickPick(t) {
    const pk = this.pick;
    if (!pk || pk.index >= pk.pickers.length) return;
    const cur = pk.pickers[pk.index];
    const absent = !this.participants.get(cur).connected;
    if (t >= pk.turnEndsAt || (absent && t >= pk.turnEndsAt - this.ms(this.cfg.pick.pickTimeoutSec - 5))) {
      if (this.cfg.pick.onPickTimeout === 'random') {
        const opts = this.pickOptions(cur);
        this.commitPick(cur, opts.length ? opts[Math.floor(this.rng() * opts.length)] : null, true);
      } else {
        this.commitPick(cur, null, true);
      }
    }
  }

  exit_date3Pick() {
    while (this.pick.index < this.pick.pickers.length) {
      const cur = this.pick.pickers[this.pick.index];
      const opts = this.pickOptions(cur);
      this.commitPick(cur, opts.length ? opts[Math.floor(this.rng() * opts.length)] : null, true);
    }
    this.dates.date3 = Object.entries(this.pick.picks)
      .filter(([, t]) => t)
      .map(([a, b], i) => ({ id: `d3-${i}`, members: [a, b] }));
    this.log('date3Groups', { groups: this.dates.date3.map((g) => g.members) });
  }

  enter_randomAssign(t) {
    if (this.cfg.randomDate.mode === 'ladder') return this.startLadder(t);
    this.autoRandomAssign();
  }

  // ── 4차 데이트 사다리타기 ──
  // 남자는 위쪽 출발점, 여자는 아래쪽 도착점을 각자 고른다. 가로줄은 서버가 미리 숨겨 두고 공개 때 보여준다.
  startLadder(t) {
    const males = this.byGender('male').map((p) => p.id);
    const females = this.byGender('female').map((p) => p.id);
    const cols = Math.max(males.length, females.length);
    const rows = 9;
    const rungs = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - 1; c++) {
        // 같은 줄에서 이웃 가로줄이 붙지 않게
        if (rungs.some(([rr, cc]) => rr === r && cc === c - 1)) continue;
        if (this.rng() < 0.45) rungs.push([r, c]);
      }
    }
    this.ladder = { cols, rows, rungs, top: {}, bottom: {}, revealed: false, revealAt: this.phaseEndsAt - this.ms(this.cfg.randomDate.ladderRevealSec) };
    this.dates.date4 = [];
  }

  /** 사다리 따라 내려가기: 위 칸 → 아래 칸 */
  ladderPath(col) {
    const L = this.ladder;
    let c = col;
    for (let r = 0; r < L.rows; r++) {
      if (L.rungs.some(([rr, cc]) => rr === r && cc === c)) c += 1;
      else if (L.rungs.some(([rr, cc]) => rr === r && cc === c - 1)) c -= 1;
    }
    return c;
  }

  act_ladder(p, { slot }) {
    if (this.phase !== 'randomAssign' || !this.ladder) return fail('사다리타기 시간이 아니다');
    const L = this.ladder;
    if (L.revealed) return fail('이미 결과가 공개됐다');
    slot = Number(slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= L.cols) return fail('잘못된 칸');
    const side = p.gender === 'male' ? L.top : L.bottom;
    const owner = Object.entries(side).find(([, v]) => v === p.id);
    if (side[slot] && side[slot] !== p.id) return fail('이미 다른 사람이 고른 칸');
    if (owner) delete side[owner[0]];
    side[slot] = p.id;
    const n = this.participants.size;
    if (Object.keys(L.top).length + Object.keys(L.bottom).length >= n) {
      // 모두 골랐으면 곧 공개
      L.revealAt = Math.min(L.revealAt, this.now() + this.ms(2));
    }
    return { ok: true };
  }

  revealLadder(t) {
    const L = this.ladder;
    if (!L || L.revealed) return;
    // 안 고른 사람은 남은 칸에 무작위로
    for (const [gender, side] of [['male', L.top], ['female', L.bottom]]) {
      const ids = this.byGender(gender).map((p) => p.id).filter((id) => !Object.values(side).includes(id));
      const free = shuffle([...Array(L.cols).keys()].filter((c) => !side[c]), this.rng);
      ids.forEach((id, i) => (side[free[i]] = id));
    }
    const pairs = [];
    for (let c = 0; c < L.cols; c++) {
      const m = L.top[c];
      const f = L.bottom[this.ladderPath(c)];
      if (m && f) pairs.push([m, f]);
    }
    this.dates.date4 = pairs.map((m, i) => ({ id: `d4-${i}`, members: m }));
    L.revealed = true;
    L.revealedAt = t;
    // 결과 애니메이션을 볼 시간은 남긴다
    this.phaseEndsAt = Math.max(this.phaseEndsAt, t + this.ms(this.cfg.randomDate.ladderRevealSec));
    this.log('date4Groups', { groups: pairs, mode: 'ladder' });
    this.markDirty();
  }

  tickLadder(t) {
    if (this.ladder && !this.ladder.revealed && t >= this.ladder.revealAt) this.revealLadder(t);
  }

  exit_randomAssign() {
    if (this.ladder && !this.ladder.revealed) this.revealLadder(this.now());
  }

  autoRandomAssign() {
    const males = this.byGender('male').map((p) => p.id);
    const females = this.byGender('female').map((p) => p.id);
    const prev = (a, b) => this.partnersOf(a, ['date1', 'date2', 'date3']).has(b);
    let best = null;
    // 무작위 배정 여러 번 중 이전 상대와 겹침이 가장 적은 안 선택 [임시]
    const tries = this.cfg.randomDate.avoidPreviousPartners ? 300 : 1;
    for (let k = 0; k < tries; k++) {
      const f = shuffle([...females], this.rng);
      const pairs = males.map((m, i) => [m, f[i]]).filter(([, x]) => x);
      const repeats = pairs.filter(([a, b]) => prev(a, b)).length;
      if (!best || repeats < best.repeats) best = { pairs, repeats };
      if (repeats === 0) break;
    }
    this.dates.date4 = best.pairs.map((m, i) => ({ id: `d4-${i}`, members: m }));
    this.log('date4Groups', { groups: best.pairs, repeats: best.repeats });
  }

  enter_finalChoice() {
    this.finalVotes = {};
  }

  exit_finalChoice() {
    for (const p of this.participants.values()) if (!(p.id in this.finalVotes)) this.finalVotes[p.id] = null;
    const matches = [];
    for (const [a, b] of Object.entries(this.finalVotes)) {
      if (b && this.finalVotes[b] === a && a < b) matches.push([a, b]);
    }
    this.matches = matches;
    this.log('finalMatches', { matches });
  }

  enter_contact() {
    this.contact = {};
  }

  enter_ended() {
    this.phaseEndsAt = null;
  }

  // ───────────────────────── 행동 처리 ─────────────────────────

  /** @returns {{ok:true}|{ok:false, error:string}} */
  handle(pid, action) {
    const p = this.participants.get(pid);
    if (!p) return fail('참가자가 아니다');
    const fn = this[`act_${action?.type}`];
    if (!fn) return fail('알 수 없는 행동');
    const r = fn.call(this, p, action);
    if (r?.ok && !r.silent) this.markDirty(); // 채팅·이동은 전체 상태를 다시 보내지 않는다
    return r ?? { ok: true };
  }

  act_vote(p, { target }) {
    if (this.phase !== 'firstVote') return fail('투표 시간이 아니다');
    if (p.id in this.votes) return fail('이미 투표했다'); // 중복 요청은 한 번만 처리
    if (target == null) {
      if (!this.cfg.firstVote.allowAbstain) return fail('기권 불가');
    } else {
      const t = this.participants.get(target);
      if (!t || t.gender === p.gender) return fail('선택할 수 없는 상대');
    }
    this.votes[p.id] = target ?? null;
    this.log('vote', { voter: p.id, target: target ?? null });
    if ([...this.participants.keys()].every((id) => id in this.votes)) {
      this.phaseEndsAt = Math.min(this.phaseEndsAt, this.now() + this.ms(3));
    }
    return { ok: true };
  }

  act_introDone(p) {
    if (this.phase !== 'selfIntro' || this.intro.speakerId !== p.id) return fail('발표자가 아니다');
    if (!this.cfg.selfIntro.allowEarlyFinish) return fail('일찍 끝낼 수 없다');
    this.endSpeakerPart(this.now());
    return { ok: true };
  }

  act_tap(p, { reactionMs }) {
    if (this.phase !== 'minigame') return fail('미니게임 중이 아니다');
    const m = this.minigame;
    if (m.type !== 'reaction') return fail('지금 미니게임은 누르는 게임이 아니다');
    if (!m.players.includes(p.id)) return fail('참가 대상이 아니다');
    const r = m.rounds[m.round];
    if (!r || m.ranking) return fail('라운드 없음');
    if (p.id in r.taps) return fail('이미 입력했다');
    const t = this.now();
    if (t < r.goAt || reactionMs == null || reactionMs < 0) {
      r.taps[p.id] = { ms: this.cfg.minigame.missPenaltyMs, falseStart: true };
    } else {
      // 클라이언트가 잰 반응 시간을 쓰되 서버 수신 시각보다 길 수는 없게 제한 [임시·부정행위 검증 안 됨]
      const serverElapsed = t - r.goAt;
      const ms = Math.max(80, Math.min(Number(reactionMs) || 0, serverElapsed * this.timeScale, this.cfg.minigame.windowSec * 1000));
      r.taps[p.id] = { ms: Math.round(ms) };
    }
    return { ok: true };
  }

  act_pick(p, { target }) {
    if (this.phase !== 'date3Pick') return fail('지목 시간이 아니다');
    const pk = this.pick;
    if (pk.pickers[pk.index] !== p.id) return fail('내 차례가 아니다');
    if (!this.pickOptions(p.id).includes(target)) return fail('지목할 수 없는 상대');
    this.commitPick(p.id, target);
    return { ok: true };
  }

  act_final(p, { target }) {
    if (this.phase !== 'finalChoice') return fail('최종 선택 시간이 아니다');
    if (p.id in this.finalVotes) return fail('이미 선택했다');
    if (target == null) {
      if (!this.cfg.finalChoice.allowAbstain) return fail('기권 불가');
    } else {
      const t = this.participants.get(target);
      if (!t || t.gender === p.gender) return fail('선택할 수 없는 상대');
    }
    this.finalVotes[p.id] = target ?? null;
    this.log('final', { pid: p.id, target: target ?? null });
    if ([...this.participants.keys()].every((id) => id in this.finalVotes)) {
      this.phaseEndsAt = Math.min(this.phaseEndsAt, this.now() + this.ms(3));
    }
    return { ok: true };
  }

  act_contact(p, { consent, contact }) {
    if (this.phase !== 'contact') return fail('연락처 교환 단계가 아니다');
    if (!this.matchOf(p.id)) return fail('매치된 상대가 없다');
    if (p.id in this.contact) return fail('이미 응답했다');
    this.contact[p.id] = { consent: !!consent, contact: consent ? String(contact ?? '').slice(0, 60) : '' };
    return { ok: true };
  }

  act_move(p, { x, z }) {
    if (!this.canRoam(p.id)) return fail('지금은 이동할 수 없다');
    if (!Number.isFinite(x) || !Number.isFinite(z)) return fail('잘못된 좌표');
    const t = this.now();
    if (p.lastMoveAt && t - p.lastMoveAt < 80) return { ok: true, silent: true }; // 초당 약 12회 제한
    const prev = p.pos ? { ...p.pos, at: p.lastMoveAt } : null;
    p.lastMoveAt = t;
    p.pos = { x: clamp(x, WORLD.minX, WORLD.maxX), z: clamp(z, WORLD.minZ, WORLD.maxZ) };
    for (const fn of this.listeners) fn({ type: 'pos', id: p.id, ...p.pos });
    if (this.phase === 'minigame') this.checkTreasure(p, prev, t);
    return { ok: true, silent: true };
  }

  /** 자유 구경 중 앉기·눕기·일어서기·점프 (연출용, 다른 사람에게 그대로 전달) */
  act_emote(p, { kind, x, z, face, y }) {
    if (!this.canRoam(p.id)) return fail('지금은 할 수 없다');
    if (!['sit', 'lie', 'stand', 'jump'].includes(kind)) return fail('알 수 없는 동작');
    const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
    const ev = { type: 'emote', id: p.id, kind, x: clamp(num(x), WORLD.minX, WORLD.maxX), z: clamp(num(z), WORLD.minZ, WORLD.maxZ), face: num(face), y: clamp(num(y), 0, 1) };
    if (kind === 'sit' || kind === 'lie') p.pos = { x: ev.x, z: ev.z };
    for (const fn of this.listeners) fn(ev);
    return { ok: true, silent: true };
  }

  act_chat(p, { channel, text }) {
    const msg = String(text ?? '').trim().slice(0, 200);
    if (!msg) return fail('빈 메시지');
    if (!this.channelsFor(p.id).includes(channel)) return fail('지금 쓸 수 없는 채널');
    const m = { id: ++this.chatSeq, channel, from: p.id, text: msg, at: this.now() };
    this.chat.push(m);
    if (this.chat.length > 500) this.chat.splice(0, this.chat.length - 500);
    for (const fn of this.listeners) fn({ type: 'chat', message: m });
    return { ok: true, silent: true };
  }

  // ───────────────────────── 권한 계산 ─────────────────────────

  myDateGroup(pid) {
    if (!DATE_PHASES.has(this.phase)) return null;
    return this.dates[this.phase].find((g) => g.members.includes(pid)) ?? null;
  }

  /** 텍스트 채팅 채널. 숙소를 포함해 음성은 여기서 다루지 않는다. */
  channelsFor(pid) {
    const p = this.participants.get(pid);
    const dorm = `dorm_${p.gender}`;
    if (this.phase === 'waiting' || this.phase === 'ended') return [];
    if (DATE_PHASES.has(this.phase)) {
      const g = this.myDateGroup(pid);
      return g ? [`date:${g.id}`] : [dorm];
    }
    return ['lounge', dorm];
  }

  /**
   * 음성 권한. [확정] 자기소개(발표자 1명 송출, 나머지 청취)와 데이트(같은 그룹끼리)만.
   * @returns {import('./voice.js').VoicePermMap}
   */
  voicePerms() {
    const out = {};
    for (const p of this.participants.values()) out[p.id] = { publish: false, subscribe: [] };
    if (this.phase === 'selfIntro' && this.intro?.speakerId) {
      const s = this.intro.speakerId;
      out[s].publish = true;
      for (const p of this.participants.values()) if (p.id !== s) out[p.id].subscribe = [s];
    } else if (DATE_PHASES.has(this.phase)) {
      for (const g of this.dates[this.phase]) {
        for (const m of g.members) {
          out[m].publish = true;
          out[m].subscribe = g.members.filter((x) => x !== m);
        }
      }
    }
    // 접속이 끊긴 참가자는 송출·구독 대상에서 제외 (복귀하면 최신 단계 기준으로 다시 계산)
    for (const p of this.participants.values()) {
      if (!p.connected) out[p.id] = { publish: false, subscribe: [] };
    }
    for (const id of Object.keys(out)) {
      out[id].subscribe = out[id].subscribe.filter((s) => out[s]?.publish);
    }
    return out;
  }

  syncVoice() {
    if (this.voice) this.voice.apply(this.id, this.voicePerms());
  }

  // ───────────────────────── 공개 정보 ─────────────────────────

  reveal(pid) {
    const p = this.participants.get(pid);
    if (p && !p.revealed) {
      p.revealed = true;
      this.markDirty();
    }
  }

  /** 서버가 공개 가능한 필드만 골라서 만든다. 비공개 필드는 객체에 넣지 않는다. */
  publicProfile(pid) {
    const p = this.participants.get(pid);
    const pub = {
      id: p.id,
      gender: p.gender,
      alias: p.alias,
      characterId: p.characterId,
      photoUrl: p.profile.photoUrl ?? null,
      connected: p.connected,
      revealed: p.revealed,
    };
    if (p.revealed) {
      pub.age = p.profile.age;
      pub.job = p.profile.job;
      pub.region = p.profile.region;
    }
    return pub;
  }

  zoneOf(pid) {
    const p = this.participants.get(pid);
    if (DATE_PHASES.has(this.phase)) {
      const g = this.myDateGroup(pid);
      return g ? `date:${this.dates[this.phase].indexOf(g)}` : `dorm_${p.gender}`;
    }
    if (this.phase === 'selfIntro') return this.intro?.speakerId === pid ? 'stage' : 'lounge';
    if (this.phase === 'minigame') return this.minigame?.players.includes(pid) ? 'lounge' : `dorm_${p.gender}`;
    if (this.phase === 'freeRoam') return 'free';
    if (this.phase === 'ended') return `dorm_${p.gender}`;
    return 'lounge';
  }

  /** 자유롭게 걸어다닐 수 있는지: 자유 구경 시간 + 숙소에서 대기 중일 때 (데이트·미니게임에 안 뽑힌 사람) */
  canRoam(pid) {
    const z = this.zoneOf(pid);
    // 보물찾기 참가자는 마을을 돌아다닌다 (결과가 나온 뒤엔 멈춤)
    if (this.phase === 'minigame' && this.minigame?.type === 'treasure' && this.minigame.players.includes(pid) && !this.minigame.ranking) return true;
    return z === 'free' || (z.startsWith('dorm_') && this.phase !== 'ended');
  }

  partnersOf(pid, rounds) {
    const s = new Set();
    for (const r of rounds) for (const g of this.dates[r]) if (g.members.includes(pid)) for (const m of g.members) if (m !== pid) s.add(m);
    return s;
  }

  matchOf(pid) {
    const m = this.matches.find((x) => x.includes(pid));
    return m ? m.find((x) => x !== pid) : null;
  }

  viewFor(pid, voice = this.voicePerms()) {
    const me = this.participants.get(pid);
    const t = this.now();
    const v = {
      roomId: this.id,
      configVersion: this.cfg.configVersion,
      serverNow: t,
      timeScale: this.timeScale,
      phase: this.phase,
      phases: this.phases,
      phaseStartedAt: this.phaseStartedAt,
      phaseEndsAt: this.phaseEndsAt,
      voterGender: this.voterGender, // 1차 데이트 = 이 성별의 첫인상 선택
      secondGender: this.secondGender, // 2차 데이트 = 이 성별의 첫인상 선택
      me: { ...this.publicProfile(pid), private: { age: me.profile.age, job: me.profile.job, region: me.profile.region } },
      participants: [...this.participants.keys()].map((id) => this.publicProfile(id)),
      zones: Object.fromEntries([...this.participants.keys()].map((id) => [id, this.zoneOf(id)])),
      roaming: [...this.participants.keys()].filter((id) => this.canRoam(id)),
      positions: Object.fromEntries([...this.participants.values()].filter((p) => p.pos && this.canRoam(p.id)).map((p) => [p.id, p.pos])),
      channels: this.channelsFor(pid),
      voice: voice[pid],
      speakingIds: Object.entries(voice).filter(([, v2]) => v2.publish).map(([k]) => k),
      settings: {
        dateRounds: this.cfg.randomDate.enabled ? 4 : 3,
        ticketsPerGender: this.cfg.pick.ticketsPerGender,
        profileReveal: this.cfg.profileReveal,
        allowAbstain: this.cfg.firstVote.allowAbstain,
        contactExchange: this.cfg.contactExchange.enabled,
      },
    };

    if (this.phase === 'firstVote') {
      v.vote = {
        canVote: true,
        myVote: pid in this.votes ? this.votes[pid] : undefined,
        submitted: Object.keys(this.votes).length,
        total: this.participants.size,
      };
    }
    const g = this.myDateGroup(pid);
    if (g) v.myDate = { id: g.id, round: this.phase, members: g.members };
    if (DATE_PHASES.has(this.phase)) {
      v.dateSummary = { groups: this.dates[this.phase].length, inDate: !!g };
      if (this.cfg.firstVote.revealVoteCounts && this.phase === 'date1') {
        v.dateSummary.sizes = this.dates.date1.map((x) => x.members.length);
      }
    }
    if (this.phase === 'selfIntro' && this.intro) {
      const it = this.intro;
      v.intro = {
        order: it.order,
        index: it.index,
        speakerId: it.speakerId,
        speakerEndsAt: it.speakerEndsAt,
        qna: !!it.qna,
        gapUntil: it.gapUntil,
        done: it.done,
        skipped: it.skipped,
        // 발표자 정보 카드는 공개 정책과 같은 기준을 쓴다 (publicProfile)
      };
    }
    if (this.phase === 'minigame' && this.minigame?.type === 'treasure') {
      const m = this.minigame;
      v.minigame = {
        type: 'treasure',
        playing: m.players.includes(pid),
        total: m.total[me.gender], // 내 성별 데이트권 수
        totals: m.total,
        // 보물은 같은 성별에게만 보인다 (다른 성별 보물은 밟아도 소용없음)
        treasure: m.active[me.gender] ? { id: m.active[me.gender].id, x: m.active[me.gender].x, z: m.active[me.gender].z } : null,
        found: m.found.map((f) => ({ pid: f.pid, gender: f.gender, sec: f.sec })),
        myFound: m.found.some((f) => f.pid === pid),
        ranking: m.ranking,
      };
    } else if (this.phase === 'minigame' && this.minigame) {
      const m = this.minigame;
      const r = m.rounds[m.round];
      v.minigame = {
        playing: m.players.includes(pid),
        round: m.round,
        rounds: this.cfg.minigame.rounds,
        roundStartAt: r?.startAt,
        goAt: r && t >= r.goAt ? r.goAt : null, // 신호 전에는 시각을 보내지 않는다
        myTap: r?.taps[pid] ?? null,
        myTaps: m.rounds.map((x) => x.taps[pid] ?? null),
        ranking: m.ranking,
      };
    }
    if (this.phase === 'date3Pick' && this.pick) {
      const pk = this.pick;
      const cur = pk.pickers[pk.index] ?? null;
      v.pick = {
        skipped: pk.skipped,
        pickers: pk.pickers,
        currentPicker: cur,
        turnEndsAt: pk.turnEndsAt,
        picks: pk.picks, // 지목 결과는 순서대로 공개 [임시] — 공개 범위 미정
        options: cur === pid ? this.pickOptions(pid) : [],
        ranking: this.minigame.ranking,
      };
    }
    if (this.phase === 'randomAssign') {
      const ug = this.dates.date4.find((x) => x.members.includes(pid));
      v.upcomingDate = ug ? { id: ug.id, members: ug.members } : null;
      const L = this.ladder;
      if (L) {
        v.ladder = {
          cols: L.cols,
          rows: L.rows,
          top: L.top,
          bottom: L.bottom,
          revealed: L.revealed,
          revealAt: L.revealAt,
          rungs: L.revealed ? L.rungs : null, // 가로줄은 공개 전까지 숨김
        };
      }
    }
    if (this.phase === 'finalChoice') {
      v.final = { myChoice: pid in this.finalVotes ? this.finalVotes[pid] : undefined };
    }
    if (this.phase === 'result' || this.phase === 'contact' || this.phase === 'ended') {
      v.result = {
        myChoice: this.finalVotes[pid] ?? null,
        matchedWith: this.matchOf(pid),
        couples: this.cfg.finalChoice.revealScope === 'couples' ? this.matches : undefined,
        couplesCount: this.matches.length,
      };
    }
    if ((this.phase === 'contact' || this.phase === 'ended') && this.cfg.contactExchange.enabled) {
      const partner = this.matchOf(pid);
      if (partner) {
        const mine = this.contact[pid];
        const theirs = this.contact[partner];
        const both = mine?.consent && theirs?.consent;
        v.contact = {
          responded: !!mine,
          // 양쪽 모두 동의했을 때만 상대 연락처를 내려준다
          partnerContact: both ? theirs.contact : null,
          status: !mine ? 'pending' : both ? 'shared' : this.phase === 'ended' || (mine && theirs) ? 'notShared' : 'waiting',
        };
      }
    }
    v.chatHistory = this.chat.filter((m) => v.channels.includes(m.channel)).slice(-60);
    return v;
  }

  // ───────────────────────── 접속 ─────────────────────────

  setConnected(pid, on) {
    const p = this.participants.get(pid);
    if (!p || p.connected === on) return;
    p.connected = on;
    // 무단 이탈 판단용: 한 번에 가장 오래 나가 있던 시간
    const t = this.now();
    if (!on) p.absentSince = t;
    else if (p.absentSince != null) {
      p.maxAbsentMs = Math.max(p.maxAbsentMs ?? 0, t - p.absentSince);
      p.absentSince = null;
    }
    this.log(on ? 'connect' : 'disconnect', { pid });
    this.syncVoice();
    this.markDirty();
  }

  pidOfUser(userId) {
    for (const p of this.participants.values()) if (p.userId === userId) return p.id;
    return null;
  }

  byGender(g) {
    return [...this.participants.values()].filter((p) => p.gender === g);
  }

  markDirty() {
    this.dirty = true;
  }

  log(type, data) {
    this.events.push({ at: this.now(), type, ...data });
  }
}

export function buildPhaseList(cfg) {
  const list = ['intro', 'firstVote', 'date1', 'freeRoam', 'selfIntro', 'date2', 'minigame', 'date3Pick', 'date3'];
  if (cfg.randomDate.enabled) list.push('randomAssign', 'date4');
  list.push('finalChoice', 'result');
  if (cfg.contactExchange.enabled) list.push('contact');
  list.push('ended');
  return list;
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function fail(error) {
  return { ok: false, error };
}
