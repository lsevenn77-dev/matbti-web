// 배경음악·환경음
// - 단계마다 분위기(mood)가 바뀐다. 음원 파일이 /audio/tracks.json 에 있으면 그 파일을, 없으면 브라우저에서 합성한 음악을 튼다.
// - 누가 말하는 중(자기소개·데이트 음성)이면 음악을 자동으로 줄인다. 자기소개는 음악 없이 환경음만.
// - 음소거는 기기에 기억한다. 브라우저 정책상 첫 터치·클릭 뒤에 소리가 난다.

const MOODS = {
  waiting: { bpm: 92, chords: [[0, 'M'], [7, 'M'], [9, 'm'], [5, 'M']], inst: 'pluck', vol: 0.5, amb: 0 }, // 대기 화면 (음원 파일 우선)
  //        bpm  화음(근음 반음, 장/단)                                 악기          음량
  lobby:   { bpm: 92, chords: [[0, 'M'], [7, 'M'], [9, 'm'], [5, 'M']], inst: 'pluck', vol: 0.5, amb: 0.5 },
  village: { bpm: 84, chords: [[0, 'M'], [5, 'M'], [9, 'm'], [7, 'M']], inst: 'pluck', vol: 0.45, amb: 1 },
  tension: { bpm: 72, chords: [[9, 'm'], [5, 'M'], [9, 'm'], [4, 'M']], inst: 'piano', vol: 0.4, amb: 0.3, tick: true },
  romance: { bpm: 66, chords: [[5, 'M'], [7, 'M'], [4, 'm'], [9, 'm']], inst: 'piano', vol: 0.22, amb: 0.4 },
  upbeat:  { bpm: 128, chords: [[0, 'M'], [9, 'm'], [5, 'M'], [7, 'M']], inst: 'marimba', vol: 0.45, amb: 0.2 },
  emotion: { bpm: 60, chords: [[9, 'm'], [5, 'M'], [0, 'M'], [7, 'M']], inst: 'piano', vol: 0.45, amb: 0.2, pad: true },
  warm:    { bpm: 76, chords: [[0, 'M'], [4, 'm'], [5, 'M'], [7, 'M']], inst: 'piano', vol: 0.45, amb: 0.4, pad: true },
  calm:    { bpm: 64, chords: [[5, 'M'], [0, 'M'], [7, 'M'], [9, 'm']], inst: 'pluck', vol: 0.35, amb: 0.6 },
  quiet:   { bpm: 60, chords: [], inst: null, vol: 0, amb: 0.6 }, // 음악 없음, 환경음만
};

/** 단계 → 분위기 */
export function moodFor(view) {
  if (!view) return 'waiting'; // 게임 밖 = 대기 화면
  const p = view.phase;
  if (!p || p === 'waiting') return 'waiting';
  if (p === 'intro') return 'lobby';
  if (p === 'firstVote' || p === 'date2Pick') return 'tension';
  if (p.startsWith('date')) return view.myDate ? 'romance' : 'village';
  if (p === 'freeRoam') return 'village';
  if (p === 'selfIntro') return 'quiet';
  if (p === 'minigame' || p === 'randomAssign') return 'upbeat';
  if (p === 'finalChoice') return 'emotion';
  if (p === 'result' || p === 'contact' || p === 'ended') return view.result?.matchedWith ? 'warm' : 'calm';
  return 'village';
}

