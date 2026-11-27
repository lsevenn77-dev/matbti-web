// 12명 실제 WebSocket 클라이언트로 한 회차를 끝까지 진행하는 검증 스크립트.
// 사용: node scripts/simulate.js [timeScale=60] [preset=fourDates]
// 측정: 1인당 서버→클라이언트 게임 상태 바이트 (음성·사진·정적 파일 제외)

import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createServer } from '../server/index.js';
import { estimateMinutes } from '../server/config.js';

const timeScale = Number(process.argv[2] || 60);
const preset = process.argv[3] || 'fourDates';
const targetRooms = Number(process.argv[4] || 1);
assert([1, 2, 10, 20, 25, 50, 100, 200, 400].includes(targetRooms));
const latency = [];
let uploaded = 0;
let wireRx = 0;
let wireTx = 0;
const topology=process.argv[5] || 'legacy';
assert(['legacy','1','2','both'].includes(topology));
const activity=process.argv[6] || 'smoke';
assert(['smoke','walking'].includes(activity));
const nodes=topology==='both' ? ['1','2'] : [topology];
const storage=process.argv[7] || 'memory';
assert(['memory','disk'].includes(storage));
const directory=storage==='disk'?mkdtempSync(path.join(tmpdir(),'nasol-fixture-')):null;
if(directory) process.on('exit',()=>rmSync(directory,{recursive:true,force:true}));
const writes={};
const key=randomBytes(32).toString('hex');
const app = createServer({ env: { CAPACITY_MANAGED:topology==='legacy'?'0':'1',
  ADMIN_KEY:key, DATA_DIR:directory, GAME_WORKER_1:'local',GAME_WORKER_2:'local', GAME_SERVERS:'1,2', TIME_SCALE: String(timeScale), PRESET: preset, DEV_TOOLS: '0' }, dataDir: directory });
for(const [owner,obj,keys] of [['store',app.store,['persist','savePhoto','saveGameRecord']],['relations',app.rel,['persist']]]) {
  for(const k of keys) {
    const original=obj[k].bind(obj);
    const row=writes[owner+'.'+k]={calls:0,ms:0};
    obj[k]=(...args)=>{const now=performance.now();try{return original(...args);}finally{row.calls++;row.ms+=performance.now()-now;}};
  }
}
const port = await app.listen(0,'127.0.0.1');
const base = `http://127.0.0.1:${port}`;

