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

test('첫인상: 남녀 전원 투표, 1차는 먼저 뽑힌 성별의 선택(6:1 가능), 2차는 반대 성별의 선택', () => {
  const { room, clock } = setup({}, { voter: 'female' });
  runUntil(room, clock, 'firstVote');
  const M = males(room);
  const F = females(room);
  for (const f of F) assert.equal(room.handle(f, { type: 'vote', target: M[0] }).ok, true);
  assert.equal(room.handle(F[0], { type: 'vote', target: M[1] }).ok, false); // 중복 투표는 한 번만
  // 남자도 투표한다 (2차 데이트용)
  assert.equal(room.handle(M[0], { type: 'vote', target: F[2] }).ok, true);
  assert.equal(room.handle(M[1], { type: 'vote', target: F[2] }).ok, true);
  assert.equal(room.handle(M[2], { type: 'vote', target: M[3] }).ok, false); // 같은 성별은 못 고름
  assert.equal(room.viewFor(M[5]).vote.canVote, true);
  assert.equal(room.viewFor(M[5]).vote.total, 12);
  runUntil(room, clock, 'date1');
  assert.equal(room.dates.date1.length, 1);
  assert.equal(room.dates.date1[0].members.length, 7);
  assert.deepEqual(room.dates.date2.map((g) => g.members), [[F[2], M[0], M[1]]]);
  const lonely = M[3];
  assert.equal(room.zoneOf(lonely), 'dorm_male');
  assert.deepEqual(room.channelsFor(lonely), ['dorm_male']);
  assert.equal(room.voicePerms()[lonely].publish, false);
  assert.deepEqual(room.voicePerms()[lonely].subscribe, []);
  runUntil(room, clock, 'date2', 1000, 200_000);
  assert.equal(room.zoneOf(M[0]), 'date:0');
  assert.equal(room.zoneOf(M[3]), 'dorm_male');
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
  // 소개 마치기 → 1분 질문 시간 (발표자 계속 송출)
  assert.equal(room.handle(sp, { type: 'introDone' }).ok, true);
  assert.equal(room.intro.qna, true);
  assert.equal(room.intro.speakerId, sp);
  assert.equal(room.voicePerms()[sp].publish, true);
  assert.equal(room.participants.get(sp).revealed, false);
  // 질문 받기 마치기 → 공개, 다음 사람
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

test('전체 흐름 — 데이트 4회 (1차·2차 첫인상, 3차 보물찾기 데이트권 남녀 각 2장, 4차 사다리)', () => {
  const { room, clock } = setup({}, { voter: 'female' });
  assert.deepEqual(room.phases.filter((x) => x.startsWith('date')), ['date1', 'date2', 'date3Pick', 'date3', 'date4']);
  runUntil(room, clock, 'firstVote');
  const M = males(room);
  const F = females(room);
  M.forEach((m, i) => room.handle(m, { type: 'vote', target: F[i] }));
  F.forEach((f, i) => room.handle(f, { type: 'vote', target: M[(i + 1) % 6] }));
  runUntil(room, clock, 'date1');
  assert.equal(room.dates.date1.length, 6); // 여자 선택
  assert.ok(room.dates.date1.every((g) => g.focus && M.includes(g.focus)));
  runUntil(room, clock, 'date2', 1000, 200_000);
  assert.ok(room.dates.date2.every((g) => F.includes(g.focus))); // 남자 선택
  runUntil(room, clock, 'minigame');
  assert.equal(room.minigame.players.length, 12);
  assert.deepEqual(room.minigame.total, { male: 2, female: 2 });
  // 남녀 각자 자기 성별 보물을 찾는다: M0, F0, M1, F1 순서
  const take = (pid) => {
    const g = room.participants.get(pid).gender;
    for (let i = 0; i < 200 && !room.minigame.active[g]; i++) {
      clock.add(200);
      room.tick();
    }
    const tr = room.minigame.active[g];
    assert.ok(tr, `${g} 보물이 나타나야 한다`);
    assert.ok(room.canRoam(pid));
    room.handle(pid, { type: 'move', x: tr.x + 0.3, z: tr.z });
    room.tick();
  };
  take(M[0]);
  take(F[0]);
  take(M[1]);
  // 남자 데이트권 2장을 다 찾으면 남자 보물은 더 안 나온다
  assert.equal(room.minigame.active.male, null);
  take(F[1]);
  assert.ok(room.minigame.ranking);
  assert.deepEqual(room.minigame.ranking.map((r) => r.pid), [M[0], F[0], M[1], F[1]]);
  runUntil(room, clock, 'date3Pick');
  assert.deepEqual(room.pick.pickers, [M[0], F[0], M[1], F[1]]);
  // 차례가 아닌 사람은 지목 불가
  assert.equal(room.handle(F[0], { type: 'pick', target: M[2] }).ok, false);
  assert.equal(room.handle(M[0], { type: 'pick', target: F[1] }).ok, true); // M0 → F1 (F1 은 데이트권이 있지만 지목받음)
  assert.equal(room.handle(F[0], { type: 'pick', target: M[0] }).ok, false); // 이미 짝이 정해진 사람은 못 고름
  assert.equal(room.handle(F[0], { type: 'pick', target: M[1] }).ok, true); // F0 → M1 → M1 은 지목받았으니 차례를 건너뛴다
  assert.deepEqual(room.pick.skipped, [M[1], F[1]]);
  assert.equal(room.pick.index, 4);
  runUntil(room, clock, 'date3');
  assert.equal(room.dates.date3.length, 2);
  runUntil(room, clock, 'date4');
  assert.equal(room.dates.date4.length, 6);
  runUntil(room, clock, 'finalChoice');
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

test('비교안 — 4차 랜덤 데이트 없이 3회', () => {
  const { room, clock, cfg } = setup(PRESETS.threeDates, { voter: 'male' });
  assert.ok(!room.phases.includes('date4'));
  assert.ok(!room.phases.includes('randomAssign'));
  runUntil(room, clock, 'date3Pick', 1000, 200_000);
  assert.equal(room.pick.pickers.length, 4); // 아무도 못 찾으면 남녀 각 2명 추첨
  runUntil(room, clock, 'date3', 1000); // 지목 시간 초과 시 남은 상대 중 자동 배정
  assert.ok(room.dates.date3.length >= 2 && room.dates.date3.length <= 4);
  runUntil(room, clock, 'ended', 1000);
  assert.ok(estimateMinutes(cfg) < estimateMinutes(makeConfig()));
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

test('기본 설정 예상 시간 (데이트 4분 × 3 + 사다리 뒤 6분, 자기소개 1분+질문 1분)', () => {
  assert.equal(Math.round(estimateMinutes(makeConfig())), 62);
});

test('데이트 중 숙소에서 기다리는 사람은 돌아다닐 수 있고, 데이트 중인 사람은 못 움직인다', () => {
  const { room, clock } = setup({}, { voter: 'female' });
  runUntil(room, clock, 'firstVote');
  room.handle(females(room)[0], { type: 'vote', target: males(room)[0] });
  runUntil(room, clock, 'date1');
  const g = room.dates.date1[0];
  const waiting = males(room)[5];
  assert.equal(room.handle(waiting, { type: 'move', x: 1, z: 2 }).ok, true);
  assert.equal(room.handle(waiting, { type: 'emote', kind: 'jump' }).ok, true);
  assert.equal(room.handle(g.members[0], { type: 'move', x: 1, z: 2 }).ok, false);
  const v = room.viewFor(g.members[0]);
  assert.ok(v.roaming.includes(waiting));
  assert.ok(!v.roaming.includes(g.members[0]));
  assert.deepEqual(v.positions[waiting], { x: 1, z: 2 });
  // 다음 단계로 넘어가면 위치는 초기화된다
  runUntil(room, clock, 'freeRoam');
  assert.equal(room.viewFor(waiting).positions[waiting], undefined);
});

test('개발 도구: 다음 단계 건너뛰기로 끝까지 가고, 배속 변경은 남은 시간을 줄인다', () => {
  const { room, clock } = setup({}, { voter: 'female' });
  runUntil(room, clock, 'firstVote');
  const left = room.phaseEndsAt - room.now();
  room.devSetSpeed(10);
  assert.ok(Math.abs(room.phaseEndsAt - room.now() - left / 10) < 5);
  room.devSetSpeed(1);
  let guard = 0;
  while (room.phase !== 'ended' && guard++ < 50) room.devSkip();
  assert.equal(room.phase, 'ended');
});

test('정상 속도 봇은 단계 시간을 사람처럼 쓰고(첫인상 투표가 바로 끝나지 않음) 끝까지 진행된다', async () => {
  const { BotDriver } = await import('../server/bots.js');
  const { room, clock } = setup({}, { voter: 'female' });
  for (const p of room.participants.values()) p.isBot = true;
  const bots = new BotDriver(room, { introSec: null, realistic: true, rng: seeded(3) });
  const step = () => { clock.add(500); bots.tick(); room.tick(); };
  while (room.phase !== 'firstVote') step();
  const start = room.now();
  while (room.phase === 'firstVote') step();
  assert.ok(room.now() - start > 30_000, `첫인상 투표가 ${(room.now() - start) / 1000}초 만에 끝남`);
  let guard = 0;
  while (room.phase !== 'ended' && guard++ < 20_000) step();
  assert.equal(room.phase, 'ended');
});

test('4차 사다리타기: 각자 칸을 고르고, 공개 전에는 가로줄이 숨겨지며, 결과는 1:1 짝', () => {
  const { room, clock } = setup({}, { voter: 'female' });
  runUntil(room, clock, 'randomAssign', 1000, 200_000);
  const M = males(room);
  const F = females(room);
  assert.equal(room.handle(M[0], { type: 'ladder', slot: 2 }).ok, true);
  assert.equal(room.handle(M[1], { type: 'ladder', slot: 2 }).ok, false); // 이미 고른 칸
  assert.equal(room.handle(F[0], { type: 'ladder', slot: 2 }).ok, true); // 여자는 아래 칸이라 겹치지 않음
  assert.equal(room.handle(M[0], { type: 'ladder', slot: 4 }).ok, true); // 바꾸기 가능
  const v = room.viewFor(M[1]);
  assert.equal(v.ladder.rungs, null);
  assert.equal(v.ladder.top[4], M[0]);
  room.devSkip(); // 공개 전에 넘겨도 배정은 된다
  assert.equal(room.phase, 'date4');
  assert.equal(room.dates.date4.length, 6);
  const all = room.dates.date4.flatMap((g) => g.members);
  assert.equal(new Set(all).size, 12);
  // 경로 확인: M[0] 은 4번 칸에서 출발해 도착한 칸의 여자와 짝
  const dest = room.ladderPath(4);
  const g = room.dates.date4.find((x) => x.members.includes(M[0]));
  assert.equal(g.members[1], room.ladder.bottom[dest]);
});

test('보물찾기: 남녀 따로, 다른 성별 보물·순간이동·두 번째 발견은 인정하지 않고, 오래 못 찾으면 옮겨간다', () => {
  const { room, clock } = setup({}, { voter: 'female' });
  runUntil(room, clock, 'minigame', 500, 200_000);
  const M = males(room);
  const F = females(room);
  const waitSpawn = (g) => {
    for (let i = 0; i < 200 && !room.minigame.active[g]; i++) {
      clock.add(200);
      room.tick();
    }
    return room.minigame.active[g];
  };
  let tr = waitSpawn('male');
  const ftr = waitSpawn('female');
  assert.ok(tr && ftr);
  // 남자 보물과 여자 보물은 떨어진 곳에
  assert.ok(Math.hypot(tr.x - ftr.x, tr.z - ftr.z) >= 4);
  // 마당 가운데(시작 위치)에서 너무 가까운 곳에는 생기지 않는다
  assert.ok(Math.hypot(tr.x, tr.z) >= room.cfg.minigame.minSpawnDist - 0.7);
  // 보물은 같은 성별에게만 보인다
  assert.equal(room.viewFor(M[0]).minigame.treasure.id, tr.id);
  assert.equal(room.viewFor(F[0]).minigame.treasure.id, ftr.id);
  // 여자가 남자 보물 위에 서도 소용없다
  room.handle(F[0], { type: 'move', x: tr.x, z: tr.z });
  assert.equal(room.minigame.found.length, 0);
  // 순간이동: 멀리 있다가 0.1초 만에 보물 위로 → 인정 안 함
  room.handle(M[0], { type: 'move', x: -20, z: -20 });
  clock.add(100);
  room.handle(M[0], { type: 'move', x: tr.x, z: tr.z });
  assert.equal(room.minigame.found.length, 0);
  // 반경 밖은 인정 안 함
  room.handle(M[1], { type: 'move', x: tr.x + 1.2, z: tr.z });
  assert.equal(room.minigame.found.length, 0);
  // 40초 동안 아무도 못 찾으면 다른 곳으로
  const firstId = tr.id;
  clock.add(41_000);
  room.tick();
  assert.notEqual(room.minigame.active.male.id, firstId);
  tr = room.minigame.active.male;
  // 걸어서 도착 → 인정
  room.handle(M[2], { type: 'move', x: tr.x + 2, z: tr.z });
  clock.add(400);
  room.handle(M[2], { type: 'move', x: tr.x + 0.5, z: tr.z });
  assert.equal(room.minigame.found[0].pid, M[2]);
  assert.equal(room.minigame.found[0].gender, 'male');
  assert.equal(room.minigame.active.male, null);
  // 이미 찾은 사람은 다음 보물을 가져가지 못한다
  tr = waitSpawn('male');
  clock.add(2000);
  room.handle(M[2], { type: 'move', x: tr.x, z: tr.z });
  assert.equal(room.minigame.found.length, 1);
  const v = room.viewFor(M[2]);
  assert.equal(v.minigame.type, 'treasure');
  assert.equal(v.minigame.myFound, true);
  assert.equal(v.minigame.total, 2);
  // 시간이 끝나면 성별마다 못 찾은 데이트권은 남은 사람 중 추첨 (찾은 사람이 먼저 지목)
  room.devSkip();
  assert.equal(room.phase, 'date3Pick');
  const rk = room.minigame.ranking;
  assert.equal(rk[0].pid, M[2]);
  assert.equal(rk.length, 4);
  assert.equal(rk.filter((r) => room.participants.get(r.pid).gender === 'male').length, 2);
  assert.equal(rk.filter((r) => room.participants.get(r.pid).gender === 'female').length, 2);
  assert.ok(rk.slice(1).every((r) => r.drawn));
  assert.equal(room.pick.pickers[0], M[2]);
});

test('미니게임 type=reaction 이면 예전 반응 속도 게임 (성별마다 상위 2명 데이트권)', () => {
  const { room, clock } = setup({ minigame: { type: 'reaction' } }, { voter: 'female' });
  runUntil(room, clock, 'minigame', 500, 200_000);
  const all = [...room.participants.keys()];
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 200 && room.minigame.rounds[room.minigame.round].goAt > clock.now(); i++) {
      clock.add(100);
      room.tick();
    }
    clock.add(600);
    all.forEach((pid, i) => room.handle(pid, { type: 'tap', reactionMs: 200 + i * 50 }));
    clock.add(100);
    room.tick();
  }
  assert.ok(room.minigame.ranking);
  assert.equal(room.minigame.ranking[0].pid, all[0]);
  runUntil(room, clock, 'date3Pick');
  const M = males(room);
  const F = females(room);
  assert.deepEqual([...room.pick.pickers].sort(), [M[0], M[1], F[0], F[1]].sort());
});