const BASE = 57; // A3 기준 (MIDI)
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class AudioDirector {
  constructor() {
    this.ctx = null;
    this.mood = null;
    this.muted = false;
    try { this.muted = localStorage.getItem('nsns-muted') === '1'; } catch {}
    this.volume = 0.8; // 0~1, 대기 화면 슬라이더
    try { const v = parseFloat(localStorage.getItem('nsns-volume')); if (v >= 0 && v <= 1) this.volume = v; } catch {}
    this.duck = 1;
    this.files = {};
    fetch('/audio/tracks.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).then((j) => {
      this.files = j || {};
      if (this.ctx && this.mood) this.applyMood(this.mood); // 파일 목록이 늦게 와도 반영
    }).catch(() => {});
    // 브라우저 정책: 사용자가 한 번 눌러야 소리를 낼 수 있다
    const unlock = () => {
      this.start();
      if (this.ctx?.state === 'running') {
        removeEventListener('pointerdown', unlock, true);
        removeEventListener('keydown', unlock, true);
      }
    };
    addEventListener('pointerdown', unlock, true);
    addEventListener('keydown', unlock, true);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else if (!this.muted) this.ctx.resume();
    });
  }

  start() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.connect(this.master);
      this.ambBus = this.ctx.createGain();
      this.ambBus.gain.value = 0;
      this.ambBus.connect(this.master);
      // 부드러운 공간감
      this.verb = this.makeReverb(); // 입력 노드 (출력은 musicBus 로 연결됨)
      this.dry = this.ctx.createGain();
      this.dry.connect(this.musicBus);
      this.startAmbience();
      this.step = 0;
      this.nextTime = this.ctx.currentTime + 0.1;
      this.timer = setInterval(() => this.schedule(), 100);
      if (this.mood) this.applyMood(this.mood, true);
    }
    if (this.ctx.state !== 'running' && !this.muted) this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    try { localStorage.setItem('nsns-muted', m ? '1' : '0'); } catch {}
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.1);
    if (!m) this.ctx.resume();
  }

  /** 음량 0~1. 0 으로 내리면 음소거와 같다 */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem('nsns-volume', String(this.volume)); } catch {}
    if (this.volume > 0 && this.muted) this.setMuted(false);
    if (this.ctx && !this.muted) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }

  /** 상태 반영: 분위기와 말하는 사람 여부 */
  update(view) {
    const mood = moodFor(view);
    const speaking = (view?.speakingIds?.length ?? 0) > 0;
    this.duck = speaking ? 0.35 : 1;
    if (mood !== this.mood) {
      this.mood = mood;
      if (this.ctx) this.applyMood(mood);
    } else if (this.ctx) this.applyVolumes();
  }

  applyMood(mood) {
    const m = MOODS[mood] ?? MOODS.village;
    this.m = m;
    this.step = 0;
    // 음원 파일이 있으면 합성 음악 대신 재생
    const file = this.files[mood];
    if (this.fileEl && this.fileEl.dataset.mood !== mood) {
      const old = this.fileEl;
      this.fileEl = null;
      this.fade(old, 0, 1.2, () => old.pause());
    }
    if (file && !this.fileEl) {
      const el = new Audio(file.url ?? file);
      el.loop = true;
      el.crossOrigin = 'anonymous';
      el.dataset.mood = mood;
      el.volume = 0;
      // 음소거(master)가 음원 파일에도 적용되도록 WebAudio 로 연결 (같은 출처 파일)
      try {
        this.ctx.createMediaElementSource(el).connect(this.master);
      } catch {}
      el.play().catch(() => {});
      this.fileEl = el;
      this.fileVol = file.volume ?? 0.6;
    }
    this.applyVolumes();
  }

  applyVolumes() {
    const m = this.m ?? MOODS.village;
    const t = this.ctx.currentTime;
    const synthOn = !this.fileEl;
    this.musicBus.gain.setTargetAtTime(synthOn ? m.vol * this.duck : 0, t, 0.6);
    this.ambBus.gain.setTargetAtTime(m.amb * 0.5, t, 1.0);
    if (this.fileEl) this.fade(this.fileEl, this.fileVol * this.duck * (m.vol > 0 ? 1 : 0), 1.2);
  }

  fade(el, to, sec, done) {
    const from = el.volume;
    const t0 = performance.now();
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / (sec * 1000));
      el.volume = Math.max(0, Math.min(1, from + (to - from) * k));
      if (k < 1) requestAnimationFrame(tick);
      else done?.();
    };
    tick();
  }

  // ── 합성 음악 ──
  schedule() {
    const m = this.m;
    if (!m || !m.inst || this.ctx.state !== 'running') {
      this.nextTime = this.ctx.currentTime + 0.1;
      return;
    }
    const spb = 60 / m.bpm / 2; // 8분음표
    while (this.nextTime < this.ctx.currentTime + 0.3) {
      this.playStep(m, this.step, this.nextTime, spb);
      this.nextTime += spb;
      this.step++;
    }
  }

  playStep(m, step, t, spb) {
    const bar = Math.floor(step / 8) % m.chords.length;
    const [root, q] = m.chords[bar];
    const third = q === 'M' ? 4 : 3;
    const tones = [0, third, 7, 12, 7, third];
    const s = step % 8;
    // 마디 첫 박: 베이스 + (선택) 패드
    if (s === 0) {
      this.note(BASE - 12 + root, t, spb * 7, 'bass', 0.32);
      if (m.pad) for (const iv of [0, third, 7]) this.note(BASE + root + iv, t, spb * 8, 'pad', 0.06);
    }
    // 아르페지오 (가끔 쉬어서 덜 기계적으로)
    const rest = (m.inst === 'piano' && s % 2 === 1) || Math.random() < 0.12;
    if (!rest) {
      const iv = tones[(s + Math.floor(step / 32)) % tones.length];
      const oct = m.inst === 'marimba' ? 12 : 0;
      this.note(BASE + root + iv + oct, t, spb * (m.inst === 'piano' ? 3 : 1.6), m.inst, m.inst === 'marimba' ? 0.22 : 0.18);
    }
    // 가끔 멜로디 한 음
    if (s === 4 && Math.random() < 0.5) this.note(BASE + 12 + root + [0, third, 7][Math.floor(Math.random() * 3)], t, spb * 4, m.inst === 'marimba' ? 'marimba' : 'piano', 0.12);
    if (m.tick && s % 2 === 0) this.note(96, t, 0.03, 'tick', 0.05);
  }

  note(midi, t, dur, inst, vel) {
    const c = this.ctx;
    const f = midiHz(midi);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    const out = inst === 'pad' || inst === 'piano' ? this.verb : this.dry;
    g.connect(out);
    if (inst === 'piano') g.connect(this.dry);
    const osc = c.createOscillator();
    let stop = t + dur + 0.1;
    if (inst === 'pluck') {
      osc.type = 'triangle';
      g.gain.linearRampToValueAtTime(vel, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    } else if (inst === 'piano') {
      osc.type = 'triangle';
      const o2 = c.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 2;
      const g2 = c.createGain();
      g2.gain.value = 0.25;
      o2.connect(g2).connect(g);
      o2.start(t);
      o2.stop(t + dur + 0.2);
      g.gain.linearRampToValueAtTime(vel, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur + 0.1);
      stop = t + dur + 0.2;
    } else if (inst === 'marimba') {
      osc.type = 'sine';
      g.gain.linearRampToValueAtTime(vel, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0008, t + Math.min(dur, 0.35));
    } else if (inst === 'bass') {
      osc.type = 'sine';
      g.gain.linearRampToValueAtTime(vel, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    } else if (inst === 'pad') {
      osc.type = 'sawtooth';
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      osc.connect(lp).connect(g);
      g.gain.linearRampToValueAtTime(vel, t + dur * 0.4);
      g.gain.linearRampToValueAtTime(0, t + dur);
      osc.frequency.value = f;
      osc.start(t);
      osc.stop(t + dur + 0.1);
      return;
    } else if (inst === 'tick') {
      osc.type = 'square';
      g.gain.linearRampToValueAtTime(vel, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.04);
      stop = t + 0.06;
    }
    osc.frequency.value = f;
    osc.connect(g);
    osc.start(t);
    osc.stop(stop);
  }

  makeReverb() {
    const c = this.ctx;
    const len = c.sampleRate * 2.2;
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
    const conv = c.createConvolver();
    conv.buffer = buf;
    const g = c.createGain();
    g.gain.value = 0.35;
    g.connect(conv);
    conv.connect(this.musicBus ?? c.destination);
    // 입력은 g, 출력은 conv 가 musicBus 로
    return g;
  }

  // ── 환경음: 개울 + 새소리 ──
  startAmbience() {
    const c = this.ctx;
    const len = c.sampleRate * 3;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = last * 0.97 + (Math.random() * 2 - 1) * 0.03; // 갈색 잡음
      d[i] = last * 3;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 0.6;
    const g = c.createGain();
    g.gain.value = 0.25;
    src.connect(bp).connect(g).connect(this.ambBus);
    src.start();
    const chirp = () => {
      if (this.ctx.state === 'running' && (this.m?.amb ?? 0) > 0.3) {
        const t = c.currentTime;
        const n = 2 + Math.floor(Math.random() * 3);
        const base = 2400 + Math.random() * 1600;
        for (let i = 0; i < n; i++) {
          const o = c.createOscillator();
          const gg = c.createGain();
          const s = t + i * 0.11;
          o.type = 'sine';
          o.frequency.setValueAtTime(base, s);
          o.frequency.exponentialRampToValueAtTime(base * 1.4, s + 0.06);
          gg.gain.setValueAtTime(0, s);
          gg.gain.linearRampToValueAtTime(0.05, s + 0.01);
          gg.gain.exponentialRampToValueAtTime(0.0005, s + 0.08);
          o.connect(gg).connect(this.ambBus);
          o.start(s);
          o.stop(s + 0.1);
        }
      }
      setTimeout(chirp, 2500 + Math.random() * 6000);
    };
    setTimeout(chirp, 2000);
  }
}
