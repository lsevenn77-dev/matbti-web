// 개발용 봇 참가자. 혼자서도 12인 흐름을 끝까지 확인하기 위한 도구다.
// 봇은 실제 음성을 내지 않는다. 자기소개 차례가 오면 BOT_INTRO_SEC 뒤 스스로 끝낸다.

const JOBS = ['디자이너', '개발자', '간호사', '회사원', '교사', '요리사', '마케터', '연구원', '자영업', '공무원', '프리랜서', '바리스타'];
const REGIONS = ['서울 마포구', '서울 강남구', '경기 성남시', '인천 연수구', '부산 해운대구', '대전 유성구', '서울 성동구', '경기 수원시'];
const LINES = ['안녕하세요~', '여기 분위기 좋네요', 'ㅎㅎ 반가워요', '다들 어디 사세요?', '긴장되네요', '커피 좋아하세요?', '저 첫인상 투표 고민 많이 했어요', '주말엔 보통 뭐 하세요?'];

// 봇이 자유 구경 때 걸어가는 바깥 지점 (건물 안·벽 위가 아닌 곳)
const ROAM_SPOTS = [[0, 0], [-4, 3], [4, 3], [-8, 1], [8, 1], [-6, -4], [6, -4], [-14, 3.5], [14, 3.5], [-10, -9], [10, -9], [0, -14], [-12, -13], [12, -13], [-16, -15], [16, -15], [0, 6], [-19, -6], [19, -6]];

const COLORS = ['#f4a259', '#5b8e7d', '#7c9cc4', '#c97b63', '#8fb996', '#d6a2ad', '#a99bd6', '#7fc8a9'];

export function botProfile(gender, n, rng = Math.random) {
  return {
    gender,
    age: 24 + Math.floor(rng() * 14),
    job: JOBS[Math.floor(rng() * JOBS.length)],
    region: REGIONS[Math.floor(rng() * REGIONS.length)],
    botLabel: `봇${n}`,
  };
}

