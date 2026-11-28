// 나솔너솔 관리자 화면: 신고 확인·처리, 이용 정지·해제
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const KEY_SLOT = 'nsns_admin_key'; // 세션 저장소: 창을 닫으면 사라진다
let tab = 'open';

const CONTEXT = { dm: '1:1 대화', met: '함께한 사람 목록', game: '게임 중', other: '기타' };
const G = { male: '남', female: '여' };
const when = (t) => (t ? new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-admin-key': sessionStorage.getItem(KEY_SLOT) ?? '' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 503 || r.status === 429) {
    logout(j.error);
    throw new Error(j.error);
  }
  if (!r.ok) throw new Error(j.error || '실패했어');
  return j;
}
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 2500);
}

// ── 로그인 ──
function showLogin(err = '') {
  $('#login').hidden = false;
  $('#panel').hidden = true;
  $('#btn-refresh').hidden = $('#btn-logout').hidden = true;
  $('#login-err').textContent = err;
  $('#key').focus();
}
function logout(err) {
  sessionStorage.removeItem(KEY_SLOT);
  showLogin(err);
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  sessionStorage.setItem(KEY_SLOT, $('#key').value.trim());
  $('#key').value = '';
  try {
    await api('/api/admin/summary');
    openPanel();
  } catch { /* logout 이 안내한다 */ }
});
$('#btn-logout').addEventListener('click', () => logout(''));
$('#btn-refresh').addEventListener('click', () => load());
// 무단 이탈 기록 지우기 (통신 장애 등)
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-clear-leave]');
  if (!b || !confirm('이 회원의 무단 이탈 기록과 입장 제한을 지울까?')) return;
  b.disabled = true;
  try {
    await api('/api/admin/clear-leave', { userId: b.dataset.clearLeave });
    toast('이탈 기록을 지웠어');
    load();
  } catch (err) {
    toast(err.message);
    b.disabled = false;
  }
});

// ── 관리 ──
function openPanel() {
  $('#login').hidden = true;
  $('#panel').hidden = false;
  $('#btn-refresh').hidden = $('#btn-logout').hidden = false;
  load();
}
for (const b of document.querySelectorAll('#tabs button')) {
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('on', x === b);
    load();
  });
}

const adminServer=$('#managed-server');
adminServer.addEventListener('change',()=>load());
const capacityUrl=()=>'/api/admin/capacity?server='+encodeURIComponent(adminServer.value || '1');
const capacityForm = $('#capacity-form');
const thresholds = {cpuLimit:'전체 CPU 한계 (%)',coreLimit:'단일 코어 한계 (%)',memoryLimit:'메모리 한계 (%)',
  latencyIncreasePct:'기존 API p95 허용 증가 (%)',staleSeconds:'측정 만료 (초)',recoverySeconds:'정상 지속 후 해제 (초)',
  queueTtlSeconds:'대기 예약 만료 (초)',tripSeconds:'위험 지속 후 차단 (초)',recoveryMarginPct:'정상 복귀 여유 (%)',gameLimitMs:'게임 p95 한계 (ms)',
  minAvailableMiB:'가용 RAM 하한 (MiB, 0이면 수집기 기준)',monthlyBudgetWon:'월 초과비 상한 (원, 0이면 수집기 기준)'};