async function admin(route, id, body) {
  const r=await fetch(base+'/api/admin/'+route+'?server='+id,{method:'POST',
    headers:{'x-admin-key':key,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(r.status,200);
  return r.json();
}
async function heartbeat() {
  for(const id of nodes) await admin('health-sample',id,{at:Date.now(),cpuPct:1,corePeakPct:1,
    memPct:1,p95Ratio:1,errorRatio:0,ioOk:true,networkOk:true,budgetOk:true});
}
let pulse;
if(topology!=='legacy') {
  for(const id of nodes) await admin('capacity',id,{maxRooms:targetRooms,maxPlayers:12*targetRooms,recoverySeconds:0});
  await heartbeat();
  pulse=setInterval(()=>heartbeat().catch(err=>{console.error(err.message);process.exit(1);}),5000);
}
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
    this.markers=[];
    this.pending = new Map();
    this.seq = 0;
    this.done = new Set();
    this.leaks = [];
  }
  async signup() {
    const r = await fetch(`${base}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gender: this.gender, age: 25 + this.i % 12, job: `SECRETJOB${this.i}`, region: `SECRETREGION${this.i}`, photo }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    this.token = j.token;
  }
  connect() {
    return new Promise((res) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const ws = this.ws;
      ws.on('upgrade', response => {
        const socket = response.socket;
        socket.once('close', () => { wireRx += socket.bytesRead; wireTx += socket.bytesWritten; });
      });
      this.ws.on('open', () => {
        this.send({ t: 'hello', token: this.token });
      });
      this.ws.on('message', (raw) => {
        this.bytes += raw.length;
        this.msgs++;
        const m = JSON.parse(raw);
        if (m.t === 'welcome') res();
        if (m.t === 'ack' && this.pending.has(m.reqId)) {
          if (m.ok) latency.push(performance.now() - this.pending.get(m.reqId));
          this.pending.delete(m.reqId);
        }
        if(m.t==='chat' && m.message.text.startsWith('LAB-ROOM-')) this.markers.push(m.message.text);
        if (m.t === 'state') this.onState(m.view);
      });
    });
  }
  send(o) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const body = JSON.stringify(o);
    uploaded += Buffer.byteLength(body);
    this.ws.send(body);
  }
  act(a) {
    const reqId = ++this.seq;
    this.pending.set(reqId, performance.now());
    this.send({ t: 'act', reqId, action: a });
  }
  onState(v) {
    if(!this.view) this.matchedMs=performance.now()-this.joinedAt;
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
    if(v.phase==='intro' && v.me.id==='p1' && key('marker')) {
      this.act({type:'chat',channel:'lounge',text:'LAB-ROOM-'+v.roomId});
    }
    if (v.phase === 'firstVote' && v.vote.canVote && key('vote')) setTimeout(() => this.act({ type: 'vote', target: rnd(opp) }), 50);
    if (v.phase === 'selfIntro' && v.intro?.speakerId === v.me.id && key(`intro`)) setTimeout(() => this.act({ type: 'introDone' }), 100);
    // 데이트권: 보물찾기는 아래 treasureWalk 가 걸어가서 찾는다. 예전 반응 속도 게임(type=reaction)도 지원
    if (v.phase === 'minigame' && v.minigame?.type === 'reaction' && v.minigame.playing && v.minigame.goAt && !v.minigame.myTap && key(`tap${v.minigame.round}`)) {
      setTimeout(() => this.act({ type: 'tap', reactionMs: 200 + Math.round(Math.random() * 400) }), 30);
    }
    if (v.phase === 'date3Pick' && v.pick?.currentPicker === v.me.id && key(`pick`)) setTimeout(() => this.act({ type: 'pick', target: rnd(v.pick.options) }), 50);
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
for (let i = 0; i < targetRooms * 12; i++) clients.push(new Client(i, i % 2 ? 'female' : 'male'));
for (const c of clients) await c.signup();
for (const c of clients) await c.connect();
const stopLobby = process.argv.includes('--mixed-lobby')
  ? await (await import('./mixed-lobby.js')).startLobbyTraffic(app,port) : null;
const t0 = Date.now();
for (const c of clients) {
  c.joinedAt=performance.now();
  c.send({t:'queue.join',serverId:topology==='legacy'?undefined:nodes[Math.floor(c.i/12)%nodes.length]});
}

// 재접속 시험: 한 명이 자유 구경 중 끊겼다 다시 들어온다
let reconnected = false;
const activityTimers=[];
const heap=[];
if(activity==='walking') {
  activityTimers.push(setInterval(()=>{
    const t=Date.now()/1000;
    for(const c of clients) {
      const v=c.view;
      if(c.ws.readyState!==WebSocket.OPEN || !v || v.phase==='ended') continue;
      if(v.roaming.includes(v.me.id) && (t+c.i*3)%10<4) {
        c.act({type:'move',x:Math.round(400*Math.sin(t+c.i))/100,z:Math.round(300*Math.cos(t+c.i))/100});
      }
      if(v.channels.length && (!c.nextChat || t>=c.nextChat)) {
        c.act({type:'chat',channel:v.channels[0],text:'스테이징 대화 '+c.i});
        c.nextChat=t+25+c.i%15;
      }
    }
  },125));
  activityTimers.push(setInterval(()=>{
    for(const c of clients) c.send({t:'ping',c:Date.now()});
  },15000));
}
// 데이트권 보물찾기: 내 성별 보물이 보이면 걸어서 다가간다 (서버의 순간이동 검사: 초당 maxSpeed m × 배속)
activityTimers.push(setInterval(()=>{
  for(const c of clients) {
    const v=c.view;
    const m=v?.minigame;
    if(c.ws.readyState!==WebSocket.OPEN || v?.phase!=='minigame' || m?.type!=='treasure' || !m.treasure || m.myFound) { if(v?.phase!=='minigame') c.pos=null; continue; }
    c.pos ??= v.positions?.[v.me.id] ?? {x:0,z:0};
    const dx=m.treasure.x-c.pos.x, dz=m.treasure.z-c.pos.z, d=Math.hypot(dx,dz);
    const step=Math.min(d, 0.8*Math.max(1,timeScale));
    if(d<0.05) continue;
    c.pos={x:c.pos.x+dx/d*step,z:c.pos.z+dz/d*step};
    c.act({type:'move',x:Math.round(c.pos.x*100)/100,z:Math.round(c.pos.z*100)/100});
  }
},100));
activityTimers.push(setInterval(()=>{
  heap.push({s:Math.round((Date.now()-t0)/1000),rss:process.memoryUsage().rss,heap:process.memoryUsage().heapUsed});
},60000));

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
for(const timer of activityTimers) clearInterval(timer);

const room = [...app.rooms.values()][0].room;
const elapsedReal = (Date.now() - t0) / 1000;
const nominalSec = elapsedReal * timeScale;
const totalBytes = clients.reduce((s, c) => s + c.bytes, 0);
const perUser = totalBytes / clients.length;
const ev = (t) => room.events.filter((e) => e.type === t);

console.log(`\n== 시뮬레이션 결과 (${preset}, 배속 ×${timeScale}) ==`);
console.log('단계 순서:', clients[0].phases.join(' → '));
if(topology==='legacy') {
console.log('1차 선택 성별:', room.voterGender, '/ 2차 선택 성별:', room.secondGender);
console.log('1차 데이트 그룹 크기:', room.dates.date1.map((g) => `${g.members.length - 1}:1`).join(', '));
console.log('2차 데이트 그룹 크기:', room.dates.date2.map((g) => `${g.members.length - 1}:1`).join(', '));
console.log('3차(데이트권):', room.dates.date3.length, '쌍', '/ 4차(사다리):', room.dates.date4.length, '쌍');
console.log('보물 발견:', ev('treasureFound').length, '장');
console.log('자기소개 완료:', room.intro.done.length, '명, 건너뜀:', room.intro.skipped.length);
}
console.log('최종 매치:', room.matches.length, '쌍');
console.log('재접속 복구:', reconnected && clients[3].view.phase === 'ended' ? 'OK' : 'FAIL');
console.log('비공개 정보 누출:', clients.flatMap((c) => c.leaks).length ? clients.flatMap((c) => c.leaks).slice(0, 5) : '없음');
if(topology==='legacy') console.log('음성 작업 수(모의):', app.voice.ops.length, '/ 종료 후 남은 송출:', Object.values(app.voice.snapshot(room.id)).filter((x) => x.publish).length);
console.log('이벤트 기록:', ev('vote').length, '투표,', ev('pick').length, '지목,', ev('final').length, '최종선택');
console.log(`실제 소요 ${elapsedReal.toFixed(1)}s → 환산 ${(nominalSec / 60).toFixed(1)}분 (설정 예상 ${estimateMinutes(app.config)}분, 자기소개 조기종료 포함)`);
console.log(`게임 상태 수신량: 1인당 ${(perUser / 1024).toFixed(0)}KB / 회차, 메시지 ${Math.round(clients.reduce((s, c) => s + c.msgs, 0) / clients.length)}개`);
console.log(`  → 설정 기준 ${estimateMinutes(app.config)}분 회차로 나누면 평균 ${(perUser / (estimateMinutes(app.config) * 60)).toFixed(0)} B/s/인`);

clearInterval(pulse);
const incomplete = [...app.rooms.values()].filter(({room:r}) => {
  const count = type => r.events.filter(e => e.type === type).length;
  // 첫인상은 남녀 12명 전원이 투표한다
  return count('vote') !== 12 || count('final') !== 12;
}).length;
assert.equal(app.rooms.size, targetRooms);
assert(clients.every(c => c.view?.phase === 'ended' && !c.leaks.length));
assert(reconnected);
assert(latency.length > 0);
await Promise.all(clients.map(c => new Promise(resolve => {
  c.ws.once('close', resolve);
  c.ws.close();
})));
await new Promise(resolve => setTimeout(resolve, 100));
latency.sort((a,b) => a-b);
const p95 = latency[Math.ceil(latency.length * .95)-1];
const voiceSummary=topology==='legacy' ? {ops:app.voice.ops.length,remaining:0} :
  {ops:[...app.rooms.values()].reduce((sum,e)=>sum+e.mockVoiceOps,0),remaining:[...app.rooms.values()].reduce((sum,e)=>sum+e.remainingTracks,0)};
assert(voiceSummary.ops>0 && voiceSummary.remaining===0);
const nodeMetrics={};
if(topology!=='legacy') for(const id of nodes) {
  const r=await fetch(base+'/api/admin/capacity?server='+id,{headers:{'x-admin-key':key}});
  const info=await r.json();
  nodeMetrics[id]={workerRxBytes:info.workerRxBytes,workerTxBytes:info.workerTxBytes,workerRss:info.workerRss};
}
const missingChat=clients.filter(c=>c.markers.length!==1 || c.markers[0]!=='LAB-ROOM-'+c.view.roomId).length;
const matchTimes=clients.map(c=>c.matchedMs).sort((a,b)=>a-b);
const matchP95=matchTimes[Math.ceil(matchTimes.length*.95)-1];
const mixedLobby=stopLobby ? await stopLobby() : null;
console.log(JSON.stringify({topology,activity,storage,mixedLobby,writes,heap,nodeMetrics,voiceSummary,missingChat,matchP95, assigned:Object.fromEntries(nodes.map(n=>[n,[...app.rooms.values()].filter(e=>e.serverId===n).length])),targetRooms, clients:clients.length, elapsedReal,
  incompleteRooms:incomplete, successfulActions:latency.length, p95Ms:p95, downloaded:totalBytes, uploaded, tcpRx:wireRx, tcpTx:wireTx}));
app.close();
assert.equal(missingChat,0,'lounge marker lost, duplicated or sent across rooms');
assert.equal(incomplete,0,'missing vote or final choice');
assert(p95 <= 100, 'game action p95 exceeded 100 ms');
