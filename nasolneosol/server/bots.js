// 개발용 봇 참가자. 혼자서도 12인 흐름을 끝까지 확인하기 위한 도구다.
// 봇은 실제 음성을 내지 않는다. 자기소개 차례가 오면 BOT_INTRO_SEC 뒤 스스로 끝낸다.

const JOBS = ['디자이너', '개발자', '간호사', '회사원', '교사', '요리사', '마케터', '연구원', '자영업', '공무원', '프리랜서', '바리스타'];
const REGIONS = ['서울 마포구', '서울 강남구', '경기 성남시', '인천 연수구', '부산 해운대구', '대전 유성구', '서울 성동구', '경기 수원시'];
const LINES = ['안녕하세요~', '여기 분위기 좋네요', 'ㅎㅎ 반가워요', '다들 어디 사세요?', '긴장되네요', '커피 좋아하세요?', '저 첫인상 투표 고민 많이 했어요', '주말엔 보통 뭐 하세요?'];

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
  constructor(room, { introSec = 8, rng = Math.random } = {}) {
    this.room = room;
    this.rng = rng;
    this.introSec = introSec;
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
    for (const b of this.bots()) {
      const other = b.gender === 'male' ? 'female' : 'male';
      const opp = r.byGender(other).map((p) => p.id);

      // 자기소개: 봇 차례면 introSec(실제 초) 뒤 종료
      if (r.phase === 'selfIntro' && r.intro?.speakerId === b.id) {
        if (now - r.intro.speakerStartedAt >= this.introSec * 1000) r.handle(b.id, { type: 'introDone' });
        continue;
      }
      // 미니게임: 신호를 본 뒤 반응
      if (r.phase === 'minigame' && r.minigame?.players.includes(b.id) && !r.minigame.ranking) {
        const rd = r.minigame.rounds[r.minigame.round];
        if (rd && now >= rd.goAt && !(b.id in rd.taps)) {
          const react = 220 + this.rng() * 500;
          if (now - rd.goAt >= react / r.timeScale) r.handle(b.id, { type: 'tap', reactionMs: Math.round(react) });
        }
        continue;
      }
      if (!this.ready(b.id)) continue;

      if (r.phase === 'firstVote' && b.gender === r.voterGender && !(b.id in r.votes)) {
        r.handle(b.id, { type: 'vote', target: this.pickRandom(opp) });
      } else if (r.phase === 'date2Pick' && r.pick?.pickers[r.pick.index] === b.id) {
        const opts = r.pickOptions(b.id);
        if (opts.length) r.handle(b.id, { type: 'pick', target: this.pickRandom(opts) });
      } else if (r.phase === 'finalChoice' && !(b.id in r.finalVotes)) {
        // 만났던 상대를 조금 더 고르는 경향 + 30% 기권
        const met = [...r.partnersOf(b.id, ['date1', 'date2', 'date3'])];
        const target = this.rng() < 0.3 ? null : this.pickRandom(met.length && this.rng() < 0.7 ? met : opp);
        r.handle(b.id, { type: 'final', target });
      } else if (r.phase === 'contact' && r.matchOf(b.id) && !(b.id in r.contact)) {
        r.handle(b.id, { type: 'contact', consent: true, contact: `bot-${b.alias}@example.invalid` });
      } else if (r.phase === 'freeRoam') {
        r.handle(b.id, { type: 'move', x: (this.rng() - 0.5) * 24, z: (this.rng() - 0.5) * 10 });
      }
      if (this.rng() < 0.15) {
        const ch = r.channelsFor(b.id);
        if (ch.length) r.handle(b.id, { type: 'chat', channel: this.pickRandom(ch), text: this.pickRandom(LINES) });
      }
      this.wait(b.id, 2, 7);
    }
  }
}
