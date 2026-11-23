// 음성 어댑터
//
// 게임 서버(room.js)는 "누가 송출할 수 있고, 누가 누구를 구독할 수 있는지"만 계산한다.
// 실제 SFU 연결은 어댑터가 담당한다. 게임 서버와 음성 전달 계층을 분리해 각각 측정·교체할 수 있게 한다.
//
// 현재는 MockVoiceAdapter 뿐이다. 실제 음성은 송수신되지 않는다.
// Cloudflare Realtime SFU 연동은 아이팩트 토크룸 코드/자격증명을 확인한 뒤 CloudflareSfuAdapter 를 구현한다.

/**
 * @typedef {{ publish: boolean, subscribe: string[] }} VoicePerm
 * @typedef {Record<string, VoicePerm>} VoicePermMap   participantId → 권한
 */

export class MockVoiceAdapter {
  constructor({ log = false } = {}) {
    this.log = log;
    /** roomId → participantId → { publish, subscribe:Set } */
    this.state = new Map();
    /** 테스트·디버그용 작업 기록 */
    this.ops = [];
  }

  /**
   * 서버가 계산한 최신 권한을 반영한다. 이전 상태와의 차이만 작업으로 만든다.
   * 실제 어댑터라면 여기서 트랙 발행 중단 / 구독 해제(볼륨 0이 아니라 실제 해제)를 호출한다.
   * @param {string} roomId
   * @param {VoicePermMap} perms
   */
  apply(roomId, perms) {
    const prev = this.state.get(roomId) ?? {};
    const next = {};
    const ops = [];
    const ids = new Set([...Object.keys(prev), ...Object.keys(perms)]);
    for (const id of ids) {
      const p = prev[id] ?? { publish: false, subscribe: new Set() };
      const n = perms[id] ?? { publish: false, subscribe: [] };
      const nSub = new Set(n.subscribe);
      if (p.publish && !n.publish) ops.push({ op: 'unpublish', who: id });
      if (!p.publish && n.publish) ops.push({ op: 'publish', who: id });
      for (const t of p.subscribe) if (!nSub.has(t)) ops.push({ op: 'unsubscribe', who: id, track: t });
      for (const t of nSub) if (!p.subscribe.has(t)) ops.push({ op: 'subscribe', who: id, track: t });
      next[id] = { publish: n.publish, subscribe: nSub };
    }
    this.state.set(roomId, next);
    for (const o of ops) this.ops.push({ roomId, ...o });
    if (this.log && ops.length) console.log(`[voice:mock] ${roomId}`, ops.map((o) => `${o.op}:${o.who}${o.track ? '←' + o.track : ''}`).join(' '));
    return ops;
  }

  /** 현재 실제로 연결된(것으로 가정한) 구독 관계 */
  snapshot(roomId) {
    const s = this.state.get(roomId) ?? {};
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { publish: v.publish, subscribe: [...v.subscribe] }]));
  }

  close(roomId) {
    this.apply(roomId, {});
    this.state.delete(roomId);
  }
}

/**
 * 실제 연동 자리. 아이팩트 토크룸의 Cloudflare SFU 코드가 제공되면 재사용 가능한 부분을 확인해 구현한다.
 * - App Secret 은 서버에서만 보관
 * - 서버가 회차·단계·발표자·데이트 그룹을 확인한 뒤에만 세션/트랙 발행·구독을 허용
 * - 단계·그룹이 바뀌면 이전 구독을 실제로 해제
 */
export class CloudflareSfuAdapter {
  constructor() {
    throw new Error('CloudflareSfuAdapter 는 아직 구현되지 않았다. 기존 SFU 코드와 자격증명 확인이 필요하다.');
  }
}
