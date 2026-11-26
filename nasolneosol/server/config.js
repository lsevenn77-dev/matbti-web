// 나솔너솔 게임 설정
//
// 표기 규칙
//   [확정]  사용자가 정한 규칙 (기획서 01장)
//   [임시]  시제품 진행용 임시값. 사용자 승인값이 아니다. 실제 플레이 후 결정한다.
//
// 시간 단위는 모두 "초". 개발 중에는 TIME_SCALE 환경변수로 전체 시간을 빠르게 돌릴 수 있다.

export const ALIASES = {
  // [확정] 성별별 입장 순서에 따른 회차 가명
  male: ['태양', '우주', '강산', '하늘', '바다', '노을'],
  female: ['이슬', '장미', '보라', '나래', '미소', '여름'],
};

// [확정] 고정 캐릭터 12개를 반복 사용. 색·헤어·소품은 [임시] 디자인 (최종 디자인 미확정)
export const CHARACTERS = [
  { id: 'c01', body: '#f4a259', hair: '#3b2a20', hairStyle: 'short', acc: 'none' },
  { id: 'c02', body: '#5b8e7d', hair: '#1f1b18', hairStyle: 'spiky', acc: 'glasses' },
  { id: 'c03', body: '#7c9cc4', hair: '#6b4226', hairStyle: 'short', acc: 'cap' },
  { id: 'c04', body: '#c97b63', hair: '#2b2b2b', hairStyle: 'side', acc: 'none' },
  { id: 'c05', body: '#8fb996', hair: '#4a3222', hairStyle: 'spiky', acc: 'headphones' },
  { id: 'c06', body: '#d6a2ad', hair: '#1a1a1a', hairStyle: 'side', acc: 'glasses' },
  { id: 'c07', body: '#f2c57c', hair: '#5a3825', hairStyle: 'long', acc: 'ribbon' },
  { id: 'c08', body: '#e98a8a', hair: '#2a1d16', hairStyle: 'bob', acc: 'none' },
  { id: 'c09', body: '#a99bd6', hair: '#3e2b22', hairStyle: 'long', acc: 'flower' },
  { id: 'c10', body: '#7fc8a9', hair: '#8a5a3b', hairStyle: 'bun', acc: 'none' },
  { id: 'c11', body: '#f6b48f', hair: '#1d1d1d', hairStyle: 'bob', acc: 'ribbon' },
  { id: 'c12', body: '#9fc5e8', hair: '#5b3b2a', hairStyle: 'bun', acc: 'flower' },
];

