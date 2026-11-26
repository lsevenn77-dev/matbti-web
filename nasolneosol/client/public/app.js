// 나솔너솔 클라이언트: 화면 전환 · 서버 통신 · 단계별 UI
import { GameScene, zoneLabel, timeOfPhase, timeLabel } from './scene.js?v=23';
import { AudioDirector } from './audio.js?v=23';

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
  document.body.dataset.screen = id; // 상단 바·배경 표시 여부를 CSS 가 정한다
  closeModals();
}

// ───────────── 시작 ─────────────
async function boot() {
  registerSW();
  setupInstall();
  st.info = await fetch('/api/info').then((r) => r.json()).catch(() => null);
  initSocial();
  // 카카오 로그인·결제에서 돌아온 경우
  const qs = new URLSearchParams(location.search);
  if (qs.has('auth') || qs.has('pay')) history.replaceState(null, '', '/');
  if (qs.has('auth')) {
    const r = await fetch('/api/auth/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: qs.get('auth') }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (await handleAuth(r?.ok, j)) return;
  }
  if (qs.has('pay')) st.payResult = qs.get('pay');
  if (st.token) {
    const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${st.token}` } }).catch(() => null);
    if (r?.ok) {
      st.me = await r.json();
      connect();
      return;
    }
    if (r && r.status === 401) safeSet('nsns_token', null);
  }
  showStart();
}

// ───────────── 시작 (로그인 전) ─────────────
function showStart() {
  show('screen-start');
  const a = st.info?.auth;
  const anyLogin = !!(a && (a.google || a.kakao || a.apple));
  // 간편 로그인이 없거나 개발 모드면 로그인 없이 바로 프로필을 만들 수 있다
  $('#btn-guest').hidden = anyLogin && !st.info?.devTools;
}
$('#btn-guest').addEventListener('click', () => showSignup());

// ───────────── 가입 ─────────────
let photoData = null;
function showSignup(editing = false) {
  show('screen-signup');
  const f = $('#signup-form');
  f.dataset.editing = editing ? '1' : '';
  $('#pf-title').textContent = editing ? '프로필 수정' : '프로필 만들기';
  f.querySelector('button[type=submit]').textContent = editing ? '저장' : '시작하기';
  $('#pf-ok').hidden = !st.signupTicket || editing;
  if (editing && st.me) {
    f.age.value = st.me.profile.age;
    f.job.value = st.me.profile.job;
    f.region.value = st.me.profile.region;
    f.ageUp.value = st.me.profile.ageUp ?? 40;
    f.ageDown.value = st.me.profile.ageDown ?? 40;
    for (const r of f.gender) r.checked = r.value === st.me.profile.gender;
    $('#photo-preview').src = st.me.profile.photoUrl;
    $('#photo-preview').hidden = false;
    $('#photo-hint').hidden = true;
  }
  if (st.info) f.age.min = st.info.minAge;
  if (!editing) restoreDraft();
}

// 가입 입력 임시 저장: 사진 고르는 사이 폰 브라우저가 페이지를 다시 불러와도 입력이 남게
const DRAFT_KEY = 'nsns_signup_draft';
function saveDraft() {
  const f = $('#signup-form');
  if (f.dataset.editing === '1') return;
  const d = { gender: f.gender.value, age: f.age.value, job: f.job.value, region: f.region.value, ageUp: f.ageUp.value, ageDown: f.ageDown.value, photo: photoData };
  // localStorage: 폰이 사진 앱을 여는 동안 브라우저를 아예 종료해도 남는다
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, photo: null })); } catch {}
  }
}
function restoreDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch {}
  if (!d) return;
  const f = $('#signup-form');
  for (const r of f.gender) r.checked = r.value === d.gender;
  if (d.age) f.age.value = d.age;
  if (d.job) f.job.value = d.job;
  if (d.region) f.region.value = d.region;
  if (d.ageUp !== undefined && d.ageUp !== '') f.ageUp.value = d.ageUp;
  if (d.ageDown !== undefined && d.ageDown !== '') f.ageDown.value = d.ageDown;
  if (d.photo) {
    photoData = d.photo;
    $('#photo-preview').src = d.photo;
    $('#photo-preview').hidden = false;
    $('#photo-hint').hidden = true;
  }
}
$('#btn-signup-back').addEventListener('click', () => {
  if ($('#signup-form').dataset.editing === '1' && st.me) showLobby();
  else showStart();
});
$('#signup-form').addEventListener('input', saveDraft);
$('#signup-form').addEventListener('change', saveDraft);

$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  photoData = await resizePhoto(file, 360);
  $('#photo-preview').src = photoData;
  $('#photo-preview').hidden = false;
  $('#photo-hint').hidden = true;
  saveDraft();
});

async function resizePhoto(file, max) {
  // 큰 폰 사진을 원본 크기로 펼치면 메모리가 부족해 페이지가 죽을 수 있어, 가능하면 줄이면서 읽는다
  let img;
  try {
    const probe = await createImageBitmap(file, { resizeWidth: 1024, resizeQuality: 'medium' });
    img = probe;
  } catch {
    img = await new Promise((ok, bad) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = bad;
      im.src = URL.createObjectURL(file);
    });
  }
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
  const body = { gender: f.gender.value, age: Number(f.age.value), job: f.job.value, region: f.region.value, ageUp: Number(f.ageUp.value), ageDown: Number(f.ageDown.value) };
  if (st.signupTicket && !editing) body.signupTicket = st.signupTicket;
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
    st.signupTicket = null;
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
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
  audio.update(null); // 대기 화면 음악
  // 가입 중에 미뤄 둔 새 버전은 대기 화면에서 적용
  if (st.pendingUpdate?.waiting && !st.view) {
    st.pendingUpdate.waiting.postMessage('skipWaiting');
    st.pendingUpdate = null;
  }
  $('#lobby-photo').src = st.me.profile.photoUrl;
  const p = st.me.profile;
  const range = p.ageUp == null || (p.ageUp >= 40 && p.ageDown >= 40) ? '나이 상관없음' : `${Math.max(19, p.age - (p.ageDown ?? 40))}~${p.age + (p.ageUp ?? 40)}세와 매칭`;
  $('#lobby-name').textContent = `${G[p.gender]} · ${p.age}세`;
  $('#lobby-me').textContent = `${p.job} · ${p.region} · ${range}`;
  $('#btn-edit-2').hidden = false;
  if (status) {
    $('#q-male').textContent = status.male;
    $('#q-female').textContent = status.female;
    $('#q-male-need').textContent = status.need.male;
    $('#q-female-need').textContent = status.need.female;
    $('#btn-queue').innerHTML = status.inQueue ? '<span aria-hidden="true">⏳</span> 대기 취소' : '<span aria-hidden="true">🎮</span> 게임 입장';
    $('#btn-queue').dataset.in = status.inQueue ? '1' : '';
    $('#btn-queue').classList.toggle('waiting', !!status.inQueue);
    const mine = p.gender;
    const need = status.need[mine] - status[mine];
    if (status.inQueue) {
      // 내 나이 조건과 서로 맞는 사람 기준으로 남은 인원
      const more = status.more ?? { male: status.need.male - status.male, female: status.need.female - status.female };
      const parts = [more.male > 0 ? `남자 ${more.male}명` : '', more.female > 0 ? `여자 ${more.female}명` : ''].filter(Boolean);
      const others = status.total ? status.total.male + status.total.female - status.male - status.female : 0;
      $('#queue-msg').textContent = parts.length
        ? `대기 중이야. ${parts.join(', ')} 더 오면 시작해.${others > 0 ? ` (나이 조건이 안 맞는 대기자 ${others}명은 다른 방)` : ''}`
        : '곧 시작해!';
    } else {
      $('#queue-msg').textContent = need <= 0 ? `${G[mine]} 자리는 다 찼어. 대기하면 다음 방에 들어가.` : '12명이 모이면 바로 시작해. (선착순 · 나이 조건이 서로 맞는 사람끼리)';
    }
  }
  renderWallet();
  renderAccount();
  renderParty();
  if (status?.inQueue && st.party.party) $('#queue-msg').textContent += ' 👥 친구와 함께 대기 중';
  refreshSocialSoon();
  // 입장권은 방이 시작될 때 줄어드니 대기 화면에 올 때마다 새로 받아 온다
  if (!st.meFetchedAt || Date.now() - st.meFetchedAt > 5000) {
    st.meFetchedAt = Date.now();
    fetch('/api/me', { headers: authHeaders() }).then((r) => (r.ok ? r.json() : null)).then((me) => {
      if (!me) return;
      st.me = me;
      renderWallet();
      renderAccount();
    }).catch(() => {});
  }
  if (st.payResult) {
    const r = st.payResult;
    st.payResult = null;
    $('#shop-note').textContent = r === 'ok' ? '✅ 결제 완료! 입장권이 들어왔어.' : r === 'cancel' ? '결제를 취소했어.' : '결제에 실패했어. 잠시 뒤 다시 시도해 줘.';
  }
  $('#btn-bots').hidden = !st.info?.devTools;
  if (st.info) {
    $('#lobby-info').textContent = `이번 설정: 데이트 ${st.info.dateRounds}회 · 예상 약 ${Math.round(st.info.estimateMinutes)}분${st.info.timeScale !== 1 ? ` (개발 배속 ×${st.info.timeScale})` : ''} · 음성: 모의 구현`;
  }
}
$('#btn-edit').addEventListener('click', () => showSignup(true));
$('#btn-edit-2').addEventListener('click', () => showSignup(true));

// 상단 바: 게임 안내·설정 창
function closeModals() {
  for (const m of document.querySelectorAll('.modal')) m.hidden = true;
  for (const b of document.querySelectorAll('#tb-nav button')) b.classList.toggle('on', b.dataset.tab === 'lobby');
}
function openModal(id) {
  closeModals();
  $(id).hidden = false;
}
for (const m of document.querySelectorAll('.modal')) {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) closeModals();
  });
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModals();
});
for (const b of document.querySelectorAll('#tb-nav button')) {
  b.addEventListener('click', () => {
    const tab = b.dataset.tab;
    if (tab === 'lobby') return closeModals();
    if (tab === 'guide') openModal('#modal-guide');
    else openSocial(tab);
    for (const x of document.querySelectorAll('#tb-nav button')) x.classList.toggle('on', x === b);
  });
}
$('#btn-settings').addEventListener('click', () => openModal('#modal-settings'));

// ───────────── 친구 · 나의 인연 · 메시지 ─────────────
// 규칙(서버와 같음): 친구 신청은 같은 게임에서 만난 사람에게만, 메시지는 친구이거나 최종 매칭된 상대끼리만
const soc = { data: null, mode: 'friends', sub: 'list', dmWith: null, timer: null, loading: null };
const GS = { male: '♂', female: '♀' };
function ago(at) {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
function dateLabel(at) {
  return new Date(at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
}
function presence(c) {
  if (c.isBot) return '<span class="st off">봇 (시험용)</span>';
  if (c.inGame) return '<span class="st game">게임 중</span>';
  return c.online ? '<span class="st on">온라인</span>' : '<span class="st off">오프라인</span>';
}
function personRow(c, actions = '', sub = '') {
  return `<div class="person" data-id="${esc(c.id)}">
    <img src="${esc(c.photoUrl)}" alt="" loading="lazy" />
    <div class="p-text"><div class="p-name">${esc(c.alias || '이름 없음')} <span class="g ${c.gender}">${GS[c.gender] ?? ''}</span> <span class="p-age">${c.age}세</span></div>${sub || presence(c)}</div>
    <div class="p-acts">${actions}</div>
  </div>`;
}
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : { error: '연결이 끊겼어' };
  if (!r?.ok) throw new Error(j.error || '실패했어');
  return j;
}
async function loadSocial() {
  if (!st.token) return null;
  soc.loading ??= api('/api/social').then((d) => {
    soc.data = d;
    renderSocialBadges();
    renderFriendsCard();
    if (!$('#modal-social').hidden && $('#dm').hidden) renderSocial();
    return d;
  }).catch(() => null).finally(() => (soc.loading = null));
  return soc.loading;
}
let socialRefresh = null;
function refreshSocialSoon() {
  clearTimeout(socialRefresh);
  socialRefresh = setTimeout(loadSocial, 250);
}
function renderSocialBadges() {
  const d = soc.data;
  const set = (el, n) => { el.hidden = !n; el.textContent = n > 9 ? '9+' : n || ''; };
  set($('#badge-friends'), d?.incoming.length ?? 0);
  set($('#badge-msgs'), d?.unread ?? 0);
}
function renderFriendsCard() {
  const d = soc.data;
  if (!d) return;
  $('#fc-count').textContent = `${d.friends.length}명`;
  $('#fc-list').innerHTML = d.friends.length
    ? d.friends.slice(0, 6).map((c) => personRow(c, `<button type="button" class="ic" data-act="chat" aria-label="대화하기">💬</button>`)).join('')
    : `<p class="empty">아직 친구가 없어. 게임에서 만난 사람에게 친구 신청을 해 봐.</p>`;
  bindPeople($('#fc-list'));
}
$('#btn-friend-add').addEventListener('click', () => openSocial('friends', 'met'));

function openSocial(mode, sub) {
  soc.mode = mode;
  soc.sub = sub ?? (mode === 'friends' ? (soc.data?.incoming.length ? 'incoming' : 'list') : 'list');
  openModal('#modal-social');
  for (const x of document.querySelectorAll('#tb-nav button')) x.classList.toggle('on', x.dataset.tab === mode);
  closeDm();
  renderSocial();
  loadSocial();
  clearInterval(soc.timer);
  soc.timer = setInterval(() => (!$('#modal-social').hidden ? loadSocial() : clearInterval(soc.timer)), 20000);
}

function renderSocial() {
  const d = soc.data;
  const titles = { friends: '👥 친구', matches: '💗 나의 인연', messages: '💬 메시지' };
  $('#soc-title').textContent = titles[soc.mode];
  const tabs = soc.mode === 'friends'
    ? [['list', `친구 목록${d ? ` ${d.friends.length}` : ''}`], ['incoming', `받은 신청${d?.incoming.length ? ` ${d.incoming.length}` : ''}`], ['met', '함께한 사람']]
    : [];
  $('#soc-tabs').innerHTML = tabs.map(([k, l]) => `<button type="button" data-sub="${k}" class="${soc.sub === k ? 'on' : ''}">${esc(l)}</button>`).join('');
  $('#soc-tabs').hidden = !tabs.length;
  for (const b of document.querySelectorAll('#soc-tabs button')) b.onclick = () => { soc.sub = b.dataset.sub; renderSocial(); };
  const body = $('#soc-body');
  if (!d) return (body.innerHTML = '<p class="empty">불러오는 중…</p>');
  let html = '';
  if (soc.mode === 'friends' && soc.sub === 'list') {
    html = d.friends.length
      ? d.friends.map((c) => personRow(c, `<button type="button" class="ic" data-act="chat" aria-label="대화하기">💬</button>`)).join('')
      : '<p class="empty">아직 친구가 없어.<br>"함께한 사람"에서 게임에서 만난 사람에게 친구 신청을 할 수 있어.</p>';
  } else if (soc.mode === 'friends' && soc.sub === 'incoming') {
    html = d.incoming.length
      ? d.incoming.map((c) => personRow(c, `<button type="button" class="pill-btn pk" data-act="accept">수락</button><button type="button" class="pill-btn" data-act="decline">거절</button>`, `<span class="st">${ago(c.at)} 신청</span>`)).join('')
      : '<p class="empty">받은 친구 신청이 없어.</p>';
  } else if (soc.mode === 'friends' && soc.sub === 'met') {
    html = d.met.length
      ? `<p class="hint">같은 게임에서 만난 사람에게만 친구 신청을 할 수 있어.</p>` + d.met.map((c) => personRow(c,
        c.friend ? '<span class="tag">친구</span>' : c.requested ? '<button type="button" class="pill-btn" data-act="cancel">신청 취소</button>' : '<button type="button" class="pill-btn pk" data-act="request">친구 신청</button>',
        `<span class="st">${dateLabel(c.at)} 함께함</span>`)).join('')
      : '<p class="empty">아직 함께한 사람이 없어. 게임을 한 판 하면 여기에 나와.</p>';
  } else if (soc.mode === 'matches') {
    html = `<p class="hint">서로를 최종 선택한 상대야. 게임 밖 1:1 대화에서 원할 때 연락처를 나눌 수 있어.</p>` + (d.matches.length
      ? d.matches.map((c) => personRow(c, `<button type="button" class="pill-btn pk" data-act="chat">대화하기</button>`, `<span class="tag pk">매칭 성공 💗</span> <span class="st">${dateLabel(c.at)} 게임</span>`)).join('')
      : '<p class="empty">아직 매칭된 인연이 없어. 최종 선택에서 서로를 고르면 여기에 나와.</p>');
  } else if (soc.mode === 'messages') {
    html = d.threads.length
      ? d.threads.map((c) => personRow(c, c.unread ? `<i class="badge on">${c.unread}</i>` : '', `<span class="last">${c.last.mine ? '나: ' : ''}${esc(c.last.text)}</span> <span class="st">· ${ago(c.last.at)}</span>`)).join('')
      : '<p class="empty">아직 대화가 없어. 친구나 매칭된 상대에게 먼저 말을 걸어 봐.</p>';
  }
  body.innerHTML = html;
  bindPeople(body, soc.mode === 'messages');
}

function bindPeople(root, rowOpensChat = false) {
  for (const row of root.querySelectorAll('.person')) {
    const id = row.dataset.id;
    if (rowOpensChat) row.onclick = () => openDm(id);
    for (const b of row.querySelectorAll('[data-act]')) {
      b.onclick = async (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'chat') {
          if ($('#modal-social').hidden) openSocial('messages');
          return openDm(id);
        }
        b.disabled = true;
        try {
          if (act === 'request') {
            const r = await api('/api/friends/request', { userId: id });
            toastLobby(r.status === 'friends' ? '서로 신청해서 바로 친구가 됐어!' : '친구 신청을 보냈어');
          }
          if (act === 'cancel') await api('/api/friends/cancel', { userId: id });
          if (act === 'accept') { await api('/api/friends/respond', { userId: id, accept: true }); toastLobby('친구가 됐어!'); }
          if (act === 'decline') await api('/api/friends/respond', { userId: id, accept: false });
        } catch (err) {
          toastLobby(err.message);
        }
        await loadSocial();
        renderSocial();
      };
    }
  }
}

async function openDm(id) {
  soc.dmWith = id;
  $('#soc-tabs').hidden = true;
  $('#soc-body').hidden = true;
  $('#dm').hidden = false;
  $('#dm-menu').hidden = true;
  $('#dm-log').innerHTML = '<p class="empty">불러오는 중…</p>';
  try {
    const j = await api(`/api/messages?with=${encodeURIComponent(id)}`);
    if (soc.dmWith !== id) return;
    const c = j.peer;
    $('#dm-photo').src = c.photoUrl;
    $('#dm-name').textContent = `${c.alias || '이름 없음'} · ${c.age}세`;
    $('#dm-state').innerHTML = `${j.matched ? '💗 매칭 · ' : j.friend ? '친구 · ' : ''}${presence(c)}`;
    $('#dm-unfriend').hidden = !j.friend;
    $('#dm-form').hidden = !j.canMessage;
    $('#dm-note').textContent = j.canMessage ? '상대를 존중해 줘. 불쾌한 대화는 ⋯ 에서 차단할 수 있어.' : '친구이거나 최종 매칭된 상대에게만 메시지를 보낼 수 있어.';
    $('#dm-log').innerHTML = j.messages.length ? '' : '<p class="empty">첫 메시지를 보내 봐 👋</p>';
    for (const m of j.messages) appendDm(m);
    if (j.canMessage && matchMedia('(pointer: fine)').matches) $('#dm-input').focus();
    loadSocial(); // 읽음 처리 반영
  } catch (err) {
    $('#dm-log').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}
function appendDm(m) {
  const log = $('#dm-log');
  log.querySelector('.empty')?.remove();
  if (log.querySelector(`[data-mid="${m.id}"]`)) return;
  const el = document.createElement('div');
  el.className = `bubble ${m.mine ? 'me' : 'you'}`;
  el.dataset.mid = m.id;
  el.innerHTML = `<span class="txt"></span><time>${new Date(m.at).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}</time>`;
  el.querySelector('.txt').textContent = m.text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}
function closeDm() {
  soc.dmWith = null;
  $('#dm').hidden = true;
  $('#soc-body').hidden = false;
  $('#soc-tabs').hidden = soc.mode !== 'friends';
}
$('#dm-back').addEventListener('click', () => { closeDm(); renderSocial(); });
$('#dm-more').addEventListener('click', () => ($('#dm-menu').hidden = !$('#dm-menu').hidden));
$('#dm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#dm-input');
  const text = input.value.trim();
  if (!text || !soc.dmWith) return;
  try {
    const j = await api('/api/messages', { to: soc.dmWith, text });
    input.value = '';
    appendDm(j.message);
  } catch (err) {
    toastLobby(err.message);
  }
});
$('#dm-unfriend').addEventListener('click', async () => {
  if (!soc.dmWith || !confirm('친구를 끊을까? 다시 친구가 되려면 함께한 사람 목록에서 신청해야 해.')) return;
  await api('/api/friends/remove', { userId: soc.dmWith }).catch((err) => toastLobby(err.message));
  closeDm();
  await loadSocial();
  renderSocial();
});
$('#dm-block').addEventListener('click', async () => {
  if (!soc.dmWith || !confirm('이 사람을 차단할까? 서로 메시지와 친구 신청을 보낼 수 없게 되고 목록에서 사라져.')) return;
  await api('/api/block', { userId: soc.dmWith }).catch((err) => toastLobby(err.message));
  closeDm();
  await loadSocial();
  renderSocial();
  toastLobby('차단했어');
});
function onDm(m) {
  if (soc.dmWith === m.peer && !$('#modal-social').hidden && !$('#dm').hidden) {
    appendDm(m.message);
    if (!m.message.mine) api(`/api/messages?with=${encodeURIComponent(m.peer)}`).then(() => loadSocial()).catch(() => {}); // 읽음 처리
  } else {
    refreshSocialSoon();
    if (!m.message.mine && !st.view) toastLobby('💬 새 메시지가 왔어');
  }
}
// ───────────── 동반 입장 (같은 성별 친구, 본인 포함 2명) ─────────────
st.party = { party: null, invite: null, sent: [] };
function onParty(m) {
  st.party = { party: m.party, invite: m.invite, sent: m.sent ?? [] };
  renderParty();
}
function renderParty() {
  const { party, invite } = st.party;
  const bar = $('#party-bar');
  if (party) {
    const others = party.members.filter((x) => !x.me);
    bar.innerHTML = `<div class="party-on"><span class="pt-label">👥 함께 입장</span>${party.members.map((x) => `<img src="${esc(x.photoUrl)}" alt="" title="${esc(x.me ? '나' : x.alias)}" />`).join('')}<span class="pt-name">${others.map((x) => esc(x.alias || '친구')).join(', ')}${others.length ? '와 함께' : ''}</span><button type="button" class="pt-x" id="btn-party-leave" aria-label="함께 입장 해제">해제</button></div>`;
    $('#btn-party-leave').onclick = () => sendWs({ t: 'party.leave' });
  } else {
    bar.innerHTML = '<button type="button" class="party-btn" id="btn-party-open">👥 친구와 함께 입장</button>';
    $('#btn-party-open').onclick = openPartyPicker;
  }
  // 받은 초대
  const box = $('#party-invite');
  box.hidden = !invite || !!st.view;
  if (invite) {
    $('#pi-photo').src = invite.from.photoUrl;
    $('#pi-name').textContent = `${invite.from.alias || '친구'} · ${invite.from.age}세`;
    const tick = () => {
      const s = Math.max(0, Math.round((invite.until - Date.now()) / 1000));
      $('#pi-left').textContent = `${s}초 안에 응답해 줘`;
      if (s <= 0) box.hidden = true;
    };
    tick();
    clearInterval(renderParty.t);
    renderParty.t = setInterval(() => (box.hidden ? clearInterval(renderParty.t) : tick()), 1000);
  }
  if (!$('#modal-party').hidden) renderPartyPicker();
}
$('#pi-yes').addEventListener('click', () => { sendWs({ t: 'party.respond', accept: true }); $('#party-invite').hidden = true; });
$('#pi-no').addEventListener('click', () => { sendWs({ t: 'party.respond', accept: false }); $('#party-invite').hidden = true; });
$('#btn-party-open2').addEventListener('click', () => openPartyPicker());
async function openPartyPicker() {
  openModal('#modal-party');
  renderPartyPicker();
  await loadSocial();
  renderPartyPicker();
}
function renderPartyPicker() {
  const list = $('#party-pick');
  const d = soc.data;
  if (!d) return (list.innerHTML = '<p class="empty">불러오는 중…</p>');
  const myG = st.me?.profile.gender;
  const same = d.friends.filter((c) => c.gender === myG);
  const inParty = new Set((st.party.party?.members ?? []).map((x) => x.id));
  if (!same.length) {
    list.innerHTML = `<p class="empty">함께 입장할 수 있는 ${G[myG] ?? ''} 친구가 없어.<br>게임에서 만난 ${G[myG] ?? ''} 참가자에게 친구 신청을 해 봐.</p>`;
    return;
  }
  list.innerHTML = same.map((c) => {
    let act;
    if (inParty.has(c.id)) act = '<span class="tag pk">함께 입장 중</span>';
    else if (st.party.sent.includes(c.id)) act = '<span class="tag">초대 보냄</span>';
    else if (c.inGame) act = '<span class="tag">게임 중</span>';
    else if (!c.online) act = '<span class="tag">오프라인</span>';
    else act = '<button type="button" class="pill-btn pk" data-act="invite">초대</button>';
    return personRow(c, act);
  }).join('');
  for (const b of list.querySelectorAll('[data-act="invite"]')) {
    b.onclick = () => {
      b.disabled = true;
      sendWs({ t: 'party.invite', to: b.closest('.person').dataset.id });
      toastLobby('초대를 보냈어. 친구가 수락하면 함께 입장해.');
    };
  }
}

function toastLobby(text) {
  let el = $('#lobby-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lobby-toast';
    el.className = 'lobby-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}
$('#btn-queue').addEventListener('click', () => sendWs({ t: $('#btn-queue').dataset.in ? 'queue.leave' : 'queue.join' }));
$('#btn-bots').addEventListener('click', async () => {
  if (!$('#btn-queue').dataset.in) sendWs({ t: 'queue.join' });
  setTimeout(() => fetch('/api/dev/fill-bots', { method: 'POST' }), 300);
});

$('#btn-dev-fast').addEventListener('click', () => sendWs({ t: 'dev', op: 'speed', scale: st.view?.timeScale > 1 ? 1 : 10 }));
$('#btn-dev-skip').addEventListener('click', () => sendWs({ t: 'dev', op: 'skip' }));

// ───────────── 간편 로그인 (구글 · 카카오 · 애플) ─────────────
function loadScript(src) {
  return new Promise((ok, bad) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const el = document.createElement('script');
    el.src = src;
    el.onload = ok;
    el.onerror = bad;
    document.head.appendChild(el);
  });
}
function authHeaders() {
  return st.token ? { Authorization: `Bearer ${st.token}` } : {};
}
const PROVIDER = { google: '구글', kakao: '카카오', apple: 'Apple' };
/** 서버 응답 처리. 화면을 바꿨으면 true */
async function handleAuth(ok, j) {
  if (!ok) {
    const msg = j?.error || '로그인에 실패했어';
    if (st.me) $('#account-state').textContent = msg;
    else $('#social-msg').textContent = msg;
    return false;
  }
  if (j.token) {
    st.token = j.token;
    safeSet('nsns_token', j.token);
    st.me = j.me;
    if (j.linked) {
      renderAccount();
      $('#account-state').textContent = '연결됐어! 이제 다른 기기에서도 이 계정으로 들어올 수 있어.';
      return true;
    }
    connect();
    return true;
  }
  if (j.signupTicket) {
    st.signupTicket = j.signupTicket;
    showSignup();
    $('#pf-ok').textContent = `✅ ${PROVIDER[j.provider] ?? ''} 계정 확인됨. 아래 프로필만 입력하면 가입 끝!`;
    $('#pf-ok').hidden = false;
    return true;
  }
  return false;
}
async function postAuth(provider, credential) {
  const r = await fetch(`/api/auth/${provider}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ credential }) }).catch(() => null);
  return handleAuth(r?.ok, r ? await r.json().catch(() => ({})) : {});
}
async function startKakao() {
  const r = await fetch('/api/auth/kakao/start', { method: 'POST', headers: authHeaders() }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (j.url) location.href = j.url;
  else handleAuth(false, j);
}
async function startApple() {
  try {
    await loadScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/ko_KR/appleid.auth.js');
    window.AppleID.auth.init({ clientId: st.info.auth.apple, scope: '', redirectURI: `${location.origin}/`, usePopup: true });
    const r = await window.AppleID.auth.signIn();
    await postAuth('apple', r.authorization.id_token);
  } catch (e) {
    if (e?.error !== 'popup_closed_by_user') handleAuth(false, { error: 'Apple 로그인에 실패했어' });
  }
}
async function initSocial() {
  const a = st.info?.auth;
  if (!a || !(a.google || a.kakao || a.apple)) {
    $('#account-box').hidden = true;
    $('#social-box').hidden = true;
    return;
  }
  $('#social-box').hidden = false;
  for (const id of ['#btn-kakao', '#btn-kakao-link']) {
    $(id).hidden = !a.kakao;
    $(id).onclick = startKakao;
  }
  for (const id of ['#btn-apple', '#btn-apple-link']) {
    $(id).hidden = !a.apple;
    $(id).onclick = startApple;
  }
  if (a.google) {
    try {
      await loadScript('https://accounts.google.com/gsi/client');
      window.google.accounts.id.initialize({ client_id: a.google, callback: (r) => postAuth('google', r.credential) });
      // 구글 버튼은 구글이 그린 것만 쓸 수 있다. 카카오·애플 버튼과 폭·모양을 맞춘다 (최대 400px)
      const gw = Math.round(Math.min(400, Math.max(240, Math.min(innerWidth - 72, 420))));
      window.google.accounts.id.renderButton($('#g-btn'), { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', logo_alignment: 'center', width: gw, locale: 'ko' });
      window.google.accounts.id.renderButton($('#g-btn-link'), { theme: 'outline', size: 'medium', text: 'signin', locale: 'ko' });
    } catch {}
  }
}
function renderAccount() {
  const a = st.info?.auth;
  if (!st.me || !a || !(a.google || a.kakao || a.apple)) return;
  const linked = st.me.linked ?? [];
  $('#account-state').textContent = linked.length ? `${linked.map((x) => PROVIDER[x] ?? x).join(', ')} 연결됨` : '연결하면 다른 기기에서도 이어서 하고, 결제한 입장권이 안전하게 남아.';
  $('#g-btn-link').hidden = !a.google || linked.includes('google');
  $('#btn-kakao-link').hidden = !a.kakao || linked.includes('kakao');
  $('#btn-apple-link').hidden = !a.apple || linked.includes('apple');
}

// ───────────── 입장권 · 결제 ─────────────
function renderWallet() {
  const w = st.me?.wallet;
  if (!w) return;
  $('#wallet-sum').textContent = `오늘 ${w.total}회 입장 가능`;
  const parts = [`무료 ${w.free}/1`];
  if (w.subActive) parts.push(`월정액 오늘 ${w.subLeft}/3 (${new Date(w.subUntil).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}까지)`);
  parts.push(`입장권 ${w.tickets}장`);
  $('#wallet-detail').textContent = parts.join(' · ') + ' · 방이 시작될 때 1회 사용';
  $('#wallet-box').classList.toggle('empty', w.total <= 0);
  const prods = st.info?.pay?.products ?? [];
  const canPay = st.info?.pay?.nice || st.info?.pay?.mock;
  $('#shop').innerHTML = canPay
    ? prods.map((p) => `<button type="button" data-prod="${p.id}"><b>${p.krw.toLocaleString()}원</b>${esc(p.name.replace('입장권 ', ''))}${p.id === 't5' ? '<br><span class="best">20% 할인</span>' : p.id === 'sub30' ? '<br><span class="best">추천</span>' : ''}</button>`).join('')
    : '';
  for (const b of document.querySelectorAll('#shop button')) b.onclick = () => buy(b.dataset.prod);
  if (!canPay) $('#shop-note').textContent = '결제는 준비 중이야.';
  else if (st.info.pay.mock) $('#shop-note').textContent = '개발 모드: 실제 돈이 나가지 않는 모의 결제야.';
}
async function buy(productId) {
  $('#shop-note').textContent = '';
  const r = await fetch('/api/pay/order', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ product: productId }) }).catch(() => null);
  const o = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok) {
    $('#shop-note').textContent = o.error ?? '주문을 만들지 못했어';
    if (o.needLink) $('#account-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (o.mock) {
    if (!confirm(`[모의 결제] ${o.goodsName} ${o.amount.toLocaleString()}원\n실제로 돈이 나가지 않아. 결제할까?`)) return;
    const m = await fetch('/api/pay/mock', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ orderId: o.orderId }) });
    const j = await m.json();
    if (m.ok) {
      st.me = j.me;
      renderWallet();
      $('#shop-note').textContent = '✅ (모의) 결제 완료! 입장권이 들어왔어.';
    } else $('#shop-note').textContent = j.error;
    return;
  }
  try {
    await loadScript(o.nice.jsUrl);
    window.AUTHNICE.requestPay({
      clientId: o.nice.clientId,
      method: 'card',
      orderId: o.orderId,
      amount: o.amount,
      goodsName: o.goodsName,
      returnUrl: o.nice.returnUrl,
      fnError: (e) => ($('#shop-note').textContent = `결제창 오류: ${e?.errorMsg ?? ''}`),
    });
  } catch {
    $('#shop-note').textContent = '결제창을 열지 못했어. 잠시 뒤 다시 시도해 줘.';
  }
}

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
  } else if (m.t === 'queueError') {
    $('#queue-msg').textContent = m.error;
    toastLobby(m.error);
    if (!m.party || /입장권/.test(m.error)) {
      $('#wallet-box').classList.add('empty');
      $('#wallet-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } else if (m.t === 'queue') {
    st.view = null;
    if (st.swReg?.waiting) st.swReg.waiting.postMessage('skipWaiting');
    showLobby(m.status);
  } else if (m.t === 'state') {
    onState(m.view);
  } else if (m.t === 'pos') {
    st.scene?.setRemotePos(m.id, m.x, m.z);
  } else if (m.t === 'emote') {
    st.scene?.applyPose(m.id, m);
  } else if (m.t === 'chat') {
    addChat(m.message);
  } else if (m.t === 'party') {
    onParty(m);
  } else if (m.t === 'partyNote') {
    toastLobby(m.text);
  } else if (m.t === 'social') {
    refreshSocialSoon();
  } else if (m.t === 'dm') {
    onDm(m);
  } else if (m.t === 'ack') {
    st.pending.get(m.reqId)?.(m);
    st.pending.delete(m.reqId);
    if (!m.ok) toast(m.error);
  }
}

// ───────────── 게임 ─────────────
// 배경음악 (게임 화면에서만)
const audio = new AudioDirector();
window.__nsnsAudio = audio; // 진단용
function renderSoundBtn() {
  const off = audio.muted || audio.volume === 0;
  for (const b of [$('#btn-sound'), $('#btn-sound-lobby')]) {
    b.textContent = off ? '🔇' : '🔊';
    b.setAttribute('aria-label', off ? '소리 켜기' : '소리 끄기');
  }
  $('#btn-sound-settings').textContent = off ? '켜기' : '끄기';
  const vol = $('#vol');
  vol.value = off ? 0 : Math.round(audio.volume * 100);
  vol.style.setProperty('--p', `${vol.value}%`);
}
for (const b of [$('#btn-sound'), $('#btn-sound-lobby'), $('#btn-sound-settings')]) {
  b.addEventListener('click', () => {
    const off = audio.muted || audio.volume === 0;
    if (off && audio.volume === 0) audio.setVolume(0.6);
    audio.setMuted(!off);
    audio.start();
    renderSoundBtn();
  });
}
$('#vol').addEventListener('input', (e) => {
  audio.setVolume(Number(e.target.value) / 100);
  audio.start();
  renderSoundBtn();
});
renderSoundBtn();

function onState(v) {
  const first = !st.view;
  st.view = v;
  audio.update(v);
  if (first) {
    $('#party-invite').hidden = true;
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
  if (v.phase === 'freeRoam') return '자유 구경! 조이스틱이나 바닥을 눌러 이동해. 캐릭터를 누르면 프로필, 대화는 텍스트로.';
  if (v.myDate) return `${PHASE_NAMES[v.phase]} 시작! 같은 그룹끼리만 음성이 연결돼 (모의).`;
  if (v.phase.startsWith('date')) return '이번 데이트에는 참여하지 않아. 숙소에서 텍스트로 대화하거나 밖으로 나가 돌아다녀도 돼.';
  if (canRoam()) return `${PHASE_NAMES[v.phase]} · 기다리는 동안 자유롭게 돌아다녀도 돼.`;
  return `${PHASE_NAMES[v.phase]}`;
}

function renderHud() {
  const v = st.view;
  $('#phase-name').textContent = PHASE_NAMES[v.phase] ?? v.phase;
  let sub = '';
  if (v.phase === 'intro' && v.voterGender) sub = `첫인상 선택: ${G[v.voterGender]} · 2차 데이트권 게임: ${G[v.ticketGender]}`;
  else if (v.myDate) sub = `함께: ${v.myDate.members.filter((x) => x !== v.me.id).map(name).join(', ')}`;
  else if (v.phase.startsWith('date')) sub = `${CHANNEL_NAMES[`dorm_${v.me.gender}`]}에서 대기 · 텍스트만 · 이동 가능`;
  else if (v.phase === 'selfIntro' && v.intro) sub = `${Math.min(v.intro.index + 1, v.intro.order.length)} / ${v.intro.order.length}번째`;
  else sub = `나는 ${v.me.alias}`;
  $('#phase-sub').textContent = sub;

  updateLoc();
  $('#phase-badge').classList.toggle('date', !!v.myDate);
  $('#count').textContent = `👤 ${v.participants.filter((p) => p.connected).length}/${v.participants.length}`;
  $('#dev-bar').hidden = !st.info?.devTools;
  $('#btn-dev-fast').classList.toggle('on', v.timeScale > 1);
  $('#btn-dev-fast').textContent = v.timeScale > 1 ? `⏩ ×${v.timeScale} 끄기` : '⏩ 빨리 ×10';
  $('#joystick').hidden = !canRoam();
  $('#actions').hidden = !canRoam();

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
  announceSelfIntro(e);
  st.scene?.drawMinimap($('#minimap'));
  if (canRoam()) {
    updateLoc();
    updatePoseButton();
  }
}, 200);

// 자기소개 바로 전 단계: 시작할 때 'N분 후', 1분 남으면 '곧' 안내
const announced = new Set();
function announceSelfIntro(e) {
  const v = st.view;
  const i = v.phases?.indexOf(v.phase) ?? -1;
  if (i < 0 || v.phases[i + 1] !== 'selfIntro' || e == null) return;
  const left = e - serverNow();
  const key = `${v.roomId}:${v.phaseStartedAt}`;
  if (left > 70_000 && !announced.has(key + ':n')) {
    announced.add(key + ':n');
    notice(`📢 약 ${Math.round(left / 60000)}분 후 자기소개가 있을 예정입니다.`);
  } else if (left <= 60_000 && left > 0 && !announced.has(key + ':soon')) {
    announced.add(key + ':n');
    announced.add(key + ':soon');
    notice('📢 곧 자기소개가 있을 예정입니다. 자기소개 마당으로 모여 주세요.');
  }
}
function notice(text) {
  toast(text);
  const log = $('#chat-log');
  const d = document.createElement('div');
  d.className = 'm sys notice';
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

function updateLoc() {
  const v = st.view;
  if (!v) return;
  const zone = v.zones[v.me.id];
  const me = st.scene?.chars.get(v.me.id)?.group.position;
  const place = canRoam() && me ? st.scene.placeOf(me) : zoneLabel(zone);
  $('#loc').textContent = `📍 ${place} · ${timeLabel(timeOfPhase(v.phase))}`;
}

/** 내가 지금 걸어다닐 수 있는지 (자유 구경, 또는 숙소에서 대기 중) */
function canRoam() {
  return !!st.view?.roaming?.includes(st.view.me.id);
}

// ───────────── 앉기·눕기·점프 ─────────────
let nearSeat = null;
function myPose() {
  return st.scene?.chars.get(st.view?.me.id)?.freePose ?? null;
}
function updatePoseButton() {
  const b = $('#btn-pose');
  if (!st.scene) return;
  if (st.scene.onPoseCleared == null) st.scene.onPoseCleared = () => sendEmote({ kind: 'stand' });
  const pose = myPose();
  nearSeat = pose ? null : st.scene.nearestSeat();
  if (pose) {
    b.textContent = '일어나기';
    b.hidden = false;
  } else if (nearSeat) {
    b.textContent = nearSeat.label;
    b.hidden = false;
  } else b.hidden = true;
}
function sendEmote(e) {
  sendWs({ t: 'act', action: { type: 'emote', ...e } });
}
function togglePose() {
  if (!canRoam() || !st.scene) return;
  const meId = st.view.me.id;
  if (myPose()) {
    st.scene.applyPose(meId, { kind: 'stand' });
    sendEmote({ kind: 'stand' });
  } else if (nearSeat) {
    const e = { kind: nearSeat.kind, x: nearSeat.x, z: nearSeat.z, face: nearSeat.face, y: nearSeat.y ?? 0 };
    st.scene.applyPose(meId, e);
    sendWs({ t: 'act', action: { type: 'move', x: e.x, z: e.z } });
    sendEmote(e);
  }
  updatePoseButton();
}
function jump() {
  if (!canRoam() || !st.scene) return;
  if (myPose()) {
    st.scene.applyPose(st.view.me.id, { kind: 'stand' });
    sendEmote({ kind: 'stand' });
  }
  st.scene.applyPose(st.view.me.id, { kind: 'jump' });
  sendEmote({ kind: 'jump' });
}
// 조이스틱을 누른 채로도 누를 수 있게 click 대신 pointerdown (모바일 멀티터치)
for (const [sel, fn] of [['#btn-pose', togglePose], ['#btn-jump', jump]]) {
  $(sel).addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  });
}
addEventListener('keydown', (e) => {
  // 엔터: 이동 중에도 바로 채팅 입력. 빈 입력에서 엔터/Esc 면 다시 이동으로
  if (e.key === 'Enter' && !e.isComposing && $('#screen-game') && !$('#screen-game').hidden && !e.target.closest?.('input, textarea, button')) {
    e.preventDefault();
    if (chatMin) $('#btn-chat-toggle').click();
    $('#chat-input').focus();
    return;
  }
  if (e.target.id === 'chat-input' && (e.key === 'Escape' || (e.key === 'Enter' && !e.isComposing && !e.target.value.trim()))) {
    e.preventDefault();
    e.target.blur();
    return;
  }
  if (e.target.closest?.('input, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    jump();
  } else if (e.code === 'KeyE') togglePose();
});

// ───────────── 가로 화면 (폰) ─────────────
$('#btn-landscape').addEventListener('click', async () => {
  try {
    await document.documentElement.requestFullscreen?.();
    await screen.orientation?.lock?.('landscape');
  } catch {
    /* iPhone 은 지원 안 함 — 직접 돌려야 함 */
  }
});

// ───────────── 조이스틱 (자유 구경) ─────────────
const joy = { active: false, dx: 0, dz: 0, lastSend: 0 };
{
  const el = $('#joystick');
  const knob = $('#knob');
  const setFrom = (e) => {
    const r = el.getBoundingClientRect();
    let x = e.clientX - (r.left + r.width / 2);
    let y = e.clientY - (r.top + r.height / 2);
    const max = r.width / 2 - 14;
    const len = Math.hypot(x, y);
    if (len > max) {
      x = (x / len) * max;
      y = (y / len) * max;
    }
    knob.style.transform = `translate(${x}px, ${y}px)`;
    joy.dx = x / max;
    joy.dz = y / max; // 화면 아래 = +z
  };
  el.addEventListener('pointerdown', (e) => {
    joy.active = true;
    el.setPointerCapture(e.pointerId);
    setFrom(e);
  });
  el.addEventListener('pointermove', (e) => joy.active && setFrom(e));
  const end = () => {
    joy.active = false;
    joy.dx = joy.dz = 0;
    knob.style.transform = '';
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  let last = performance.now();
  // 키보드: WASD / 방향키 (채팅 입력 중에는 무시)
  const keys = new Set();
  const KEYMAP = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea')) return;
    if (KEYMAP[e.code]) {
      keys.add(KEYMAP[e.code]);
      if (canRoam()) e.preventDefault();
    }
  });
  addEventListener('keyup', (e) => KEYMAP[e.code] && keys.delete(KEYMAP[e.code]));
  addEventListener('blur', () => keys.clear());
  $('#chat-input').addEventListener('focus', () => keys.clear()); // 채팅 입력 중에는 멈춤
  const loop = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    let kx = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0);
    let kz = (keys.has('d') ? 1 : 0) - (keys.has('u') ? 1 : 0);
    if (kx && kz) {
      kx *= Math.SQRT1_2;
      kz *= Math.SQRT1_2;
    }
    let mx = joy.active ? joy.dx : kx;
    let mz = joy.active ? joy.dz : kz;
    if (mx || mz || !canRoam()) st.walkTo = null; // 조이스틱·키보드가 우선
    else if (st.walkTo && st.scene?.localPos) {
      // 땅을 누른 곳까지 걷는 속도로 이동 (벽은 똑같이 막힘)
      const lp = st.scene.localPos;
      const ddx = st.walkTo.x - lp.x;
      const ddz = st.walkTo.z - lp.z;
      const d = Math.hypot(ddx, ddz);
      const before = { x: lp.x, z: lp.z };
      if (d < 0.15) st.walkTo = null;
      else {
        mx = ddx / d;
        mz = ddz / d;
        st.walkStuck = st.walkStuck ?? 0;
      }
      st.walkBefore = before;
    }
    if (st.scene && canRoam() && (mx || mz)) {
      const p = st.scene.moveLocal(mx, mz, dt);
      // 누른 곳으로 걷다가 벽에 막히면 멈춘다
      if (st.walkTo && p && st.walkBefore) {
        const moved = Math.hypot(p.x - st.walkBefore.x, p.z - st.walkBefore.z);
        st.walkStuck = moved < dt * 1.0 ? st.walkStuck + dt : 0;
        if (st.walkStuck > 0.4) st.walkTo = null;
      }
      if (p && now - joy.lastSend > 120) {
        joy.lastSend = now;
        sendWs({ t: 'act', action: { type: 'move', x: p.x, z: p.z } });
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

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
      h = ''; // 장면을 가리지 않도록 안내는 알림으로만
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
      if (v.ladder) {
        h = renderLadder();
        break;
      }
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
    stage.innerHTML = `<img src="${esc(sp.photoUrl)}" alt="${esc(sp.alias)} 프로필 사진" /><div><div class="who">🎙 ${esc(sp.alias)} <span class="qtag">${it.qna ? '질문 시간' : '소개 중'}</span></div><div class="facts">${facts}</div></div>
      <div class="order">${it.index + 1}/${it.order.length}<br/>다음: ${it.order[it.index + 1] ? esc(name(it.order[it.index + 1])) : '-'}</div>`;
    stage.hidden = false;
  }
  if (it.speakerId === v.me.id) {
    if (it.qna) {
      return `<div class="box"><h3>❓ 질문 시간 · 채팅으로 온 질문에 말로 답해 줘 (모의)</h3>
        <button class="btn primary" id="btn-intro-done">질문 받기 마치기</button></div>`;
    }
    return `<div class="box"><h3>🎙 내 차례 · 1분 자기소개 (모의)</h3>
      <p class="muted small">하는 일 · 사는 동네 · 주말 · 이상형. 끝나면 1분 질문 시간이 이어져.</p><button class="btn primary" id="btn-intro-done">소개 마치기 → 질문 받기</button></div>`;
  }
  if (!it.speakerId) return `<div class="box"><h3>다음 발표자 준비 중…</h3></div>`;
  if (it.qna) return `<div class="box"><p><b>❓ 질문 시간!</b> ${esc(name(it.speakerId))}에게 궁금한 걸 아래 채팅으로 물어봐.</p></div>`;
  return `<div class="box"><p>${esc(name(it.speakerId))}의 소개를 듣는 중. 소개가 끝나면 1분 질문 시간이 있어.</p></div>`;
}