for(const [key,label] of Object.entries(thresholds)) {
  const field=document.createElement('input');field.name=key;field.type='number';field.required=true;
  field.min=['queueTtlSeconds','staleSeconds'].includes(key)?1:0;
  const wrapper=document.createElement('label');wrapper.append(label+' ',field);$('#threshold-fields').append(wrapper);
}
function renderCapacity(cap) {
  const h=cap.lastMetrics || {}, m={...cap.workerHost,...cap.metrics,...cap.gameLatency};
  const fmt=(x,unit='')=>Number.isFinite(x)?x.toLocaleString('ko-KR',{maximumFractionDigits:2})+unit:'미수신';
  const mib=x=>Number.isFinite(x)?fmt(x/1048576,' MiB'):'미수신';
  const rows={
    '입장 상태':cap.status,'제한 사유':cap.reason || '없음','게임 참여 / 예약':cap.playing+' / '+cap.queued,
    '추가 생성 가능':cap.reason?0:cap.freeRooms,'대기화면 탭 (최근 45초)':fmt(cap.lobbyTabs)+(cap.lobbyCountLimited?' 이상':''),'매칭 전 접속 회원':cap.lobbyAccounts,
    '서버 소속 연결 / 전체 연결':cap.serverConnections+' / '+cap.connections,
    '공통 / 게임 프로세스 메모리':mib(cap.processRss)+' / '+mib(cap.workerRss),
    '게임 호스트 수신':cap.workerHost?.at?new Date(cap.workerHost.at).toLocaleTimeString():'미수신',
    '보호 지표 수신':cap.lastSample?new Date(cap.lastSample).toLocaleTimeString():'미수신',
    '전체 CPU / 가장 바쁜 코어':fmt(h.cpuPct,'%')+' / '+fmt(h.corePeakPct,'%'),
    '코어별 CPU':m.cores?.map(x=>fmt(x,'%')).join(' · ') || '미수신',
    '가용 RAM / 사용 스왑':mib(m.availableBytes)+' / '+mib(m.swapUsedBytes),
    '디스크 읽기 / 쓰기':fmt(m.diskReadBps,' B/s')+' / '+fmt(m.diskWriteBps,' B/s'),
    '디스크 대기시간':fmt(m.diskAwaitMs,' ms'),'네트워크 수신 / 송신':fmt(m.rxBps,' B/s')+' / '+fmt(m.txBps,' B/s'),
    '기존 서비스 p50 / p95 / p99':[m.apiP50Ms,m.apiP95Ms,m.apiP99Ms].map(x=>fmt(x,' ms')).join(' / '),
    '기준선 p95 / 현재 배수':fmt(m.baselineP95Ms,' ms')+' / '+fmt(h.p95Ratio,'배'),
    '기존 API 오류율':fmt(m.apiErrorRate*100,'%'),'게임 p95 / 오류율':fmt(m.gameP95Ms,' ms')+' / '+fmt(m.gameErrorRate*100,'%'),
    '약정 대역 / 당월 누적':fmt(m.contractMbps,' Mbps')+' / '+fmt(m.monthlyBytes/1e9,' GB'),
    '예상 초과비 / 월 예산':fmt(m.projectedOverageWon,'원')+' / '+fmt(m.budgetWon,'원')
  };
  const detail=$('#capacity-details');detail.replaceChildren();
  for(const [name,value] of Object.entries(rows)) {
    const dt=document.createElement('dt'),dd=document.createElement('dd');
    dt.textContent=name;dd.textContent=value;detail.append(dt,dd);
  }
  $('#capacity-audit').replaceChildren(...cap.audit.slice(-20).reverse().map(e=>{
    const item=document.createElement('li');item.textContent=new Date(e.at).toLocaleString()+' '+e.action+' '+JSON.stringify(e.detail);
    return item;
  }));
}
async function pollCapacity() {
  if(!document.hidden && !$('#panel').hidden && $('#capacity-controls').open) {
    const selected=adminServer.value;
    try {
      const cap=await api(capacityUrl());
      if(selected===adminServer.value) renderCapacity(cap);
    } catch (err) {$('#capacity-details').textContent=err.message;}
  }
  setTimeout(pollCapacity,7000);
}
setTimeout(pollCapacity,7000);
capacityForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = capacityForm.elements;
  try {
    await api(capacityUrl(), {...Object.fromEntries(Object.keys(thresholds).map(k=>[k,fields[k].valueAsNumber])),enabled:fields.enabled.checked, maxRooms: fields.maxRooms.valueAsNumber,
      maxPlayers: fields.maxPlayers.valueAsNumber, maintenance: fields.maintenance.checked, blocked: fields.blocked.checked });
    await load();
  } catch (err) { toast(err.message); }
});
async function load() {
  try {
    const s = await api('/api/admin/summary');
    const cap = await api(adminServer.value ? capacityUrl() : '/api/admin/capacity');
    adminServer.replaceChildren(...cap.ids.map(id=>new Option(id+'서버',id)));
    adminServer.value=cap.id;
    $('#capacity-controls').hidden = !cap.managed;
    if (cap.managed) {
      const fields = capacityForm.elements;
      for (const key of ['maxRooms','maxPlayers',...Object.keys(thresholds)]) fields[key].value = cap[key];
      for (const key of ['maintenance','blocked','enabled']) fields[key].checked = cap[key];
      renderCapacity(cap);
    }
    $('#stats').innerHTML = [
      ['서버 상태', esc(s.serverStatus)], ['연결 수', s.connections], ['회원', s.users], ['접속 중', s.online], ['대기 중', s.queue], ['진행 중인 방', s.rooms], ['처리할 신고', s.reportsOpen, s.reportsOpen ? 'hot' : ''], ['정지 중', s.banned],
    ].map(([l, v, c]) => `<div class="stat ${c ?? ''}"><b>${v}</b><span>${l}</span></div>`).join('');
    if (tab === 'banned') return renderBanned(await api('/api/admin/banned'));
    renderReports(await api(`/api/admin/reports?status=${tab}`));
  } catch (err) {
    if (!$('#panel').hidden) toast(err.message);
  }
}