/** 실제 사진 대신 쓰는 단색 그림 (봇 표시용) */
export function botPhotoSvg(label, n) {
  const c = COLORS[n % COLORS.length];
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="${c}"/><circle cx="60" cy="48" r="22" fill="#fff" opacity=".85"/><rect x="26" y="78" width="68" height="40" rx="20" fill="#fff" opacity=".85"/><text x="60" y="112" font-size="16" text-anchor="middle" font-family="sans-serif" fill="${c}">${label}</text></svg>`);
}

export class BotDriver {
  /**
   * @param {object} o
   * @param {number|null} [o.introSec]  봇 자기소개 길이(실제 초). null 이면 실제 사람처럼 정해진 시간의 60~95% 를 쓴다
   * @param {boolean} [o.realistic]  true 면 투표·지목·최종 선택을 단계 시간 안에 사람처럼 천천히 한다
   */
  constructor(room, { introSec = 8, realistic = false, rng = Math.random } = {}) {
    this.room = room;
    this.rng = rng;
    this.introSec = introSec;
    this.realistic = realistic;
    this.decideAt = new Map(); // pid → 결정(투표·지목·선택)을 내려도 되는 시각
    this.seenPhase = null;
    this.seenTurn = null;
    this.introLen = new Map(); // 발표 시작 시각 → 이번 봇 발표 길이(ms)
    this.next = new Map(); // pid → 다음 행동 가능 시각
  }

  bots() {
    return [...this.room.participants.values()].filter((p) => p.isBot);
  }

  wait(pid, minSec, maxSec) {
    const r = this.room;
    const s = minSec + this.rng() * (maxSec - minSec);
    this.next.set(pid, r.now() + r.ms(s));
  }

  ready(pid) {
    const t = this.next.get(pid);
    if (t == null) {
      this.wait(pid, 1, 4);
      return false;
    }
    return this.room.now() >= t;
  }

  pickRandom(arr) {
    return arr[Math.floor(this.rng() * arr.length)];
  }

  tick() {
    const r = this.room;
    const now = r.now();
    if (this.realistic) {
      // 결정이 필요한 단계가 바뀌면 각 봇이 남은 시간 중 25~85% 지점에 결정하도록 예약
      if (r.phase !== this.seenPhase) {
        this.seenPhase = r.phase;
        const span = r.phaseEndsAt != null ? Math.max(0, r.phaseEndsAt - now) : 0;
        for (const b of this.bots()) this.decideAt.set(b.id, now + span * (0.25 + 0.6 * this.rng()));
      }
      const turn = r.phase === 'date3Pick' && r.pick ? r.pick.index : null;
      if (turn !== this.seenTurn) {
        this.seenTurn = turn;
        if (turn != null) for (const b of this.bots()) this.decideAt.set(b.id, now + r.ms(r.cfg.pick.pickTimeoutSec * (0.3 + 0.4 * this.rng())));
      }
    }
    const decided = (id) => !this.realistic || now >= (this.decideAt.get(id) ?? 0);
    for (const b of this.bots()) {
      const other = b.gender === 'male' ? 'female' : 'male';
      const opp = r.byGender(other).map((p) => p.id);

      // 자기소개: 봇 차례면 introSec(실제 초) 뒤 종료
      if (r.phase === 'selfIntro' && r.intro?.speakerId === b.id) {
        // 소개 → 질문 시간 각각 따로 길이를 정한다
        const qna = !!r.intro.qna;
        const start = qna ? r.intro.qnaStartedAt : r.intro.speakerStartedAt;
        const key = `${r.intro.speakerStartedAt}:${qna}`;
        if (!this.introLen.has(key)) {
          const sec = qna ? r.cfg.durations.introQnA : r.cfg.durations.introPerSpeaker;
          this.introLen.set(key, this.introSec != null ? this.introSec * 1000 : r.ms(sec * (0.6 + 0.35 * this.rng())));
        }
        if (now - start >= this.introLen.get(key)) r.handle(b.id, { type: 'introDone' });
        continue;
      }
      // 보물찾기: 반짝임을 '알아챈' 뒤 걸어가서 밟는다 (사람보다 너무 잘 찾지 않게 알아채는 데 6~20초, 걷는 속도 2m/s)
      if (r.phase === 'minigame' && r.minigame?.type === 'treasure' && r.minigame.players.includes(b.id) && !r.minigame.ranking) {
        const m = r.minigame;
        if (m.found.some((f) => f.pid === b.id)) continue;
        const tr = m.active[b.gender]; // 내 성별 보물만
        if (!tr) continue;
        const key = `${b.id}:${tr.id}`;
        if (!this.noticeAt) this.noticeAt = new Map();
        if (!this.noticeAt.has(key)) this.noticeAt.set(key, now + r.ms(6 + this.rng() * 14));
        if (now < this.noticeAt.get(key)) continue;
        if (this.next.has(b.id) && now < this.next.get(b.id) && this.next.get(b.id) - now < r.ms(1)) continue;
        // 0.4초마다 0.8m (걷는 속도 2m/s)
        const pos = r.hunterPos(b.id);
        const dx = tr.x - pos.x;
        const dz = tr.z - pos.z;
        const d = Math.hypot(dx, dz);
        const step = Math.min(d, 0.8);
        r.handle(b.id, { type: 'move', x: pos.x + (d ? (dx / d) * step : 0), z: pos.z + (d ? (dz / d) * step : 0) });
        this.next.set(b.id, now + r.ms(0.4));
        continue;
      }
      // 미니게임(반응 속도): 신호를 본 뒤 반응
      if (r.phase === 'minigame' && r.minigame?.type === 'reaction' && r.minigame?.players.includes(b.id) && !r.minigame.ranking) {
        const rd = r.minigame.rounds[r.minigame.round];
        if (rd && now >= rd.goAt && !(b.id in rd.taps)) {
          const react = 220 + this.rng() * 500;
          if (now - rd.goAt >= react / r.timeScale) r.handle(b.id, { type: 'tap', reactionMs: Math.round(react) });
        }
        continue;
      }
      if (!this.ready(b.id)) continue;

      if (r.phase === 'firstVote' && !(b.id in r.votes) && decided(b.id)) {
        r.handle(b.id, { type: 'vote', target: this.pickRandom(opp) });
      } else if (r.phase === 'date3Pick' && r.pick?.pickers[r.pick.index] === b.id && decided(b.id)) {
        const opts = r.pickOptions(b.id);
        if (opts.length) r.handle(b.id, { type: 'pick', target: this.pickRandom(opts) });
      } else if (r.phase === 'randomAssign' && r.ladder && !r.ladder.revealed && decided(b.id)) {
        const side = b.gender === 'male' ? r.ladder.top : r.ladder.bottom;
        if (!Object.values(side).includes(b.id)) {
          const free = [...Array(r.ladder.cols).keys()].filter((c) => !side[c]);
          if (free.length) r.handle(b.id, { type: 'ladder', slot: this.pickRandom(free) });
        }
      } else if (r.phase === 'finalChoice' && !(b.id in r.finalVotes) && decided(b.id)) {
        // 만났던 상대를 조금 더 고르는 경향 + 30% 기권
        const met = [...r.partnersOf(b.id, ['date1', 'date2', 'date3', 'date4'])];
        const target = this.rng() < 0.3 ? null : this.pickRandom(met.length && this.rng() < 0.7 ? met : opp);
        r.handle(b.id, { type: 'final', target });
      } else if (r.phase === 'contact' && r.matchOf(b.id) && !(b.id in r.contact)) {
        r.handle(b.id, { type: 'contact', consent: true, contact: `bot-${b.alias}@example.invalid` });
      } else if (r.phase === 'freeRoam') {
        const [x, z] = this.pickRandom(ROAM_SPOTS);
        r.handle(b.id, { type: 'move', x: x + (this.rng() - 0.5) * 2, z: z + (this.rng() - 0.5) * 2 });
      }
      if (this.rng() < 0.15) {
        const ch = r.channelsFor(b.id);
        if (ch.length) r.handle(b.id, { type: 'chat', channel: this.pickRandom(ch), text: this.pickRandom(LINES) });
      }
      this.wait(b.id, 2, 7);
    }
  }
}