export const DEFAULT_CONFIG = {
  configVersion: 'proto-0.1',

  // [확정] 한 방 12명 / [설계 전제] 남 6 · 여 6
  slots: { male: 6, female: 6 },

  // [임시] 성인 기준. 가입 연령 정책은 미정 (결정 대기 11번)
  minAge: 19,

  // 각 단계 길이 (초). 기획서 05장 70분 비교안을 기본값으로 사용 — 전부 [임시]
  durations: {
    intro: 60, //               입장 안내 + 선택 성별 추첨 발표
    firstVote: 60, //           첫인상 투표 1분 (안내 1분 + 투표 1분)
    date1: 300, //              1차 첫인상 데이트 5분
    freeRoam: 300, //           [확정] 자유 구경 5분
    introPerSpeaker: 60, //     자기소개 1인 1분
    introQnA: 60, //            소개 뒤 질문 받는 시간 1분 (발표자는 음성으로 답, 질문은 채팅)
    introGap: 10, //            발표자 교대 (12명 × 10초 = 2분)
    minigame: 150, //           미니게임 전체 제한
    date2Pick: 210, //          데이트 상대 선택 (미니게임+선택 합계 6분 안)
    date2: 300, //              2차 데이트 5분
    randomAssign: 90, //        3차 사다리타기: 출발점 고르기 + 결과 공개 (끝 20초가 공개)
    date3: 480, //              3차 데이트 8분
    finalChoice: 180, //        최종 선택
    result: 60, //              결과 확인
    contact: 120, //            연락처 교환 동의 (기능 사용 시)
  },

  // 자기소개
  selfIntro: {
    allowEarlyFinish: true, // [임시] 발표자가 일찍 끝낼 수 있음
    order: 'alternate', //    [임시] 'alternate'(남녀 교대) | 'entry'(입장순)
    skipIfAbsentSec: 15, //   [임시] 차례가 됐는데 발표자 접속이 없으면 n초 뒤 넘김
  },

  // 프로필 공개 시점 (결정 대기 5번) — 'afterEach' | 'afterAll'
  profileReveal: 'afterEach', // [임시]

  // 첫인상 투표 (결정 대기 6번)
  firstVote: {
    voterGender: 'random', // [확정] 랜덤 추첨. 테스트용으로 'male' | 'female' 고정 가능
    allowAbstain: true, //    [임시]
    groupCap: null, //        [임시] null = 상한 없음 (6:1 가능)
    revealVoteCounts: false, // [임시] 득표 수 전체 공개 안 함 — 내 데이트 그룹 구성만 보임
  },

  // 2차 데이트 (결정 대기 3, 7번)
  date2: {
    // 'tickets'      = 제안 A: 상위 N명만 데이트권, 순위대로 중복 없이 1:1 지목
    // 'allPickOrder' = 제안 B: 전원 1:1, 순위는 지목 순서
    mode: 'tickets', //           [임시] 3회 원안 + 제안 A
    ticketCount: 3, //            [임시] 제안값
    pickTimeoutSec: 25, //        [임시] 지목 1인 제한시간
    onPickTimeout: 'random', //   [임시] 'random'(남은 상대 중 랜덤) | 'forfeit'(권리 소멸)
    excludeDate1Partners: false, // [임시] 1차에서 만난 상대 지목 금지 여부
    requireAcceptance: false, //  [미구현] 상대 수락 절차 — 규칙 미정
  },

  // 미니게임 [임시] 반응 속도 3라운드 합산
  minigame: {
    type: 'reaction',
    rounds: 3,
    minDelaySec: 2,
    maxDelaySec: 5,
    windowSec: 3, //       신호 후 입력 대기
    missPenaltyMs: 3000, // 미입력·부정출발 벌점
  },

  // 3차 랜덤 데이트 (결정 대기 1번) — 원안 유지, 삭제는 검토 중
  randomDate: {
    enabled: true, //               [임시] 원안 3회 기준
    mode: 'ladder', //             [임시] 'ladder' 각자 사다리 출발점을 골라 짝 결정 | 'auto' 서버가 무작위 배정
    ladderRevealSec: 20, //        사다리 결과 공개(애니메이션) 시간
    avoidPreviousPartners: true, // [임시] auto 모드: 이전에 만난 상대 회피 우선
  },

  // 최종 선택 (결정 대기 8번)
  finalChoice: {
    allowAbstain: true, //     [임시]
    revealScope: 'self', //    [임시] 'self'(본인 결과만) | 'couples'(성사 커플 전체 공개)
  },

  // 연락처 교환 (결정 대기 9번) — 미채택. 켜면 양쪽 별도 동의 시에만 공개하는 추천안으로 동작
  contactExchange: { enabled: false },

  // 음성 [확정] 자기소개(발표자 1명 송출) · 데이트(같은 그룹끼리)만. 그 외 단계는 텍스트.
  // 이 값을 바꿔 숙소 음성을 켜는 설정은 일부러 두지 않는다.
};

// 비교용 프리셋 — 승인된 규칙이 아니다
export const PRESETS = {
  // 원안: 데이트 3회 (1차 첫인상 / 2차 게임 데이트권 / 3차 랜덤)
  threeDates: {},
  // 검토안: 랜덤 데이트 삭제 + 2차 전원 1:1 지목 순서 + 자기소개 2분 30초
  twoDates: {
    randomDate: { enabled: false },
    date2: { mode: 'allPickOrder' },
    durations: { introPerSpeaker: 150, introQnA: 0 },
  },
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

export function makeConfig(...overrides) {
  return overrides.reduce((acc, o) => deepMerge(acc, o), DEFAULT_CONFIG);
}

/** 예상 진행 시간(분) — 설정 비교용 */
export function estimateMinutes(cfg) {
  const d = cfg.durations;
  const n = cfg.slots.male + cfg.slots.female;
  let s = d.intro + d.firstVote + d.date1 + d.freeRoam + n * (d.introPerSpeaker + (d.introQnA ?? 0) + d.introGap)
    + d.minigame + d.date2Pick + d.date2 + d.finalChoice + d.result;
  if (cfg.randomDate.enabled) s += d.randomAssign + d.date3;
  if (cfg.contactExchange.enabled) s += d.contact;
  return Math.round((s / 60) * 10) / 10;
}
