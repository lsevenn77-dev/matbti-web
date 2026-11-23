import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';
import { makeConfig, PRESETS, estimateMinutes } from '../server/config.js';
import { MockVoiceAdapter } from '../server/voice.js';

function seeded(seed = 1) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function setup(overrides = {}, { voter = 'female', seed = 7 } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, add: (ms) => (t += ms) };
  const cfg = makeConfig({ firstVote: { voterGender: voter } }, overrides);
  const members = [];
  for (const g of ['male', 'female']) {
    for (let i = 0; i < 6; i++) {
      members.push({ userId: `${g}${i}`, profile: { gender: g, age: 25 + i, job: `JOB_${g}_${i}`, region: `REGION_${g}_${i}`, photoUrl: `/photos/${g}${i}` } });
    }
  }
  const voice = new MockVoiceAdapter();
  const room = new Room({ id: 'r1', config: cfg, members, now: clock.now, rng: seeded(seed), voice });
  for (const p of room.participants.values()) room.setConnected(p.id, true);
  room.start();
  return { room, clock, voice, cfg };
}

/** 현재 단계가 끝날 때까지 시간을 흘린다 */
function runUntil(room, clock, phase, stepMs = 500, max = 20_000) {
  for (let i = 0; i < max && room.phase !== phase; i++) {
    clock.add(stepMs);
    room.tick();
  }
  assert.equal(room.phase, phase);
}

const males = (room) => room.byGender('male').map((p) => p.id);
const females = (room) => room.byGender('female').map((p) => p.id);

test('가명과 캐릭터는 성별 입장 순서대로 부여된다', () => {
  const { room } = setup();
  assert.deepEqual(room.byGender('male').map((p) => p.alias), ['태양', '우주', '강산', '하늘', '바다', '노을']);
  assert.deepEqual(room.byGender('female').map((p) => p.alias), ['이슬', '장미', '보라', '나래', '미소', '여름']);
  assert.equal(new Set([...room.participants.values()].map((p) => p.characterId)).size, 12);
});

test('자기소개 전에는 나이·직업·사는 곳이 전송 데이터에 없다', () => {
  const { room } = setup();
  const v = room.viewFor('p1');
  const others = JSON.stringify(v.participants.filter((p) => p.id !== 'p1'));
  assert.ok(!others.includes('JOB_'));
  assert.ok(!others.includes('REGION_'));
  assert.ok(v.participants.every((p) => p.photoUrl)); // 첫인상에서도 사진은 보인다
  // 본인에게는 자기 정보가 보인다
  assert.equal(v.me.private.job, 'JOB_male_0');
});

test('첫인상 6:1 그룹, 0표 참가자는 숙소 텍스트, 중복 투표는 한 번만 처리', () => {
  const { room, clock } = setup({}, { voter: 'female' });
  runUntil(room, clock, 'firstVote');
  const [m0] = males(room);
  for (const f of females(room)) assert.equal(room.handle(f, { type: 'vote', target: m0 }).ok, true);
  assert.equal(room.handle(females(room)[0], { type: 'vote', target: males(room)[1] }).ok, false);
  // 남자는 투표권 없음
  assert.equal(room.handle(m0, { type: 'vote', target: females(room)[0] }).ok, false);
  runUntil(room, clock, 'date1');
  assert.equal(room.dates.date1.length, 1);
  assert.equal(room.dates.date1[0].members.length, 7);
  const lonely = males(room)[3];
  assert.equal(room.zoneOf(lonely), 'dorm_male');
  assert.deepEqual(room.channelsFor(lonely), ['dorm_male']);
  assert.equal(room.voicePerms()[lonely].publish, false);
  assert.deepEqual(room.voicePerms()[lonely].subscribe, []);
});

test('데이트 그룹끼리만 음성이 오가고 다른 그룹은 들을 수 없다', () => {
  const { room, clock, voice } = setup({}, { voter: 'male' });
  runUntil(room, clock, 'firstVote');
  const M = males(room);
  const F = females(room);
  M.forEach((m, i) => room.handle(m, { type: 'vote', target: F[i % 3] })); // 3개 그룹 2:1
  runUntil(room, clock, 'date1');
  const snap = voice.snapshot('r1');
  for (const g of room.dates.date1) {
    for (const a of g.members) {
      for (const s of snap[a].subscribe) assert.ok(g.members.includes(s), `${a} 가 다른 그룹 ${s} 를 구독`);
    }
  }
  // 선택받지 못한 여자 3명은 음성 없음
  for (const f of F.slice(3)) assert.deepEqual(snap[f], { publish: false, subscribe: [] });
  // 자유 구경(텍스트)으로 넘어가면 모든 구독이 실제로 해제된다
  runUntil(room, clock, 'freeRoam');
  const after = voice.snapshot('r1');
  assert.ok(Object.values(after).every((x) => !x.publish && x.subscribe.length === 0));
  assert.ok(voice.ops.some((o) => o.op === 'unsubscribe'));
});

