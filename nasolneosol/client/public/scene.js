// 단순 3D 공간 + 임시 캐릭터 (기능 검증용). 최종 그래픽 자산이 아니다.
// 캐릭터는 고정 12종 규격(몸통·머리·헤어·소품)으로 코드에서 만든다.

import * as THREE from 'three';

const CHARS = {
  c01: { body: '#f4a259', hair: '#3b2a20', hairStyle: 'short', acc: 'none' },
  c02: { body: '#5b8e7d', hair: '#1f1b18', hairStyle: 'spiky', acc: 'glasses' },
  c03: { body: '#7c9cc4', hair: '#6b4226', hairStyle: 'short', acc: 'cap' },
  c04: { body: '#c97b63', hair: '#2b2b2b', hairStyle: 'side', acc: 'none' },
  c05: { body: '#8fb996', hair: '#4a3222', hairStyle: 'spiky', acc: 'headphones' },
  c06: { body: '#d6a2ad', hair: '#1a1a1a', hairStyle: 'side', acc: 'glasses' },
  c07: { body: '#f2c57c', hair: '#5a3825', hairStyle: 'long', acc: 'ribbon' },
  c08: { body: '#e98a8a', hair: '#2a1d16', hairStyle: 'bob', acc: 'none' },
  c09: { body: '#a99bd6', hair: '#3e2b22', hairStyle: 'long', acc: 'flower' },
  c10: { body: '#7fc8a9', hair: '#8a5a3b', hairStyle: 'bun', acc: 'none' },
  c11: { body: '#f6b48f', hair: '#1d1d1d', hairStyle: 'bob', acc: 'ribbon' },
  c12: { body: '#9fc5e8', hair: '#5b3b2a', hairStyle: 'bun', acc: 'flower' },
};

// 공간 배치 (x, z). 화면 위쪽이 -z
export const ZONES = {
  lounge: { x: 0, z: 1, r: 3.2, label: '공용 거실' },
  stage: { x: 0, z: -1.6, r: 0.1, label: '' },
  dorm_male: { x: -10, z: 1, r: 2.6, label: '남자 숙소' },
  dorm_female: { x: 10, z: 1, r: 2.6, label: '여자 숙소' },
};
const DATE_SPOTS = [
  { x: -11, z: -9 }, { x: -4, z: -10 }, { x: 4, z: -10 }, { x: 11, z: -9 }, { x: -7.5, z: -15 }, { x: 7.5, z: -15 },
];
DATE_SPOTS.forEach((s, i) => (ZONES[`date:${i}`] = { ...s, r: 1.6, label: '' }));

const SKIN = '#ffe0c7';