// ───────────── 3차 데이트 사다리타기 ─────────────
function ladderPath(L, col) {
  const pts = [[col, -1]];
  let c = col;
  for (let r = 0; r < L.rows; r++) {
    pts.push([c, r]);
    if (L.rungs.some(([rr, cc]) => rr === r && cc === c)) c += 1;
    else if (L.rungs.some(([rr, cc]) => rr === r && cc === c - 1)) c -= 1;
    pts.push([c, r]);
  }
  pts.push([c, L.rows]);
  return { end: c, pts };
}
function renderLadder() {
  const v = st.view;
  const L = v.ladder;
  const male = v.me.gender === 'male';
  const W = 48;
  const X = (c) => 24 + c * W;
  const Y = (r) => (r < 0 ? 26 : r >= L.rows ? 174 : 34 + (r + 0.5) * (132 / L.rows));
  const w = 48 + (L.cols - 1) * W;
  const mySide = male ? L.top : L.bottom;
  const mySlot = Object.keys(mySide).find((k) => mySide[k] === v.me.id);
  let svg = '';
  for (let c = 0; c < L.cols; c++) svg += `<line x1="${X(c)}" y1="26" x2="${X(c)}" y2="174" class="lv"/>`;
  let myPath = '';
  let partner = null;
  if (L.revealed && L.rungs) {
    for (const [r, c] of L.rungs) svg += `<line x1="${X(c)}" y1="${Y(r)}" x2="${X(c + 1)}" y2="${Y(r)}" class="lh"/>`;
    // 내 경로 강조 (남자는 위에서, 여자는 내 도착 칸으로 오는 출발점을 찾아서)
    let start = null;
    if (male && mySlot != null) start = Number(mySlot);
    if (!male && mySlot != null) for (let c = 0; c < L.cols; c++) if (ladderPath(L, c).end === Number(mySlot)) start = c;
    if (start != null) {
      const { end, pts } = ladderPath(L, start);
      myPath = `<polyline class="lpath" points="${pts.map(([c, r]) => `${X(c)},${Y(r)}`).join(' ')}"/>`;
      partner = male ? L.bottom[end] : L.top[start];
    }
  }
  const label = (id, c, mine) => (id ? esc(name(id)) : `${c + 1}번`) + (mine ? ' (나)' : '');
  const slots = (side, y, isMine) => {
    let out = '';
    for (let c = 0; c < L.cols; c++) {
      const id = side[c];
      const mine = id === v.me.id;
      const can = isMine && !L.revealed && (!id || mine);
      out += `<g class="lslot${mine ? ' mine' : ''}${id && !mine ? ' taken' : ''}${can ? ' can' : ''}" ${can ? `data-slot="${c}"` : ''}>
        <rect x="${X(c) - 22}" y="${y - 11}" width="44" height="22" rx="11"/><text x="${X(c)}" y="${y + 4}">${label(id, c, mine)}</text></g>`;
    }
    return out;
  };
  svg += myPath + slots(L.top, 12, male) + slots(L.bottom, 188, !male);
  const left = Math.max(0, Math.ceil((L.revealAt - serverNow()) / 1000));
  const head = L.revealed
    ? partner ? `🎉 3차 데이트 상대: <b>${esc(name(partner))}</b>` : '결과 공개!'
    : `🪜 ${male ? '위쪽 출발점' : '아래쪽 도착점'}을 골라 줘 · 모두 고르거나 시간이 되면 공개`;
  return `<div class="box ladder"><h3>${head}</h3>
    <svg viewBox="0 0 ${w} 200" class="ladder-svg" role="img" aria-label="사다리타기">${svg}</svg>
    <p class="muted small">${L.revealed ? '가로줄은 공개 순간 처음 보여. 서로 고른 칸이 짝을 정했어.' : `${mySlot != null ? `${Number(mySlot) + 1}번 칸 선택됨 · 바꿀 수 있어` : '아직 안 골랐어 · 안 고르면 남은 칸에 자동 배정'}${left ? ` · 공개까지 약 ${left}초` : ''}`}</p></div>`;
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
  for (const g of document.querySelectorAll('#panel .lslot.can')) g.addEventListener('click', () => act({ type: 'ladder', slot: Number(g.dataset.slot) }));
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
  if (canRoam()) {
    st.walkTo = { x, z };
    st.walkStuck = 0;
  }
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
  if (chatMin && !quiet) {
    chatUnread++;
    renderChatToggle();
  }
  // 실시간으로 받은 메시지는 보낸 사람 머리 위 말풍선으로도 보여준다 (받을 권한이 있는 채널만 도착함)
  if (!quiet) st.scene?.showBubble(msg.from, msg.text);
}
// 채팅창 접기/펴기 (기기마다 기억)
let chatMin = false;
let chatUnread = 0;
try { chatMin = localStorage.getItem('nsns-chat-min') === '1'; } catch {}
function renderChatToggle() {
  $('#chat').classList.toggle('min', chatMin);
  $('#btn-chat-toggle').innerHTML = chatMin
    ? `💬 채팅 펴기${chatUnread ? `<span class="unread">${chatUnread > 99 ? '99+' : chatUnread}</span>` : ''}`
    : '접기 ▾';
  $('#btn-chat-toggle').setAttribute('aria-label', chatMin ? '채팅 펴기' : '채팅 접기');
}
$('#btn-chat-toggle').addEventListener('click', () => {
  chatMin = !chatMin;
  if (!chatMin) chatUnread = 0;
  try { localStorage.setItem('nsns-chat-min', chatMin ? '1' : '0'); } catch {}
  renderChatToggle();
  if (!chatMin) renderChatLog();
});
renderChatToggle();

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
  // PC: 보내면 다시 이동 (폰은 키보드를 유지)
  if (!matchMedia('(pointer: coarse)').matches) i.blur();
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
  // 게임 중이 아니면(가입·대기 화면) 새 버전을 바로 적용한다. 게임 중이면 끝난 뒤 적용.
  const applyIfIdle = (reg) => {
    if (!reg.waiting) return;
    if ((st.view && st.view.phase !== 'ended') || !$('#screen-signup').hidden) {
      // 게임 중이거나 가입 입력 중이면 새로고침하지 않고 나중에 적용
      if (st.view) $('#update-bar').hidden = false;
      st.pendingUpdate = reg;
      return;
    }
    reg.waiting.postMessage('skipWaiting');
  };
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || (st.view && st.view.phase !== 'ended') || !$('#screen-signup').hidden) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    applyIfIdle(reg);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) applyIfIdle(reg);
      });
    });
    st.swReg = reg;
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
