// 나솔너솔 클라이언트: 화면 전환 · 서버 통신 · 단계별 UI
import { GameScene } from './scene.js';

const $ = (s) => document.querySelector(s);
const PHASE_NAMES = {
  waiting: '준비 중',
  intro: '입장 안내',
  firstVote: '첫인상 선택',
  date1: '1차 데이트 · 첫인상',
  freeRoam: '숙소 자유 구경',
  selfIntro: '자기소개',
  minigame: '미니게임',
  date2Pick: '데이트 상대 지목',
  date2: '2차 데이트',
  randomAssign: '랜덤 데이트 배정',
  date3: '3차 랜덤 데이트',
  finalChoice: '최종 선택',
  result: '결과 발표',
  contact: '연락처 교환',
  ended: '회차 종료',
};
const G = { male: '남자', female: '여자' };
const CHANNEL_NAMES = { lounge: '공용 거실', dorm_male: '남자 숙소', dorm_female: '여자 숙소' };

const st = {
  token: safeGet('nsns_token'),
  me: null,
  info: null,
  ws: null,
  view: null,
  clockOffset: 0, // 서버시각 - 로컬시각
  chat: new Map(), // channel → [msg]
  channel: null,
  scene: null,
  reqSeq: 0,
  pending: new Map(),
  selected: null,
  reconnectDelay: 500,
  lastPhase: null,
  installEvt: null,
};

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k, v) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ }
}
const serverNow = () => Date.now() + st.clockOffset;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

