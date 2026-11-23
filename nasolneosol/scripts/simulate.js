// 12명 실제 WebSocket 클라이언트로 한 회차를 끝까지 진행하는 검증 스크립트.
// 사용: node scripts/simulate.js [timeScale=60] [preset=threeDates]
// 측정: 1인당 서버→클라이언트 게임 상태 바이트 (음성·사진·정적 파일 제외)

import { WebSocket } from 'ws';
import sharp from 'sharp';
import { createServer } from '../server/index.js';
import { estimateMinutes } from '../server/config.js';

const timeScale = Number(process.argv[2] || 60);
const preset = process.argv[3] || 'threeDates';
const app = createServer({ env: { TIME_SCALE: String(timeScale), PRESET: preset, DEV_TOOLS: '0' }, dataDir: null });
const port = await app.listen(0);
const base = `http://127.0.0.1:${port}`;

const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#e98a5d' } }).jpeg().toBuffer();
const photo = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

const LINES = ['안녕하세요', '반가워요', '어디 사세요?', '커피 좋아해요', 'ㅎㅎ'];
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

class Client {
  constructor(i, gender) {
    this.i = i;
    this.gender = gender;
    this.bytes = 0;
    this.msgs = 0;
    this.view = null;
    this.done = new Set();
    this.leaks = [];
  }
  async signup() {
    const r = await fetch(`${base}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gender: this.gender, age: 25 + this.i, job: `SECRETJOB${this.i}`, region: `SECRETREGION${this.i}`, photo }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    this.token = j.token;
  }
  connect() {
    return new Promise((res) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ t: 'hello', token: this.token }));
        res();
      });
      this.ws.on('message', (raw) => {
        this.bytes += raw.length;
        this.msgs++;
        const m = JSON.parse(raw);
        if (m.t === 'state') this.onState(m.view);
      });
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  act(a) {
    this.send({ t: 'act', action: a });
  }
  onState(v) {
    this.view = v;
    this.phases ??= [];
    if (this.phases.at(-1) !== v.phase) this.phases.push(v.phase);
    // 공개 전 정보 누출 검사
    for (const p of v.participants) {
      if (p.id !== v.me.id && !p.revealed && (p.job || p.region || p.age)) this.leaks.push(`${v.phase}:${p.id}`);
    }
    const s = JSON.stringify(v.participants.filter((p) => p.id !== v.me.id && !p.revealed));
    if (s.includes('SECRET')) this.leaks.push(`raw:${v.phase}`);
    const opp = v.participants.filter((p) => p.gender !== v.me.gender).map((p) => p.id);
    const key = (k) => {
      if (this.done.has(k)) return false;
      this.done.add(k);
      return true;
    };
    if (v.phase === 'firstVote' && v.vote.canVote && key('vote')) setTimeout(() => this.act({ type: 'vote', target: rnd(opp) }), 50);
    if (v.phase === 'selfIntro' && v.intro?.speakerId === v.me.id && key(`intro`)) setTimeout(() => this.act({ type: 'introDone' }), 100);
    if (v.phase === 'minigame' && v.minigame?.playing && v.minigame.goAt && !v.minigame.myTap && key(`tap${v.minigame.round}`)) {
      setTimeout(() => this.act({ type: 'tap', reactionMs: 200 + Math.round(Math.random() * 400) }), 30);
    }
    if (v.phase === 'date2Pick' && v.pick?.currentPicker === v.me.id && key(`pick`)) setTimeout(() => this.act({ type: 'pick', target: rnd(v.pick.options) }), 50);
    if (v.phase === 'finalChoice' && v.final.myChoice === undefined && key('final')) {
      const met = [v.myDate?.members].flat().filter(Boolean);
      void met;
      setTimeout(() => this.act({ type: 'final', target: Math.random() < 0.2 ? null : rnd(opp) }), 50);
    }
    if (v.phase === 'freeRoam' && key('move')) this.act({ type: 'move', x: Math.random() * 10 - 5, z: Math.random() * 6 - 3 });
    if (v.channels.length && Math.random() < 0.08) this.act({ type: 'chat', channel: rnd(v.channels), text: rnd(LINES) });
  }
}

const clients = [];
for (let i = 0; i < 6; i++) clients.push(new Client(i, 'male'), new Client(i + 6, 'female'));
for (const c of clients) await c.signup();
for (const c of clients) await c.connect();
const t0 = Date.now();
for (const c of clients) c.send({ t: 'queue.join' });

// 재접속 시험: 한 명이 자유 구경 중 끊겼다 다시 들어온다
let reconnected = false;
const timer = setInterval(async () => {
  const v = clients[3].view;
  if (!reconnected && v?.phase === 'freeRoam') {
    reconnected = true;
    clients[3].ws.close();
    await new Promise((r) => setTimeout(r, 300));
    await clients[3].connect();
  }
}, 100);

await new Promise((resolve, reject) => {
  const iv = setInterval(() => {
    if (clients.every((c) => c.view?.phase === 'ended')) {
      clearInterval(iv);
      resolve();
    }
    if (Date.now() - t0 > (75 * 60 * 1000) / timeScale + 60_000) reject(new Error('시간 초과'));
  }, 200);
});
clearInterval(timer);

const room = [...app.rooms.values()][0].room;
const elapsedReal = (Date.now() - t0) / 1000;
const nominalSec = elapsedReal * timeScale;
const totalBytes = clients.reduce((s, c) => s + c.bytes, 0);
const perUser = totalBytes / clients.length;
const ev = (t) => room.events.filter((e) => e.type === t);

console.log(`\n== 시뮬레이션 결과 (${preset}, 배속 ×${timeScale}) ==`);
console.log('단계 순서:', clients[0].phases.join(' → '));
console.log('첫인상 투표 성별:', room.voterGender, '/ 데이트권 게임 성별:', room.ticketGender);
console.log('1차 데이트 그룹 크기:', room.dates.date1.map((g) => `${g.members.length - 1}:1`).join(', '));
console.log('2차 데이트:', room.dates.date2.length, '쌍', '/ 3차:', room.dates.date3.length, '쌍');
console.log('자기소개 완료:', room.intro.done.length, '명, 건너뜀:', room.intro.skipped.length);
console.log('최종 매치:', room.matches.length, '쌍');
console.log('재접속 복구:', reconnected && clients[3].view.phase === 'ended' ? 'OK' : 'FAIL');
console.log('비공개 정보 누출:', clients.flatMap((c) => c.leaks).length ? clients.flatMap((c) => c.leaks).slice(0, 5) : '없음');
console.log('음성 작업 수(모의):', app.voice.ops.length, '/ 종료 후 남은 송출:', Object.values(app.voice.snapshot(room.id)).filter((x) => x.publish).length);
console.log('이벤트 기록:', ev('vote').length, '투표,', ev('pick').length, '지목,', ev('final').length, '최종선택');
console.log(`실제 소요 ${elapsedReal.toFixed(1)}s → 환산 ${(nominalSec / 60).toFixed(1)}분 (설정 예상 ${estimateMinutes(app.config)}분, 자기소개 조기종료 포함)`);
console.log(`게임 상태 수신량: 1인당 ${(perUser / 1024).toFixed(0)}KB / 회차, 메시지 ${Math.round(clients.reduce((s, c) => s + c.msgs, 0) / 12)}개`);
console.log(`  → 설정 기준 ${estimateMinutes(app.config)}분 회차로 나누면 평균 ${(perUser / (estimateMinutes(app.config) * 60)).toFixed(0)} B/s/인`);

const ok = clients.every((c) => c.view.phase === 'ended') && !clients.some((c) => c.leaks.length) && reconnected;
app.close();
for (const c of clients) c.ws.close();
process.exit(ok ? 0 : 1);
