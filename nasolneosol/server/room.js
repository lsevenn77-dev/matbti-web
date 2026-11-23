// 한 회차(방)의 진행 엔진.
//
// - 모든 판정은 서버에서 한다. 클라이언트는 행동(action)만 보낸다.
// - 시간은 서버 시각(now) 기준 endsAt 으로 관리한다. tick(now) 가 단계를 넘긴다.
// - 공개 정보는 viewFor(참가자) 에서 서버가 골라 보낸다. 비공개 필드는 아예 전송하지 않는다.
// - now / rng 를 주입받아 테스트에서 결정적으로 돌릴 수 있다.

import { ALIASES, CHARACTERS } from './config.js';

const OTHER = { male: 'female', female: 'male' };
const DATE_PHASES = new Set(['date1', 'date2', 'date3']);

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
    this.ticketGender = null;
    this.votes = {}; // firstVote: voter → target | null(기권)
    this.dates = { date1: [], date2: [], date3: [] }; // [{ id, members:[pid] }]
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
    this.enterPhase(0);
  }

  tick() {
    const t = this.now();
    if (this.phase === 'waiting' || this.phase === 'ended') return;
    if (this.phase === 'selfIntro') this.tickIntro(t);
    if (this.phase === 'minigame') this.tickMinigame(t);
    if (this.phase === 'date2Pick') this.tickPick(t);
    if (this.phaseEndsAt != null && t >= this.phaseEndsAt) this.advance();
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
    const vg = this.cfg.firstVote.voterGender;
    this.voterGender = vg === 'random' ? (this.rng() < 0.5 ? 'male' : 'female') : vg;
    // [확정] 2차 데이트권은 첫인상에서 선택하지 않았던 성별이 게임으로 얻는다
    this.ticketGender = OTHER[this.voterGender];
    this.log('voterGender', { voterGender: this.voterGender });
  }

  enter_firstVote() {
    this.votes = {};
  }

  exit_firstVote() {
    // 미제출은 기권 처리 [임시]
    for (const p of this.byGender(this.voterGender)) if (!(p.id in this.votes)) this.votes[p.id] = null;
    const groups = new Map();
    for (const [voter, target] of Object.entries(this.votes)) {
      if (!target) continue;
      if (!groups.has(target)) groups.set(target, []);
      groups.get(target).push(voter);
    }
    const cap = this.cfg.firstVote.groupCap;
    const list = [];
    for (const [target, voters] of groups) {
      // 상한이 있으면 먼저 투표한 순서대로 자른다 [임시]
      const kept = cap ? voters.slice(0, cap) : voters;
      list.push({ id: `d1-${list.length}`, members: [target, ...kept], focus: target });
    }
    this.dates.date1 = list;
    this.log('date1Groups', { groups: list.map((g) => g.members) });
  }

  enter_date1() {}

  enter_freeRoam() {
    for (const p of this.participants.values()) p.pos = null;
  }

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
    it.speakerEndsAt = t + this.ms(this.cfg.durations.introPerSpeaker);
    this.syncVoice();
    this.markDirty();
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
    if (t >= it.speakerEndsAt) this.nextSpeaker(t);
  }

  exit_selfIntro() {
    for (const p of this.participants.values()) this.reveal(p.id);
  }

  enter_minigame(t) {
    const mg = this.cfg.minigame;
    const players = this.byGender(this.ticketGender).map((p) => p.id);
    this.minigame = { players, round: -1, rounds: [], results: {}, ranking: null };
    this.startMinigameRound(t + this.ms(2));
    void mg;
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

  enter_date2Pick(t) {
    const c = this.cfg.date2;
    const ranking = this.minigame.ranking.map((r) => r.pid);
    const pickers = c.mode === 'tickets' ? ranking.slice(0, c.ticketCount) : ranking;
    this.log('tickets', { mode: c.mode, pickers });
    this.pick = { pickers, index: 0, picks: {}, turnEndsAt: t + this.ms(c.pickTimeoutSec) };
  }

  pickOptions(pickerId) {
    const taken = new Set(Object.values(this.pick.picks).filter(Boolean));
    const me = this.participants.get(pickerId);
    let opts = this.byGender(OTHER[me.gender]).map((p) => p.id).filter((id) => !taken.has(id));
    if (this.cfg.date2.excludeDate1Partners) {
      const prev = this.partnersOf(pickerId, ['date1']);
      const filtered = opts.filter((id) => !prev.has(id));
      if (filtered.length) opts = filtered;
    }
    return opts;
  }

  commitPick(pickerId, target, auto = false) {
    this.pick.picks[pickerId] = target;
    this.log('pick', { picker: pickerId, target, auto });
    this.pick.index += 1;
    this.pick.turnEndsAt = this.now() + this.ms(this.cfg.date2.pickTimeoutSec);
    if (this.pick.index >= this.pick.pickers.length) this.phaseEndsAt = this.now() + this.ms(3);
    this.markDirty();
  }

  tickPick(t) {
    const pk = this.pick;
    if (!pk || pk.index >= pk.pickers.length) return;
    const cur = pk.pickers[pk.index];
    const absent = !this.participants.get(cur).connected;
    if (t >= pk.turnEndsAt || (absent && t >= pk.turnEndsAt - this.ms(this.cfg.date2.pickTimeoutSec - 5))) {
      if (this.cfg.date2.onPickTimeout === 'random') {
        const opts = this.pickOptions(cur);
        this.commitPick(cur, opts.length ? opts[Math.floor(this.rng() * opts.length)] : null, true);
      } else {
        this.commitPick(cur, null, true);
      }
    }
  }

  exit_date2Pick() {
    while (this.pick.index < this.pick.pickers.length) {
      const cur = this.pick.pickers[this.pick.index];
      const opts = this.pickOptions(cur);
      this.commitPick(cur, opts.length ? opts[Math.floor(this.rng() * opts.length)] : null, true);
    }
    this.dates.date2 = Object.entries(this.pick.picks)
      .filter(([, t]) => t)
      .map(([a, b], i) => ({ id: `d2-${i}`, members: [a, b] }));
    this.log('date2Groups', { groups: this.dates.date2.map((g) => g.members) });
  }

  enter_randomAssign() {
    const males = this.byGender('male').map((p) => p.id);
    const females = this.byGender('female').map((p) => p.id);
    const prev = (a, b) => this.partnersOf(a, ['date1', 'date2']).has(b);
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
    this.dates.date3 = best.pairs.map((m, i) => ({ id: `d3-${i}`, members: m }));
    this.log('date3Groups', { groups: best.pairs, repeats: best.repeats });
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
    if (r?.ok) this.markDirty();
    return r ?? { ok: true };
  }

  act_vote(p, { target }) {
    if (this.phase !== 'firstVote') return fail('투표 시간이 아니다');
    if (p.gender !== this.voterGender) return fail('이번 회차 투표권이 없다');
    if (p.id in this.votes) return fail('이미 투표했다'); // 중복 요청은 한 번만 처리
    if (target == null) {
      if (!this.cfg.firstVote.allowAbstain) return fail('기권 불가');
    } else {
      const t = this.participants.get(target);
      if (!t || t.gender === p.gender) return fail('선택할 수 없는 상대');
    }
    this.votes[p.id] = target ?? null;
    this.log('vote', { voter: p.id, target: target ?? null });
    if (this.byGender(this.voterGender).every((v) => v.id in this.votes)) {
      this.phaseEndsAt = Math.min(this.phaseEndsAt, this.now() + this.ms(3));
    }
    return { ok: true };
  }

  act_introDone(p) {
    if (this.phase !== 'selfIntro' || this.intro.speakerId !== p.id) return fail('발표자가 아니다');
    if (!this.cfg.selfIntro.allowEarlyFinish) return fail('일찍 끝낼 수 없다');
    this.nextSpeaker(this.now());
    return { ok: true };
  }

  act_tap(p, { reactionMs }) {
    if (this.phase !== 'minigame') return fail('미니게임 중이 아니다');
    const m = this.minigame;
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
    if (this.phase !== 'date2Pick') return fail('지목 시간이 아니다');
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
    if (this.phase !== 'freeRoam') return fail('자유 구경 시간에만 이동할 수 있다');
    if (!Number.isFinite(x) || !Number.isFinite(z)) return fail('잘못된 좌표');
    p.pos = { x: clamp(x, -14, 14), z: clamp(z, -6, 6) };
    return { ok: true };
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

  partnersOf(pid, rounds) {
    const s = new Set();
    for (const r of rounds) for (const g of this.dates[r]) if (g.members.includes(pid)) for (const m of g.members) if (m !== pid) s.add(m);
    return s;
  }

  matchOf(pid) {
    const m = this.matches.find((x) => x.includes(pid));
    return m ? m.find((x) => x !== pid) : null;
  }

  viewFor(pid) {
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
      voterGender: this.voterGender,
      ticketGender: this.ticketGender,
      me: { ...this.publicProfile(pid), private: { age: me.profile.age, job: me.profile.job, region: me.profile.region } },
      participants: [...this.participants.keys()].map((id) => this.publicProfile(id)),
      zones: Object.fromEntries([...this.participants.keys()].map((id) => [id, this.zoneOf(id)])),
      positions: this.phase === 'freeRoam'
        ? Object.fromEntries([...this.participants.values()].filter((p) => p.pos).map((p) => [p.id, p.pos]))
        : {},
      channels: this.channelsFor(pid),
      voice: this.voicePerms()[pid],
      speakingIds: Object.entries(this.voicePerms()).filter(([, v2]) => v2.publish).map(([k]) => k),
      settings: {
        dateRounds: this.cfg.randomDate.enabled ? 3 : 2,
        date2Mode: this.cfg.date2.mode,
        ticketCount: this.cfg.date2.ticketCount,
        profileReveal: this.cfg.profileReveal,
        allowAbstain: this.cfg.firstVote.allowAbstain,
        contactExchange: this.cfg.contactExchange.enabled,
      },
    };

    if (this.phase === 'firstVote') {
      v.vote = {
        canVote: me.gender === this.voterGender,
        myVote: pid in this.votes ? this.votes[pid] : undefined,
        submitted: Object.keys(this.votes).length,
        total: this.byGender(this.voterGender).length,
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
        gapUntil: it.gapUntil,
        done: it.done,
        skipped: it.skipped,
        // 발표자 정보 카드는 공개 정책과 같은 기준을 쓴다 (publicProfile)
      };
    }
    if (this.phase === 'minigame' && this.minigame) {
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
    if (this.phase === 'date2Pick' && this.pick) {
      const pk = this.pick;
      const cur = pk.pickers[pk.index] ?? null;
      v.pick = {
        mode: this.cfg.date2.mode,
        pickers: pk.pickers,
        currentPicker: cur,
        turnEndsAt: pk.turnEndsAt,
        picks: pk.picks, // 지목 결과는 순서대로 공개 [임시] — 공개 범위 미정
        options: cur === pid ? this.pickOptions(pid) : [],
        ranking: this.minigame.ranking,
      };
    }
    if (this.phase === 'randomAssign') {
      const ug = this.dates.date3.find((x) => x.members.includes(pid));
      v.upcomingDate = ug ? { id: ug.id, members: ug.members } : null;
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
  const list = ['intro', 'firstVote', 'date1', 'freeRoam', 'selfIntro', 'minigame', 'date2Pick', 'date2'];
  if (cfg.randomDate.enabled) list.push('randomAssign', 'date3');
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