test('자기소개: 발표자 1명만 송출, 소개 후 공개(afterEach), 일찍 끝내기', () => {
  const { room, clock, voice } = setup({ profileReveal: 'afterEach' });
  runUntil(room, clock, 'selfIntro');
  clock.add(20_000);
  room.tick();
  const sp = room.intro.speakerId;
  assert.ok(sp);
  const perms = room.voicePerms();
  assert.deepEqual(Object.entries(perms).filter(([, v]) => v.publish).map(([k]) => k), [sp]);
  for (const [id, v] of Object.entries(perms)) if (id !== sp) assert.deepEqual(v.subscribe, [sp]);
  assert.equal(voice.snapshot('r1')[sp].publish, true);
  // 다른 사람은 일찍 끝내기 불가
  const other = room.intro.order[1];
  assert.equal(room.handle(other, { type: 'introDone' }).ok, false);
  assert.equal(room.participants.get(sp).revealed, false);
  assert.equal(room.handle(sp, { type: 'introDone' }).ok, true);
  assert.equal(room.participants.get(sp).revealed, true);
  assert.ok(room.viewFor(other).participants.find((p) => p.id === sp).job);
  // 교대 시간에는 아무도 송출하지 않는다
  assert.ok(Object.values(room.voicePerms()).every((v) => !v.publish));
});

test('프로필 공개 afterAll 이면 전원 소개가 끝나야 공개된다', () => {
  const { room, clock } = setup({ profileReveal: 'afterAll' });
  runUntil(room, clock, 'selfIntro');
  clock.add(20_000);
  room.tick();
  room.handle(room.intro.speakerId, { type: 'introDone' });
  assert.ok([...room.participants.values()].every((p) => !p.revealed));
  runUntil(room, clock, 'minigame');
  assert.ok([...room.participants.values()].every((p) => p.revealed));
});

test('발표자가 접속하지 않으면 정해진 시간 뒤 넘어간다', () => {
  const { room, clock } = setup();
  runUntil(room, clock, 'selfIntro');
  const first = room.intro.order[0];
  room.setConnected(first, false);
  clock.add(1000);
  room.tick();
  clock.add(16_000);
  room.tick();
  assert.ok(room.intro.skipped.includes(first));
});

test('전체 흐름 — 3회 원안(제안 A: 데이트권 3장)', () => {
  const { room, clock } = setup({}, { voter: 'female' });
  runUntil(room, clock, 'minigame');
  assert.equal(room.ticketGender, 'male');
  assert.deepEqual(room.minigame.players, males(room));
  // 남자들이 반응 게임
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 200 && room.minigame.rounds[room.minigame.round].goAt > clock.now(); i++) {
      clock.add(100);
      room.tick();
    }
    clock.add(600);
    males(room).forEach((m, i) => room.handle(m, { type: 'tap', reactionMs: 200 + i * 50 }));
    clock.add(100);
    room.tick();
  }
  assert.ok(room.minigame.ranking);
  assert.equal(room.minigame.ranking[0].pid, males(room)[0]);
  runUntil(room, clock, 'date2Pick');
  assert.deepEqual(room.pick.pickers, males(room).slice(0, 3));
  // 차례가 아닌 사람은 지목 불가, 이미 지목된 상대 중복 불가
  assert.equal(room.handle(males(room)[1], { type: 'pick', target: females(room)[0] }).ok, false);
  assert.equal(room.handle(males(room)[0], { type: 'pick', target: females(room)[0] }).ok, true);
  assert.equal(room.handle(males(room)[1], { type: 'pick', target: females(room)[0] }).ok, false);
  room.handle(males(room)[1], { type: 'pick', target: females(room)[1] });
  room.handle(males(room)[2], { type: 'pick', target: females(room)[2] });
  runUntil(room, clock, 'date2');
  assert.equal(room.dates.date2.length, 3);
  runUntil(room, clock, 'date3');
  assert.equal(room.dates.date3.length, 6);
  // 랜덤 데이트는 이전 2차 상대를 피한다
  for (const [a, b] of room.dates.date2.map((g) => g.members)) {
    assert.ok(!room.dates.date3.some((g) => g.members.includes(a) && g.members.includes(b)));
  }
  runUntil(room, clock, 'finalChoice');
  const M = males(room);
  const F = females(room);
  room.handle(M[0], { type: 'final', target: F[0] });
  room.handle(F[0], { type: 'final', target: M[0] });
  room.handle(M[1], { type: 'final', target: F[1] });
  room.handle(F[1], { type: 'final', target: M[2] });
  assert.equal(room.handle(M[0], { type: 'final', target: F[3] }).ok, false); // 중복 제출 무시
  runUntil(room, clock, 'result');
  assert.deepEqual(room.matches, [[M[0], F[0]]]);
  assert.equal(room.viewFor(M[0]).result.matchedWith, F[0]);
  assert.equal(room.viewFor(M[1]).result.matchedWith, null);
  assert.equal(room.viewFor(M[1]).result.couples, undefined); // 기본값: 본인 결과만
  runUntil(room, clock, 'ended');
});