function person(c, label) {
  if (!c || c.deleted) return `<div class="person gone"><span class="who">${label}</span><span>탈퇴한 회원</span></div>`;
  const ban = c.ban ? `<span class="tag red">정지 중 ${c.ban.until ? `~${when(c.ban.until)}` : '(영구)'}</span>` : '';
  const flags = [c.online ? '<span class="tag green">접속 중</span>' : '', c.inGame ? '<span class="tag">게임 중</span>' : '', c.isBot ? '<span class="tag">봇</span>' : ''].join('');
  return `<div class="person">
    <img src="${esc(c.photoUrl)}" alt="" loading="lazy" />
    <div>
      <span class="who">${label}</span>
      <div class="line"><b>${G[c.gender] ?? ''} · ${c.age}세</b> <span class="muted">(생년월일 ${c.birthDate ? esc(c.birthDate) : '<b class="redtxt">미입력</b>'}${c.adultConsentAt ? ` · 성인 확인 동의 ${when(c.adultConsentAt)}` : ''})</span> · ${esc(c.job)} · ${esc(c.region)} ${flags}${ban}</div>
      ${c.sanctions?.length || c.reportsMade ? `<div class="line muted">제재 이력 ${c.sanctions?.filter((x) => x.action === 'ban').length ?? 0}회${c.sanctions?.length ? ` (${c.sanctions.slice(-3).map((x) => `${when(x.at)} ${x.action === 'ban' ? `${x.days ? `${x.days}일` : '영구'} 정지${x.about === 'reporter' ? '·허위 신고' : ''}` : '해제'}`).join(', ')})` : ''} · 보낸 신고 ${c.reportsMade ?? 0}건${c.reportsMadeDismissed ? ` (기각 <b class="${c.reportsMadeDismissed >= 3 ? 'redtxt' : ''}">${c.reportsMadeDismissed}</b>)` : ''}</div>` : ''}
      <div class="line muted">가입 ${when(c.createdAt)} · 로그인 ${c.linked.length ? esc(c.linked.join(', ')) : '없음'} · 받은 신고 <b class="${c.reportsAgainst >= 3 ? 'redtxt' : ''}">${c.reportsAgainst}건</b>${c.leave?.count ? ` · 무단 이탈 <b class="${c.leave.count >= 2 ? 'redtxt' : ''}">${c.leave.count}회</b>${c.leave.blockedUntil ? ` (~${when(c.leave.blockedUntil)} 입장 제한)` : ''} <button type="button" class="ghost tiny-btn" data-clear-leave="${esc(c.id)}">이탈 기록 지우기</button>` : ''}${c.handle ? ` · @${esc(c.handle)}` : ''} · <code>${esc(c.id.slice(0, 8))}</code></div>
    </div>
  </div>`;
}

function evidence(r) {
  const ev = r.evidence;
  if (!ev) return '';
  if (ev.messages) {
    if (!ev.messages.length) return '<p class="muted small">대화 기록 없음</p>';
    return `<div class="ev"><div class="ev-title">최근 1:1 대화</div>${ev.messages.map((m) => `<div class="msg ${m.from === 'target' ? 'them' : 'me'}"><span>${m.from === 'target' ? '신고 대상' : '신고자'}</span>${esc(m.text)}<time>${when(m.at)}</time></div>`).join('')}</div>`;
  }
  if (ev.chat) {
    if (!ev.chat.length) return `<p class="muted small">게임 가명 ${esc(ev.alias)} · 채팅 기록 없음</p>`;
    return `<div class="ev"><div class="ev-title">게임 채팅 (가명 ${esc(ev.alias)})</div>${ev.chat.map((m) => `<div class="msg them"><span>${esc(m.channel)}</span>${esc(m.text)}<time>${when(m.at)}</time></div>`).join('')}</div>`;
  }
  return '';
}