// ───────────── 시작 ─────────────
async function boot() {
  registerSW();
  setupInstall();
  st.info = await fetch('/api/info').then((r) => r.json()).catch(() => null);
  if (st.token) {
    const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${st.token}` } }).catch(() => null);
    if (r?.ok) {
      st.me = await r.json();
      connect();
      return;
    }
    if (r && r.status === 401) safeSet('nsns_token', null);
  }
  showSignup();
}

// ───────────── 가입 ─────────────
let photoData = null;
function showSignup(editing = false) {
  show('screen-signup');
  const f = $('#signup-form');
  f.dataset.editing = editing ? '1' : '';
  if (editing && st.me) {
    f.age.value = st.me.profile.age;
    f.job.value = st.me.profile.job;
    f.region.value = st.me.profile.region;
    for (const r of f.gender) r.checked = r.value === st.me.profile.gender;
    $('#photo-preview').src = st.me.profile.photoUrl;
    $('#photo-preview').hidden = false;
    $('#photo-hint').hidden = true;
    f.querySelector('button').textContent = '저장';
  }
  if (st.info) f.age.min = st.info.minAge;
}

$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  photoData = await resizePhoto(file, 360);
  $('#photo-preview').src = photoData;
  $('#photo-preview').hidden = false;
  $('#photo-hint').hidden = true;
});

async function resizePhoto(file, max) {
  const img = await createImageBitmap(file);
  // 정사각형으로 가운데를 잘라 max px 이하로 줄인다 (용량 절약)
  const side = Math.min(img.width, img.height);
  const c = document.createElement('canvas');
  c.width = c.height = Math.min(max, side);
  c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const editing = f.dataset.editing === '1';
  const body = { gender: f.gender.value, age: Number(f.age.value), job: f.job.value, region: f.region.value };
  if (photoData) body.photo = photoData;
  if (!editing && !photoData) return ($('#signup-error').textContent = '프로필 사진을 선택해 줘');
  const r = await fetch(editing ? '/api/me' : '/api/signup', {
    method: editing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(editing ? { Authorization: `Bearer ${st.token}` } : {}) },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) return ($('#signup-error').textContent = j.error);
  if (!editing) {
    st.token = j.token;
    safeSet('nsns_token', j.token);
    st.me = j.me;
    connect();
  } else {
    st.me = j;
    showLobby();
  }
  photoData = null;
});

// ───────────── 대기 ─────────────
function showLobby(status) {
  show('screen-lobby');
  $('#lobby-photo').src = st.me.profile.photoUrl;
  const p = st.me.profile;
  $('#lobby-me').textContent = `${G[p.gender]} · ${p.age}세 · ${p.job} · ${p.region}`;
  if (status) {
    $('#q-male').textContent = status.male;
    $('#q-female').textContent = status.female;
    $('#q-male-need').textContent = status.need.male;
    $('#q-female-need').textContent = status.need.female;
    $('#btn-queue').textContent = status.inQueue ? '대기 취소' : '입장 대기';
    $('#btn-queue').dataset.in = status.inQueue ? '1' : '';
    const mine = p.gender;
    const need = status.need[mine] - status[mine];
    $('#queue-msg').textContent = status.inQueue
      ? `대기 중이야. ${status.need.male - status.male > 0 ? `남자 ${Math.max(0, status.need.male - status.male)}명` : ''} ${status.need.female - status.female > 0 ? `여자 ${Math.max(0, status.need.female - status.female)}명` : ''} 더 오면 시작해.`
      : need <= 0 ? `${G[mine]} 자리는 다 찼어. 대기하면 다음 방에 들어가.` : '12명이 모이면 바로 시작해. (선착순)';
  }
  $('#btn-bots').hidden = !st.info?.devTools;
  if (st.info) {
    $('#lobby-info').textContent = `이번 설정: 데이트 ${st.info.dateRounds}회 · 예상 약 ${Math.round(st.info.estimateMinutes)}분${st.info.timeScale !== 1 ? ` (개발 배속 ×${st.info.timeScale})` : ''} · 음성: 모의 구현`;
  }
}
$('#btn-edit').addEventListener('click', () => showSignup(true));
$('#btn-queue').addEventListener('click', () => sendWs({ t: $('#btn-queue').dataset.in ? 'queue.leave' : 'queue.join' }));
$('#btn-bots').addEventListener('click', async () => {
  if (!$('#btn-queue').dataset.in) sendWs({ t: 'queue.join' });
  setTimeout(() => fetch('/api/dev/fill-bots', { method: 'POST' }), 300);
});

// ───────────── 통신 ─────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  st.ws = ws;
  ws.onopen = () => {
    st.reconnectDelay = 500;
    ws.send(JSON.stringify({ t: 'hello', token: st.token }));
    ping();
    $('#conn').hidden = true;
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (e.code === 4003) {
      safeSet('nsns_token', null);
      location.reload();
      return;
    }
    if (st.view) $('#conn').hidden = false;
    setTimeout(connect, st.reconnectDelay);
    st.reconnectDelay = Math.min(st.reconnectDelay * 2, 8000);
  };
}

function sendWs(m) {
  if (st.ws?.readyState === 1) st.ws.send(JSON.stringify(m));
}
function act(action) {
  const reqId = ++st.reqSeq;
  sendWs({ t: 'act', action, reqId });
  return new Promise((r) => st.pending.set(reqId, r));
}
function ping() {
  sendWs({ t: 'ping', c: Date.now() });
}
setInterval(ping, 15000);
// 앱 복귀 시 서버 최신 상태로 다시 맞춘다
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (st.ws?.readyState !== 1) connect();
    else ping();
  }
});

function onMessage(m) {
  if (m.t === 'pong') {
    const rtt = Date.now() - m.c;
    st.clockOffset = m.s + rtt / 2 - Date.now();
  } else if (m.t === 'welcome') {
    st.me = m.me;
  } else if (m.t === 'queue') {
    st.view = null;
    showLobby(m.status);
  } else if (m.t === 'state') {
    onState(m.view);
  } else if (m.t === 'chat') {
    addChat(m.message);
  } else if (m.t === 'ack') {
    st.pending.get(m.reqId)?.(m);
    st.pending.delete(m.reqId);
    if (!m.ok) toast(m.error);
  }
}

// ───────────── 게임 ─────────────
function onState(v) {
  const first = !st.view;
  st.view = v;
  if (first) {
    show('screen-game');
    st.scene ??= new GameScene($('#scene'), { onTapCharacter: openProfile, onTapFloor: tapFloor });
    st.scene.resize();
    st.chat.clear();
  }
  if (v.chatHistory) for (const msg of v.chatHistory) addChat(msg, true);
  if (st.lastPhase !== v.phase) {
    if (st.lastPhase) toast(phaseToast(v));
    st.lastPhase = v.phase;
    st.selected = null;
    $('#profile-card').hidden = true;
  }
  st.scene.update(v);
  renderHud();
  renderPanel();
  renderChatTabs();
  if ($('#profile-card').dataset.pid && !$('#profile-card').hidden) openProfile($('#profile-card').dataset.pid);
}

function P(id) {
  return st.view.participants.find((p) => p.id === id);
}
function name(id) {
  const p = P(id);
  return p ? p.alias : '?';
}

function phaseToast(v) {
  if (v.phase === 'firstVote') return v.voterGender === v.me.gender ? '첫인상 선택 시간이야. 사진을 보고 한 명을 골라 줘.' : `이번 회차는 ${G[v.voterGender]}가 선택해. 기다려 줘.`;
  if (v.myDate) return `${PHASE_NAMES[v.phase]} 시작! 같은 그룹끼리만 음성이 연결돼 (모의).`;
  if (v.phase.startsWith('date')) return '이번 데이트에는 참여하지 않아. 숙소에서 텍스트로 대화할 수 있어.';
  return `${PHASE_NAMES[v.phase]}`;
}

function renderHud() {
  const v = st.view;
  $('#phase-name').textContent = PHASE_NAMES[v.phase] ?? v.phase;
  let sub = '';
  if (v.phase === 'intro' && v.voterGender) sub = `첫인상 선택: ${G[v.voterGender]} · 2차 데이트권 게임: ${G[v.ticketGender]}`;
  else if (v.myDate) sub = `함께: ${v.myDate.members.filter((x) => x !== v.me.id).map(name).join(', ')}`;
  else if (v.phase.startsWith('date')) sub = `${CHANNEL_NAMES[`dorm_${v.me.gender}`]}에서 대기 · 텍스트만`;
  else if (v.phase === 'selfIntro' && v.intro) sub = `${Math.min(v.intro.index + 1, v.intro.order.length)} / ${v.intro.order.length}번째`;
  else sub = `나는 ${v.me.alias}`;
  $('#phase-sub').textContent = sub;

  const vb = $('#voice-badge');
  if (v.voice?.publish && v.phase === 'selfIntro') vb.textContent = '🎙 내 차례 · 송출 중(모의)';
  else if (v.voice?.publish) vb.textContent = `🎙 음성 연결(모의) · ${v.voice.subscribe.length}명`;
  else if (v.voice?.subscribe.length) vb.textContent = `🔈 ${v.voice.subscribe.map(name).join(', ')} 듣는 중(모의)`;
  else vb.textContent = '';
  vb.classList.toggle('on', !!v.voice?.publish);
}

function endsAt() {
  const v = st.view;
  if (!v) return null;
  if (v.phase === 'selfIntro' && v.intro) return v.intro.gapUntil ?? v.intro.speakerEndsAt;
  if (v.phase === 'date2Pick' && v.pick?.currentPicker) return v.pick.turnEndsAt;
  return v.phaseEndsAt;
}

setInterval(() => {
  if (!st.view) return;
  const e = endsAt();
  if (e == null) return ($('#timer').textContent = '--:--');
  // 배속 상태에서는 실제 남은 시간을 표시
  const left = Math.max(0, e - serverNow());
  const s = Math.ceil(left / 1000);
  $('#timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  if (st.view.phase === 'minigame') renderMinigameTick();
}, 200);

function pcard(p, { sel = false, off = false, tag = '' } = {}) {
  return `<div class="pcard${sel ? ' sel' : ''}${off ? ' off' : ''}" data-pid="${p.id}">${tag ? `<span class="tag">${esc(tag)}</span>` : ''}<img src="${esc(p.photoUrl)}" alt="${esc(p.alias)} 프로필 사진" loading="lazy" /><div>${esc(p.alias)}</div></div>`;
}

function renderPanel() {
  const v = st.view;
  const el = $('#panel');
  const stage = $('#intro-stage');
  stage.hidden = true;
  const opp = v.participants.filter((p) => p.gender !== v.me.gender);
  let h = '';

  switch (v.phase) {
    case 'intro':
      h = `<div class="box"><h3>나는 이번 회차 '${esc(v.me.alias)}'</h3>
        <p>첫인상 선택은 <b>${G[v.voterGender]}</b>가 해. 사진·가명·캐릭터만 보여 (나이·직업·사는 곳은 자기소개 후 공개).</p>
        <p class="muted">데이트 ${v.settings.dateRounds}회 진행 · 음성은 자기소개와 데이트에서만.</p></div>`;
      break;
    case 'firstVote': {
      const vt = v.vote;
      if (!vt.canVote) {
        h = `<div class="box"><h3>${G[v.voterGender]}가 첫인상 선택 중</h3><p>${vt.submitted}/${vt.total}명 완료. 누가 누구를 골랐는지는 공개하지 않아.</p></div>`;
      } else if (vt.myVote !== undefined) {
        h = `<div class="box"><h3>선택 완료</h3><p>${vt.myVote ? `${esc(name(vt.myVote))}를 선택했어.` : '기권했어.'} 집계 중… (${vt.submitted}/${vt.total})</p></div>`;
      } else {
        h = `<div class="box"><h3>첫인상으로 한 명을 골라 줘</h3><div class="grid">${opp.map((p) => pcard(p, { sel: st.selected === p.id })).join('')}</div>
          <div class="row"><button class="btn primary" id="btn-submit" ${st.selected ? '' : 'disabled'}>선택 확정</button>${v.settings.allowAbstain ? '<button class="btn" id="btn-abstain">기권</button>' : ''}</div></div>`;
      }
      break;
    }
    case 'date1':
    case 'date2':
    case 'date3':
      if (v.myDate) {
        const others = v.myDate.members.filter((x) => x !== v.me.id);
        h = `<div class="box"><h3>${PHASE_NAMES[v.phase]} · ${others.length + 1}명</h3><div class="grid">${others.map((id) => pcard(P(id))).join('')}</div>
          <p class="muted">같은 그룹끼리만 음성이 연결돼. (현재 모의 구현: 실제 소리는 나지 않아)</p></div>`;
      } else {
        h = `<div class="box"><h3>이번엔 숙소에서 쉬어</h3><p>데이트 그룹 ${v.dateSummary?.groups ?? 0}개가 진행 중이야. ${CHANNEL_NAMES[`dorm_${v.me.gender}`]} 사람들과 텍스트로 대화할 수 있어.</p></div>`;
      }
      break;
    case 'freeRoam':
      h = `<div class="box"><h3>자유 구경</h3><p>바닥을 누르면 이동해. 캐릭터를 누르면 프로필을 볼 수 있어. 대화는 텍스트로.</p></div>`;
      break;
    case 'selfIntro':
      h = renderIntro(stage);
      break;
    case 'minigame':
      h = `<div class="box" id="mg"></div>`;
      break;
    case 'date2Pick':
      h = renderPick();
      break;
    case 'randomAssign':
      h = `<div class="box"><h3>랜덤 데이트 배정</h3>${v.upcomingDate ? `<p>다음 데이트 상대:</p><div class="grid">${v.upcomingDate.members.filter((x) => x !== v.me.id).map((id) => pcard(P(id))).join('')}</div>` : '<p>배정 없음</p>'}<p class="muted">가능하면 앞에서 만나지 않은 상대로 배정했어.</p></div>`;
      break;
    case 'finalChoice': {
      const f = v.final;
      if (f.myChoice !== undefined) h = `<div class="box"><h3>최종 선택 완료</h3><p>${f.myChoice ? `${esc(name(f.myChoice))}를 선택했어.` : '선택하지 않았어.'} 서로 선택하면 커플 성사!</p></div>`;
      else h = `<div class="box"><h3>마지막 선택</h3><p>서로 고르면 매치돼.</p><div class="grid">${opp.map((p) => pcard(p, { sel: st.selected === p.id })).join('')}</div>
        <div class="row"><button class="btn primary" id="btn-final" ${st.selected ? '' : 'disabled'}>최종 선택</button><button class="btn" id="btn-final-none">선택 안 함</button></div></div>`;
      break;
    }
    case 'result':
    case 'contact':
    case 'ended': {
      const r = v.result;
      h = `<div class="box"><h3>${r.matchedWith ? `💞 ${esc(name(r.matchedWith))}와(과) 커플 성사!` : '이번엔 매치가 없었어'}</h3>
        <p>내 선택: ${r.myChoice ? esc(name(r.myChoice)) : '없음'} · 이번 회차 커플 ${r.couplesCount}쌍</p>
        ${r.matchedWith ? `<div class="grid">${pcard(P(r.matchedWith))}</div>` : ''}
        ${renderContact()}
        ${v.phase === 'ended' ? '<button class="btn" id="btn-leave">대기 화면으로</button>' : ''}</div>`;
      break;
    }
    default:
      h = '';
  }
  el.innerHTML = h;
  bindPanel();
}

function renderIntro(stage) {
  const v = st.view;
  const it = v.intro;
  if (!it) return '';
  if (it.speakerId) {
    const sp = P(it.speakerId);
    const facts = sp.revealed ? `${sp.age}세 · ${esc(sp.job)} · ${esc(sp.region)}` : '소개가 끝나면 정보가 공개돼';
    stage.innerHTML = `<img src="${esc(sp.photoUrl)}" alt="${esc(sp.alias)} 프로필 사진" /><div><div class="who">🎙 ${esc(sp.alias)}</div><div class="facts">${facts}</div></div>
      <div class="order">${it.index + 1}/${it.order.length}<br/>다음: ${it.order[it.index + 1] ? esc(name(it.order[it.index + 1])) : '-'}</div>`;
    stage.hidden = false;
  }
  if (it.speakerId === v.me.id) {
    return `<div class="box"><h3>내 자기소개 차례야</h3><p>지금은 나만 말할 수 있어 (음성은 모의). 다른 사람들은 듣고 텍스트로 질문할 수 있어.</p>
      <p class="muted">예시: 하는 일, 사는 동네, 주말에 하는 것, 이상형</p><button class="btn primary" id="btn-intro-done">소개 마치기</button></div>`;
  }
  if (!it.speakerId) return `<div class="box"><h3>다음 발표자 준비 중…</h3></div>`;
  return `<div class="box"><p>${esc(name(it.speakerId))}의 소개를 듣는 중. 궁금한 건 아래 채팅으로 질문해 줘.</p></div>`;
}

function renderPick() {
  const v = st.view;
  const pk = v.pick;
  const rank = pk.ranking.map((r) => `<li>${esc(name(r.pid))} <span class="muted">${r.totalMs}ms</span>${pk.pickers.includes(r.pid) ? ' 🎟' : ''}</li>`).join('');
  const picks = Object.entries(pk.picks).map(([a, b]) => `<span class="pill">${esc(name(a))} → ${b ? esc(name(b)) : '없음'}</span>`).join('');
  let h = `<div class="box"><h3>${pk.mode === 'tickets' ? `데이트권 ${pk.pickers.length}장` : '지목 순서'}</h3><ol class="rank">${rank}</ol><div>${picks}</div>`;
  if (pk.currentPicker === v.me.id) {
    const opp = v.participants.filter((p) => p.gender !== v.me.gender);
    h += `<h3 style="margin-top:10px">내 차례! 데이트할 상대를 골라 줘</h3><div class="grid">${opp.map((p) => pcard(p, { sel: st.selected === p.id, off: !pk.options.includes(p.id) })).join('')}</div>
      <button class="btn primary" id="btn-pick" ${st.selected ? '' : 'disabled'}>지목</button>`;
  } else if (pk.currentPicker) {
    h += `<p>${esc(name(pk.currentPicker))}가 상대를 고르는 중…</p>`;
  } else {
    h += '<p>지목 완료. 곧 2차 데이트가 시작돼.</p>';
  }
  return h + '</div>';
}

function renderContact() {
  const v = st.view;
  if (!v.settings.contactExchange || !v.result?.matchedWith) return '';
  const c = v.contact;
  if (!c) return '';
  if (c.status === 'shared') return `<p>상대 연락처: <b>${esc(c.partnerContact)}</b></p>`;
  if (c.status === 'notShared') return '<p class="muted">두 사람 모두 동의하지 않아 연락처는 공개되지 않았어.</p>';
  if (c.responded) return '<p class="muted">상대의 응답을 기다리는 중…</p>';
  if (v.phase !== 'contact') return '';
  return `<p>연락처를 교환할까? 두 사람 모두 동의해야만 서로에게 보여.</p>
    <input id="contact-input" maxlength="60" placeholder="공유할 연락 수단 (예: 오픈채팅 링크)" style="width:100%;padding:10px;border-radius:12px;border:1px solid var(--line);font-size:16px" />
    <div class="row"><button class="btn primary" id="btn-contact-yes">동의하고 공유</button><button class="btn" id="btn-contact-no">공유 안 함</button></div>`;
}

let mgState = '';
function renderMinigameTick() {
  const v = st.view;
  const box = $('#mg');
  if (!box) return;
  const m = v.minigame;
  if (!m) return;
  let key;
  let h;
  if (m.ranking) {
    key = 'rank';
    h = `<h3>미니게임 결과</h3><ol class="rank">${m.ranking.map((r) => `<li>${esc(name(r.pid))} <span class="muted">${r.totalMs}ms</span></li>`).join('')}</ol>`;
  } else if (!m.playing) {
    key = 'watch';
    h = `<h3>${G[v.ticketGender]}들이 데이트권을 걸고 게임 중</h3><p>숙소 채팅으로 대화하면서 기다려 줘.</p>`;
  } else {
    const tapped = m.myTap;
    const go = m.goAt != null;
    key = `r${m.round}-${go}-${!!tapped}`;
    const zone = tapped
      ? `<div class="tapzone done">${tapped.falseStart ? '너무 빨랐어! (벌점)' : `${tapped.ms}ms`}<br/>다음 라운드 대기</div>`
      : go
        ? '<div class="tapzone go" id="tapzone">지금 눌러!</div>'
        : '<div class="tapzone wait" id="tapzone">초록색이 되면 눌러…</div>';
    h = `<h3>반응 속도 게임 · ${m.round + 1}/${m.rounds} 라운드</h3><p class="muted">합산 기록이 빠른 순서로 데이트권/지목 순서가 정해져.</p>${zone}
      <p class="small">${m.myTaps.map((t, i) => `R${i + 1}: ${t ? `${t.ms}ms` : '-'}`).join(' · ')}</p>`;
  }
  if (key === mgState && box.innerHTML) return;
  mgState = key;
  box.innerHTML = h;
  const tz = $('#tapzone');
  if (tz) tz.addEventListener('pointerdown', () => {
    const goAt = st.view.minigame.goAt;
    const reaction = goAt != null ? serverNow() - goAt : -1;
    act({ type: 'tap', reactionMs: Math.round(reaction) });
  }, { once: true });
}

function bindPanel() {
  const v = st.view;
  mgState = '';
  if (v.phase === 'minigame') renderMinigameTick();
  for (const c of document.querySelectorAll('#panel .pcard')) {
    c.addEventListener('click', () => {
      const selectable = ['firstVote', 'finalChoice', 'date2Pick'].includes(v.phase) && c.closest('.grid').querySelectorAll('.pcard').length > 1;
      if (selectable) {
        st.selected = c.dataset.pid;
        renderPanel();
      } else openProfile(c.dataset.pid);
    });
  }
  $('#btn-submit')?.addEventListener('click', () => act({ type: 'vote', target: st.selected }));
  $('#btn-abstain')?.addEventListener('click', () => act({ type: 'vote', target: null }));
  $('#btn-intro-done')?.addEventListener('click', () => act({ type: 'introDone' }));
  $('#btn-pick')?.addEventListener('click', () => act({ type: 'pick', target: st.selected }));
  $('#btn-final')?.addEventListener('click', () => act({ type: 'final', target: st.selected }));
  $('#btn-final-none')?.addEventListener('click', () => act({ type: 'final', target: null }));
  $('#btn-contact-yes')?.addEventListener('click', () => act({ type: 'contact', consent: true, contact: $('#contact-input').value }));
  $('#btn-contact-no')?.addEventListener('click', () => act({ type: 'contact', consent: false }));
  $('#btn-leave')?.addEventListener('click', () => {
    sendWs({ t: 'leaveResult' });
    st.view = null;
    st.lastPhase = null;
  });
}

function openProfile(pid) {
  const p = P(pid);
  if (!p) return;
  const card = $('#profile-card');
  card.dataset.pid = pid;
  const facts = p.revealed
    ? `<dl><dt>나이</dt><dd>${p.age}세</dd><dt>직업</dt><dd>${esc(p.job)}</dd><dt>사는 곳</dt><dd>${esc(p.region)}</dd></dl>`
    : '<p class="muted small">나이·직업·사는 곳은 자기소개 후 공개돼.</p>';
  card.innerHTML = `<div class="top"><img src="${esc(p.photoUrl)}" alt="${esc(p.alias)} 프로필 사진" /><div><div class="strong">${esc(p.alias)}${p.id === st.view.me.id ? ' (나)' : ''}</div><div class="muted small">${G[p.gender]}${p.connected ? '' : ' · 연결 끊김'}</div></div>
    <button class="btn small" style="margin-left:auto" id="btn-close-card">닫기</button></div>${facts}`;
  card.hidden = false;
  $('#btn-close-card').onclick = () => (card.hidden = true);
}

function tapFloor(x, z) {
  if (st.view?.phase === 'freeRoam') act({ type: 'move', x, z });
  $('#profile-card').hidden = true;
}

// ───────────── 채팅 (텍스트) ─────────────
function chName(ch) {
  if (ch.startsWith('date:')) return '데이트';
  return CHANNEL_NAMES[ch] ?? ch;
}
function addChat(msg, quiet = false) {
  if (!st.chat.has(msg.channel)) st.chat.set(msg.channel, []);
  const list = st.chat.get(msg.channel);
  if (list.some((x) => x.id === msg.id)) return;
  list.push(msg);
  if (list.length > 100) list.shift();
  if (msg.channel === st.channel) renderChatLog();
  void quiet;
}
function renderChatTabs() {
  const chs = st.view.channels;
  if (!chs.includes(st.channel)) st.channel = chs[0] ?? null;
  $('#chat-tabs').innerHTML = chs.map((c) => `<button data-ch="${esc(c)}" class="${c === st.channel ? 'on' : ''}">${esc(chName(c))}</button>`).join('');
  for (const b of document.querySelectorAll('#chat-tabs button')) b.onclick = () => {
    st.channel = b.dataset.ch;
    renderChatTabs();
  };
  $('#chat-input').disabled = !st.channel;
  renderChatLog();
}
function renderChatLog() {
  const log = $('#chat-log');
  const list = st.chat.get(st.channel) ?? [];
  log.innerHTML = list.length
    ? list.map((m) => `<div class="m"><b>${esc(name(m.from))}</b>${esc(m.text)}</div>`).join('')
    : '<div class="m sys">음성은 자기소개·데이트에서만. 여기는 텍스트 대화야.</div>';
  log.scrollTop = log.scrollHeight;
}
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const i = $('#chat-input');
  if (!i.value.trim() || !st.channel) return;
  act({ type: 'chat', channel: st.channel, text: i.value });
  i.value = '';
});

let toastTimer;
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ───────────── PWA ─────────────
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        // 진행 중인 게임을 강제로 새로고침하지 않는다. 다음 실행 때 적용.
        if (nw.state === 'installed' && navigator.serviceWorker.controller) $('#update-bar').hidden = false;
      });
    });
  }).catch(() => {});
}

function setupInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return;
  const box = $('#install-box');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) {
    box.hidden = false;
    $('#install-text').textContent = 'Safari 아래쪽 공유 버튼(□↑) → "홈 화면에 추가"를 누르면 아이콘이 생겨. ("웹 앱으로 열기" 옵션이 보이면 켜 줘)';
  } else {
    box.hidden = false;
    $('#install-text').textContent = '브라우저 메뉴(⋮) → "홈 화면에 추가" 또는 "앱 설치"를 누르면 아이콘이 생겨. 설치 안 해도 웹에서 그대로 할 수 있어.';
  }
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    st.installEvt = e;
    $('#btn-install').hidden = false;
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!st.installEvt) return;
    st.installEvt.prompt();
    await st.installEvt.userChoice;
    st.installEvt = null;
    $('#btn-install').hidden = true;
  });
  addEventListener('appinstalled', () => (box.hidden = true));
}

boot();