test('비교안 — 랜덤 데이트 삭제 + 2차 전원 지목 순서', () => {
  const { room, clock, cfg } = setup(PRESETS.twoDates, { voter: 'male' });
  assert.ok(!room.phases.includes('date3'));
  runUntil(room, clock, 'date2Pick', 1000);
  assert.equal(room.pick.pickers.length, 6);
  runUntil(room, clock, 'date2', 1000); // 지목 시간 초과 시 남은 상대 중 자동 배정
  assert.equal(room.dates.date2.length, 6);
  const all = room.dates.date2.flatMap((g) => g.members);
  assert.equal(new Set(all).size, 12);
  runUntil(room, clock, 'ended', 1000);
  assert.ok(estimateMinutes(cfg) < estimateMinutes(makeConfig()) + 5);
});

test('채팅 채널 권한 — 데이트 중 숙소 사람은 데이트 채널에 쓸 수 없다', () => {
  const { room, clock } = setup({}, { voter: 'female' });
  runUntil(room, clock, 'firstVote');
  room.handle(females(room)[0], { type: 'vote', target: males(room)[0] });
  runUntil(room, clock, 'date1');
  const g = room.dates.date1[0];
  assert.equal(room.handle(males(room)[5], { type: 'chat', channel: `date:${g.id}`, text: 'hi' }).ok, false);
  assert.equal(room.handle(males(room)[5], { type: 'chat', channel: 'dorm_male', text: 'hi' }).ok, true);
  assert.equal(room.handle(males(room)[5], { type: 'chat', channel: 'dorm_female', text: 'hi' }).ok, false);
  assert.equal(room.handle(g.members[1], { type: 'chat', channel: `date:${g.id}`, text: 'hi' }).ok, true);
});

test('연락처 교환(켰을 때) — 양쪽 모두 동의해야만 공개', () => {
  const { room, clock } = setup({ contactExchange: { enabled: true }, randomDate: { enabled: false } });
  runUntil(room, clock, 'finalChoice', 1000);
  const [a, b, c] = males(room);
  const [x, y, z] = females(room);
  room.handle(a, { type: 'final', target: x });
  room.handle(x, { type: 'final', target: a });
  room.handle(b, { type: 'final', target: y });
  room.handle(y, { type: 'final', target: b });
  void c; void z;
  runUntil(room, clock, 'contact', 1000);
  room.handle(a, { type: 'contact', consent: true, contact: 'A-CONTACT' });
  room.handle(x, { type: 'contact', consent: true, contact: 'X-CONTACT' });
  room.handle(b, { type: 'contact', consent: true, contact: 'B-CONTACT' });
  room.handle(y, { type: 'contact', consent: false });
  assert.equal(room.viewFor(a).contact.partnerContact, 'X-CONTACT');
  assert.equal(room.viewFor(y).contact.partnerContact, null);
  assert.equal(room.viewFor(b).contact.partnerContact, null);
  // 다른 참가자 응답에는 연락처 원문이 없다
  assert.ok(!JSON.stringify(room.viewFor(c)).includes('CONTACT'));
});

test('기본 설정 예상 시간은 기획서 70분안과 맞다', () => {
  assert.equal(Math.round(estimateMinutes(makeConfig())), 69); // 표의 '전환 여유 1분' 제외
});