function renderReports(list) {
  if (!list.length) return ($('#list').innerHTML = '<p class="empty">해당하는 신고가 없어.</p>');
  $('#list').innerHTML = list.map((r) => `
    <article class="card report" data-id="${r.id}">
      <div class="r-head">
        <span class="reason">${esc(r.reasonLabel)}</span>
        <span class="muted">${CONTEXT[r.context] ?? r.context} · ${when(r.at)}</span>
        <span class="status s-${r.status}">${{ open: '접수', resolved: '처리 완료', dismissed: '기각' }[r.status]}</span>
      </div>
      ${r.detail ? `<p class="detail">“${esc(r.detail)}”</p>` : ''}
      <div class="people">${person(r.targetCard, '신고 대상')}${person(r.reporterCard, '신고한 사람')}</div>
      ${evidence(r)}
      ${r.handledAt ? `<p class="muted small">처리 ${when(r.handledAt)}${r.action ? ` · ${esc(r.action)}` : ''}${r.note ? ` · 메모: ${esc(r.note)}` : ''}</p>` : ''}
      <div class="acts">
        <input class="note" placeholder="처리 메모 (선택)" maxlength="500" value="${esc(r.note ?? '')}" />
        ${r.targetCard?.deleted ? '' : `
        <select class="days">
          <option value="1">1일 정지</option><option value="7" selected>7일 정지</option><option value="30">30일 정지</option><option value="0">영구 정지</option>
        </select>
        <input class="reason-in" placeholder="정지 사유 (대상에게 보여요)" maxlength="200" value="${esc(r.reasonLabel)}" />
        <button type="button" class="red" data-act="ban">정지하고 처리 완료</button>`}
        ${r.reporterCard?.deleted ? '' : '<button type="button" class="ghost" data-act="ban-reporter" title="악의적인 허위 신고로 판단될 때: 신고자를 정지하고 이 신고는 기각">허위 신고 · 신고자 정지</button>'}
        ${r.status !== 'resolved' ? '<button type="button" class="pk" data-act="resolve">처리 완료</button>' : ''}
        ${r.status !== 'dismissed' ? '<button type="button" class="ghost" data-act="dismiss">기각</button>' : ''}
        ${r.status !== 'open' ? '<button type="button" class="ghost" data-act="reopen">다시 접수로</button>' : ''}
      </div>
    </article>`).join('');
  for (const card of document.querySelectorAll('.report')) {
    const id = card.dataset.id;
    const r = list.find((x) => x.id === id);
    for (const b of card.querySelectorAll('[data-act]')) {
      b.onclick = async () => {
        const note = card.querySelector('.note').value;
        b.disabled = true;
        try {
          if (b.dataset.act === 'ban') {
            const days = Number(card.querySelector('.days').value);
            await api('/api/admin/ban', { userId: r.target, days: days || null, reason: card.querySelector('.reason-in').value, reportId: id, note });
            toast(days ? `${days}일 정지했어` : '영구 정지했어');
          } else if (b.dataset.act === 'ban-reporter') {
            const days = Number(card.querySelector('.days')?.value ?? 7);
            if (!confirm(`신고한 사람을 허위 신고로 ${days ? `${days}일` : '영구'} 정지하고 이 신고는 기각할까?`)) { b.disabled = false; return; }
            await api('/api/admin/ban', { userId: r.reporter, days: days || null, reason: '허위 신고', reportId: id, note, about: 'reporter' });
            toast('신고자를 정지했어');
          } else {
            const status = { resolve: 'resolved', dismiss: 'dismissed', reopen: 'open' }[b.dataset.act];
            await api(`/api/admin/reports/${id}`, { status, note });
            toast('바꿨어');
          }
          load();
        } catch (err) {
          toast(err.message);
          b.disabled = false;
        }
      };
    }
  }
}

function renderBanned(list) {
  if (!list.length) return ($('#list').innerHTML = '<p class="empty">정지된 회원이 없어.</p>');
  $('#list').innerHTML = list.map((c) => `
    <article class="card" data-id="${esc(c.id)}">
      ${person(c, '정지된 회원')}
      <p class="small">사유: ${esc(c.ban?.reason)} · 정지 ${when(c.ban?.at)} · ${c.ban?.until ? `${when(c.ban.until)}까지` : '영구'}</p>
      <div class="acts"><button type="button" class="ghost" data-act="unban">정지 해제</button></div>
    </article>`).join('');
  for (const b of document.querySelectorAll('[data-act="unban"]')) {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api('/api/admin/unban', { userId: b.closest('.card').dataset.id });
        toast('정지를 풀었어');
        load();
      } catch (err) {
        toast(err.message);
        b.disabled = false;
      }
    };
  }
}

if (sessionStorage.getItem(KEY_SLOT)) openPanel();
else showLogin();