export class GameScene {
  constructor(canvas, { onTapCharacter, onTapFloor }) {
    this.canvas = canvas;
    this.onTapCharacter = onTapCharacter;
    this.onTapFloor = onTapFloor;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#f6efe4');
    this.scene.fog = new THREE.Fog('#f6efe4', 38, 70);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camLook = new THREE.Vector3(0, 0, 0);
    this.chars = new Map(); // pid → { group, target:Vector3, ring, label }
    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this.speaking = new Set();
    this.buildWorld();
    this.bindInput();
    this.resize();
    addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  buildWorld() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight('#fff8ee', '#c8b79e', 2.2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(6, 14, 8);
    s.add(sun);

    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    // 바깥 정원
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 60), mat('#bfd8b0'));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.name = 'floor';
    s.add(ground);
    this.floor = ground;
    // 숙소 건물 바닥 (나무)
    const house = new THREE.Mesh(new THREE.BoxGeometry(30, 0.2, 9), mat('#d9b48a'));
    house.position.set(0, -0.08, 1);
    s.add(house);
    // 방 구분 러그
    const rug = (x, c, w) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(w, w, 0.04, 40), mat(c));
      m.position.set(x, 0.03, 1);
      s.add(m);
    };
    rug(0, '#f3d9c4', 3.8);
    rug(-10, '#cddcf0', 3.1);
    rug(10, '#f5d2da', 3.1);
    // 벽 (낮게 — 위에서 보이도록)
    const wall = (x, z, w, d) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, d), mat('#efe2cf'));
      m.position.set(x, 0.45, z);
      s.add(m);
    };
    wall(0, 5.4, 30, 0.3);
    wall(-15, 1, 0.3, 9);
    wall(15, 1, 0.3, 9);
    wall(-5, 3.6, 0.3, 3.4);
    wall(5, 3.6, 0.3, 3.4);
    wall(-5, -1.6, 0.3, 3.4);
    wall(5, -1.6, 0.3, 3.4);
    // 소파·침대
    const box = (x, z, w, h, d, c) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c));
      m.position.set(x, h / 2, z);
      s.add(m);
    };
    box(0, 4.3, 4, 0.6, 1, '#e98a5d');
    box(-12.5, 3.8, 2, 0.4, 1.4, '#9fb7da');
    box(-8.5, 3.8, 2, 0.4, 1.4, '#9fb7da');
    box(12.5, 3.8, 2, 0.4, 1.4, '#eab0bd');
    box(8.5, 3.8, 2, 0.4, 1.4, '#eab0bd');
    // 발표 자리
    const stage = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1, 0.25, 32), mat('#f2c57c'));
    stage.position.set(ZONES.stage.x, 0.12, ZONES.stage.z);
    s.add(stage);
    // 데이트 장소: 벤치 + 작은 테이블
    for (const d of DATE_SPOTS) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.7, 20), mat('#fffaf2'));
      t.position.set(d.x, 0.35, d.z);
      s.add(t);
      const deck = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.06, 32), mat('#e4cfb0'));
      deck.position.set(d.x, 0.02, d.z);
      s.add(deck);
    }
    // 나무
    const tree = (x, z) => {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1, 8), mat('#8a6243'));
      trunk.position.set(x, 0.5, z);
      const top = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 10), mat('#7fb38a'));
      top.position.set(x, 1.5, z);
      s.add(trunk, top);
    };
    [[-16, -6], [0, -7], [16, -6], [-14, -14], [14, -14], [0, -15], [-19, 2], [19, 2]].forEach(([x, z]) => tree(x, z));
    // 공간 라벨
    for (const [k, z] of Object.entries(ZONES)) {
      if (!z.label) continue;
      const sp = textSprite(z.label, { size: 28, bg: 'rgba(255,250,242,.85)', color: '#8a7a6b' });
      sp.position.set(z.x, 0.1, z.z + z.r + 0.9);
      sp.scale.multiplyScalar(0.9);
      sp.userData.zone = k;
      s.add(sp);
    }
  }

  makeCharacter(p) {
    const c = CHARS[p.characterId] ?? CHARS.c01;
    const g = new THREE.Group();
    const lam = (col) => new THREE.MeshLambertMaterial({ color: col });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.35, 4, 12), lam(c.body));
    body.position.y = 0.52;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 16), lam(SKIN));
    head.position.y = 1.32;
    g.add(body, head);
    const hairMat = lam(c.hair);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.45, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2.1), hairMat);
    cap.position.y = 1.36;
    g.add(cap);
    if (c.hairStyle === 'long' || c.hairStyle === 'bob') {
      const back = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.4, c.hairStyle === 'long' ? 0.8 : 0.45, 16, 1, true, Math.PI * 0.6, Math.PI * 0.8), hairMat);
      back.material.side = THREE.DoubleSide;
      back.position.y = c.hairStyle === 'long' ? 1.05 : 1.2;
      g.add(back);
    }
    if (c.hairStyle === 'bun') {
      const bun = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 10), hairMat);
      bun.position.set(0, 1.82, 0.1);
      g.add(bun);
    }
    if (c.hairStyle === 'spiky') {
      for (let i = -1; i <= 1; i++) {
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.25, 6), hairMat);
        sp.position.set(i * 0.17, 1.8, 0.05);
        g.add(sp);
      }
    }
    // 눈 (카메라 쪽 +z)
    for (const x of [-0.14, 0.14]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), lam('#2a211b'));
      eye.position.set(x, 1.32, 0.39);
      g.add(eye);
    }
    const accMat = lam('#ffffff');
    if (c.acc === 'glasses') {
      const gl = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.015, 6, 16), lam('#3a2e25'));
      const gl2 = gl.clone();
      gl.position.set(-0.14, 1.32, 0.41);
      gl2.position.set(0.14, 1.32, 0.41);
      g.add(gl, gl2);
    } else if (c.acc === 'cap') {
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 16), lam(c.body));
      brim.position.set(0, 1.62, 0.3);
      g.add(brim);
    } else if (c.acc === 'ribbon') {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.04, 6, 12), lam('#e0849a'));
      r.position.set(0.3, 1.68, 0);
      g.add(r);
    } else if (c.acc === 'flower') {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), lam('#ffd166'));
      f.position.set(-0.32, 1.6, 0.1);
      g.add(f);
    } else if (c.acc === 'headphones') {
      const h = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.04, 6, 20, Math.PI), accMat);
      h.position.y = 1.36;
      g.add(h);
    }
    // 성별 링 + 발표/음성 표시 링
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.55, 28), new THREE.MeshBasicMaterial({ color: p.gender === 'male' ? '#6f95c9' : '#e0849a', transparent: true, opacity: 0.8 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    g.add(ring);
    const voiceRing = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.72, 28), new THREE.MeshBasicMaterial({ color: '#7fb38a', transparent: true, opacity: 0 }));
    voiceRing.rotation.x = -Math.PI / 2;
    voiceRing.position.y = 0.04;
    g.add(voiceRing);
    const label = textSprite(p.alias, { size: 34, bg: 'rgba(255,255,255,.92)', color: '#3a2e25' });
    label.position.y = 2.25;
    g.add(label);
    g.traverse((o) => (o.userData.pid = p.id));
    g.scale.setScalar(1.15);
    return { group: g, target: new THREE.Vector3(), voiceRing, label, ring };
  }

  /** 서버 상태 반영 */
  update(view) {
    this.meId = view.me.id;
    const ids = new Set(view.participants.map((p) => p.id));
    for (const [id, c] of this.chars) if (!ids.has(id)) {
      this.scene.remove(c.group);
      this.chars.delete(id);
    }
    // 같은 구역 사람끼리 자리를 나눈다
    const byZone = new Map();
    for (const p of view.participants) {
      const z = view.zones[p.id];
      if (!byZone.has(z)) byZone.set(z, []);
      byZone.get(z).push(p.id);
    }
    for (const p of view.participants) {
      let c = this.chars.get(p.id);
      if (!c) {
        c = this.makeCharacter(p);
        this.chars.set(p.id, c);
        this.scene.add(c.group);
        c.fresh = true;
      }
      const zone = view.zones[p.id];
      let pos;
      if (zone === 'free') {
        const sv = view.positions[p.id];
        pos = sv ? new THREE.Vector3(sv.x, 0, sv.z) : this.slot('lounge', p.id, view.participants.map((x) => x.id));
      } else {
        const audience = zone === 'lounge' && view.phase === 'selfIntro'; // 교대 시간에도 자리 유지
        pos = this.slot(zone, p.id, byZone.get(zone), audience);
      }
      c.target.copy(pos);
      if (c.fresh) {
        c.group.position.copy(pos);
        c.fresh = false;
      }
      c.group.visible = true;
      c.group.children.forEach((m) => m.material && (m.material.transparent = !p.connected, m.material.opacity = p.connected ? m.material.opacity : 0.45));
    }
    this.speaking = new Set(view.speakingIds);
    // 카메라: 내 위치 근처
    const myZone = view.zones[view.me.id];
    const focus = myZone === 'free' || myZone === 'stage' ? ZONES.lounge : ZONES[myZone] ?? ZONES.lounge;
    this.camTarget.set(focus.x, 0, focus.z);
    this.wide = myZone === 'free';
  }

  slot(zone, pid, members, audience = false) {
    const z = ZONES[zone] ?? ZONES.lounge;
    const i = members.indexOf(pid);
    const n = members.length;
    if (audience) {
      // 자기소개: 청중은 발표 자리 앞쪽에 두 줄 반원으로 앉는다
      const row = i % 2;
      const k = Math.floor(i / 2);
      const per = Math.ceil(n / 2);
      const a = Math.PI * (0.12 + (0.76 * (k + 0.5)) / per);
      const r = 2.6 + row * 1.3;
      return new THREE.Vector3(ZONES.stage.x + Math.cos(a) * r * 1.3, 0, ZONES.stage.z + Math.sin(a) * r);
    }
    if (n <= 1 || zone === 'stage') return new THREE.Vector3(z.x, zone === 'stage' ? 0.25 : 0, z.z);
    const r = Math.max(z.r * 0.6, 0.55 * n / Math.PI);
    const a = (i / n) * Math.PI * 2 + Math.PI / 2;
    return new THREE.Vector3(z.x + Math.cos(a) * r, 0, z.z + Math.sin(a) * r * 0.8);
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    for (const [id, c] of this.chars) {
      const g = c.group;
      const d = c.target.clone().sub(g.position);
      const dist = d.length();
      if (dist > 0.02) {
        g.position.addScaledVector(d, Math.min(1, dt * 4));
        g.position.y = c.target.y + Math.abs(Math.sin(t * 12)) * 0.08; // 걷는 통통 효과
      } else {
        g.position.y = c.target.y;
      }
      const sp = this.speaking.has(id);
      c.voiceRing.material.opacity = sp ? 0.5 + Math.sin(t * 6) * 0.4 : 0;
      c.label.material.opacity = 1;
      if (id === this.meId) c.ring.material.color.set('#e98a5d');
    }
    this.camLook.lerp(this.camTarget, Math.min(1, dt * 3));
    const aspect = this.camera.aspect;
    const dist = (this.wide ? 21 : 13) * (aspect < 0.8 ? 1.5 : 1);
    this.camera.position.set(this.camLook.x, dist * 0.85, this.camLook.z + dist * 0.75);
    this.camera.lookAt(this.camLook.x, 0, this.camLook.z - 1);
    this.renderer.render(this.scene, this.camera);
  }

  bindInput() {
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) return;
      const r = this.canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const groups = [...this.chars.values()].map((c) => c.group);
      const hit = this.raycaster.intersectObjects(groups, true)[0];
      if (hit) return this.onTapCharacter(hit.object.userData.pid);
      const fh = this.raycaster.intersectObject(this.floor)[0];
      if (fh) this.onTapFloor(fh.point.x, fh.point.z);
    });
  }
}

function textSprite(text, { size = 32, bg, color }) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `700 ${size}px sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  c.width = w;
  c.height = size + 16;
  ctx.font = `700 ${size}px sans-serif`;
  ctx.fillStyle = bg;
  const r = 12;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, c.height, r);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, c.height / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const h = 0.42;
  sp.scale.set((h * c.width) / c.height, h, 1);
  sp.renderOrder = 10;
  return sp;
}
