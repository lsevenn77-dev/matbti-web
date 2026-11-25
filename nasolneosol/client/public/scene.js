// 나솔너솔 3D 공간 (코드로 만든 저폴리 임시 자산)
// - 시안(따뜻한 저폴리 마을, SD 캐릭터) 방향을 따르되, 최종 3D 자산(GLB)이 오면 makeCharacter 만 교체한다.
// - 서버가 정한 구역(zone)에 따라 자리 배치, 자유 구경에서는 위치 동기화.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// ───────── 월드 배치 (화면 위쪽이 -z) ─────────
export const WORLD = { minX: -24, maxX: 24, minZ: -26, maxZ: 10 };
export const ZONES = {
  lounge: { x: 0, z: 0, r: 4, label: '자기소개 마당' },
  stage: { x: 0, z: 2.2, r: 0.1, label: '자기소개 마당' },
  dorm_male: { x: -14, z: 3.2, r: 2.4, label: '남자 숙소 앞' },
  dorm_female: { x: 14, z: 3.2, r: 2.4, label: '여자 숙소 앞' },
};
const DATE_SPOTS = [
  { x: -7, z: -11, label: '개울 벤치', kind: 'bench', rot: 0.35 },
  { x: 7, z: -11, label: '개울 벤치', kind: 'bench', rot: -0.35 },
  { x: 0, z: -15.6, label: '나무 다리', kind: 'bridge', rot: 0 },
  { x: -16, z: -17, label: '테라스', kind: 'table', rot: 0 },
  { x: 16, z: -17, label: '그네', kind: 'swing', rot: 0 },
  { x: 0, z: -22, label: '언덕 정원', kind: 'table', rot: 0 },
];
DATE_SPOTS.forEach((s, i) => (ZONES[`date:${i}`] = { x: s.x, z: s.z, r: 1.4, label: s.label }));

export function zoneLabel(zone) {
  if (zone === 'free') return '숙소 마을';
  return ZONES[zone]?.label ?? '숙소 마을';
}

// ───────── 캐릭터 12종 외형 (시안 시트 기준, 슬롯 순서 = 가명 순서) ─────────
const SKIN = '#f6c7a1';
const LOOKS = {
  c01: { hair: 'spiky', hairC: '#7a4a2a', top: 'hoodie', topC: '#f2b829', bottom: 'pants', botC: '#27355a' }, // 태양
  c02: { hair: 'round', hairC: '#232020', top: 'jacket', topC: '#26324f', inner: '#f4f1ea', bottom: 'pants', botC: '#a9a49c', glasses: true }, // 우주
  c03: { hair: 'flat', hairC: '#262220', top: 'vest', topC: '#6f8a5b', inner: '#f4f1ea', bottom: 'pants', botC: '#2f5a33', brows: 'thick' }, // 강산
  c04: { hair: 'cap', hairC: '#262220', hatC: '#5b93d6', top: 'tee', topC: '#6fa3e0', bottom: 'pants', botC: '#27355a' }, // 하늘
  c05: { hair: 'curly', hairC: '#2b2420', top: 'stripe', topC: '#1f8079', inner: '#f4f1ea', bottom: 'shorts', botC: '#d8c7a5', smile: 'closed' }, // 바다
  c06: { hair: 'beanie', hairC: '#3a2a22', hatC: '#a8533a', top: 'tee', topC: '#b9583f', bottom: 'pants', botC: '#7d7a4f' }, // 노을
  c07: { hair: 'bob', hairC: '#2a2422', clip: '#f3a3b8', top: 'pinafore', topC: '#8fb2df', inner: '#f8f5ef', bottom: 'dress', botC: '#8fb2df' }, // 이슬
  c08: { hair: 'long', hairC: '#8a5434', top: 'tee', topC: '#d07a74', bottom: 'dress', botC: '#d07a74' }, // 장미
  c09: { hair: 'ponytail', hairC: '#262220', top: 'zip', topC: '#b79be0', bottom: 'pants', botC: '#4a474a', brows: 'sharp' }, // 보라
  c10: { hair: 'short', hairC: '#262220', top: 'overall', topC: '#e8b33f', inner: '#e8b33f', bottom: 'pants', botC: '#6f8f4f', overallC: '#6f8f4f' }, // 나래
  c11: { hair: 'buns', hairC: '#7a4a2a', top: 'tee', topC: '#f1e6cf', bottom: 'skirt', botC: '#7c7f3e', glasses: true }, // 미소
  c12: { hair: 'bunvisor', hairC: '#262220', hatC: '#f5c93a', top: 'tee', topC: '#f8e08a', bottom: 'shorts', botC: '#3d63a5', smile: 'closed' }, // 여름
};

const matCache = new Map();
function M(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, flatShading: true, ...opts }));
  return matCache.get(key);
}
function mesh(geo, color, { cast = true, receive = false, ...opts } = {}) {
  const m = new THREE.Mesh(geo, typeof color === 'string' ? M(color, opts) : color);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

export class GameScene {
  constructor(canvas, { onTapCharacter, onTapFloor }) {
    this.canvas = canvas;
    this.onTapCharacter = onTapCharacter;
    this.onTapFloor = onTapFloor;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 220);
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camLook = new THREE.Vector3(0, 0, 4);
    this.chars = new Map();
    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this.speaking = new Set();
    this.localPos = null; // 자유 구경 중 내 예측 위치
    this.models = {}; // characterId → gltf (최종 3D 자산). 없으면 코드 캐릭터 사용
    this.buildWorld();
    this.bindInput();
    this.loadModels();
    this.resize();
    addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ───────── 월드 ─────────
  buildWorld() {
    const s = this.scene;
    // 하늘 그라데이션
    const sky = new THREE.Mesh(new THREE.SphereGeometry(160, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color('#5aa7ec') }, bottom: { value: new THREE.Color('#d9eefc') } },
      vertexShader: 'varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying float h; void main(){ gl_FragColor = vec4(mix(bottom, top, clamp(h*2.2,0.0,1.0)),1.0); }',
    }));
    s.add(sky);
    s.fog = new THREE.Fog('#d9eefc', 60, 140);

    s.add(new THREE.HemisphereLight('#fff6e8', '#7f9a62', 1.6));
    const sun = new THREE.DirectionalLight('#fff3dd', 2.4);
    sun.position.set(12, 22, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -22;
    sun.shadow.camera.right = 22;
    sun.shadow.camera.top = 22;
    sun.shadow.camera.bottom = -22;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.04;
    s.add(sun, sun.target);
    this.sun = sun;

    // 잔디
    const ground = mesh(new THREE.PlaneGeometry(220, 200, 1, 1), '#8fc163', { cast: false, receive: true });
    ground.rotation.x = -Math.PI / 2;
    ground.name = 'floor';
    s.add(ground);
    this.floor = ground;

    this.buildPath();
    this.buildHouse(-14, -2.5, '#3f5f97', '남자 숙소');
    this.buildHouse(14, -2.5, '#d9665a', '여자 숙소');
    this.buildPlaza();
    this.buildStream();
    DATE_SPOTS.forEach((d) => this.buildDateSpot(d));
    this.buildNature();
  }

  buildPath() {
    // 불규칙 돌판 깔기
    const rng = mulberry(7);
    const stoneGeo = new THREE.CylinderGeometry(0.5, 0.52, 0.08, 6);
    const pts = [];
    const line = (ax, az, bx, bz, w) => {
      const len = Math.hypot(bx - ax, bz - az);
      for (let t = 0; t < len; t += 0.75) {
        for (let k = -w; k <= w; k += 0.95) {
          const nx = -(bz - az) / len;
          const nz = (bx - ax) / len;
          pts.push([ax + ((bx - ax) * t) / len + nx * k + (rng() - 0.5) * 0.3, az + ((bz - az) * t) / len + nz * k + (rng() - 0.5) * 0.3]);
        }
      }
    };
    line(-14, 1.5, 0, 0, 1);
    line(14, 1.5, 0, 0, 1);
    line(0, -4.5, 0, -14, 0.9);
    line(0, -17, 0, -22, 0.9);
    line(0, -9, -7, -11, 0.5);
    line(0, -9, 7, -11, 0.5);
    line(0, -18, -16, -17, 0.6);
    line(0, -18, 16, -17, 0.6);
    // 광장 원
    for (let r = 0; r <= 5.2; r += 0.85) {
      const n = Math.max(1, Math.round((r * Math.PI * 2) / 0.9));
      for (let i = 0; i < n; i++) pts.push([Math.cos((i / n) * 6.28) * r + (rng() - 0.5) * 0.2, Math.sin((i / n) * 6.28) * r + (rng() - 0.5) * 0.2]);
    }
    const shades = ['#c9b8a6', '#bfae9b', '#d3c3b1', '#b8a795'];
    const inst = new THREE.InstancedMesh(stoneGeo, M('#ffffff'), pts.length);
    inst.receiveShadow = true;
    const m4 = new THREE.Matrix4();
    const c = new THREE.Color();
    pts.forEach(([x, z], i) => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6.28);
      const sc = 0.85 + rng() * 0.35;
      m4.compose(new THREE.Vector3(x, 0.03, z), q, new THREE.Vector3(sc, 1, sc));
      inst.setMatrixAt(i, m4);
      inst.setColorAt(i, c.set(shades[Math.floor(rng() * shades.length)]));
    });
    this.scene.add(inst);
    // 돌길 아래 흙 바탕
    const dirt = mesh(new THREE.CircleGeometry(5.6, 28), '#cdbba3', { cast: false, receive: true });
    dirt.rotation.x = -Math.PI / 2;
    dirt.position.y = 0.01;
    this.scene.add(dirt);
  }

  buildHouse(x, z, roofC, sign) {
    const g = new THREE.Group();
    const W = 9;
    const D = 5;
    const H = 2.8;
    const base = mesh(new THREE.BoxGeometry(W + 0.4, 0.3, D + 0.4), '#a9a39a', { receive: true });
    base.position.y = 0.15;
    const wall = mesh(new THREE.BoxGeometry(W, H, D), '#f4e6cc', { receive: true });
    wall.position.y = 0.3 + H / 2;
    g.add(base, wall);
    // 기둥·보
    for (const px of [-W / 2, -1.3, 1.3, W / 2]) {
      const p = mesh(new THREE.BoxGeometry(0.28, H, 0.28), '#a8693a');
      p.position.set(px, 0.3 + H / 2, D / 2 + 0.05);
      g.add(p);
    }
    const beam = mesh(new THREE.BoxGeometry(W + 0.3, 0.28, 0.32), '#a8693a');
    beam.position.set(0, 0.3 + H, D / 2 + 0.05);
    g.add(beam);
    // 지붕 (박공)
    const roofShape = new THREE.Shape();
    roofShape.moveTo(-D / 2 - 0.9, 0);
    roofShape.lineTo(0, 1.9);
    roofShape.lineTo(D / 2 + 0.9, 0);
    roofShape.lineTo(-D / 2 - 0.9, 0);
    const roof = mesh(new THREE.ExtrudeGeometry(roofShape, { depth: W + 1.4, bevelEnabled: false }), roofC);
    roof.rotation.y = Math.PI / 2;
    roof.position.set(-(W + 1.4) / 2, 0.3 + H, 0);
    g.add(roof);
    // 문
    const door = mesh(new THREE.BoxGeometry(1.8, 2.1, 0.12), '#b0703c');
    door.position.set(0, 0.3 + 1.05, D / 2 + 0.06);
    const doorLine = mesh(new THREE.BoxGeometry(0.04, 2.0, 0.14), '#7d4c27');
    doorLine.position.copy(door.position);
    g.add(door, doorLine);
    // 창문
    for (const wx of [-3.2, 3.2]) {
      const frame = mesh(new THREE.BoxGeometry(1.7, 1.2, 0.1), '#5a3d28');
      frame.position.set(wx, 1.9, D / 2 + 0.06);
      const glass = mesh(new THREE.BoxGeometry(1.45, 0.95, 0.12), '#a9d2ea', { roughness: 0.3 });
      glass.position.copy(frame.position);
      g.add(frame, glass);
    }
    // 간판
    const signTex = labelTexture(sign, { size: 64, bg: '#6b4428', color: '#fbeedd', pad: 26, radius: 14 });
    const signM = new THREE.Mesh(new THREE.PlaneGeometry(2.2, (2.2 * signTex.image.height) / signTex.image.width), new THREE.MeshBasicMaterial({ map: signTex, transparent: true }));
    signM.position.set(0, 2.85, D / 2 + 0.22);
    g.add(signM);
    // 등
    for (const lx of [-1.3, 1.3]) {
      const lamp = mesh(new THREE.BoxGeometry(0.3, 0.45, 0.3), '#fff1c9', { emissive: '#ffd27a', emissiveIntensity: 0.6 });
      lamp.position.set(lx, 2.1, D / 2 + 0.3);
      g.add(lamp);
    }
    // 화단
    for (const fx of [-3.4, 3.4]) {
      const box = mesh(new THREE.BoxGeometry(2.2, 0.5, 0.8), '#a8693a');
      box.position.set(fx, 0.25, D / 2 + 1.1);
      g.add(box);
      for (let i = -1; i <= 1; i++) {
        const b = mesh(new THREE.IcosahedronGeometry(0.42, 0), '#5e9d4a');
        b.position.set(fx + i * 0.6, 0.7, D / 2 + 1.1);
        g.add(b);
      }
    }
    g.position.set(x, 0, z);
    g.traverse((o) => {
      if (o.material) {
        o.material = o.material.clone();
        o.material.transparent = true;
      }
    });
    this.scene.add(g);
    (this.houses ??= []).push({ g, x, z, minX: x - W / 2 - 0.6, maxX: x + W / 2 + 0.6, minZ: z - D / 2 - 0.6, maxZ: z + D / 2 + 0.4, fade: 1 });
  }

  buildPlaza() {
    // 자기소개용 의자 반원 (12석)
    this.chairs = [];
    for (let i = 0; i < 12; i++) {
      const a = Math.PI * (0.06 + (0.88 * i) / 11);
      const x = -Math.cos(a) * 4.6;
      const z = 1.6 - Math.sin(a) * 3.4;
      const ch = new THREE.Group();
      const seat = mesh(new THREE.BoxGeometry(0.7, 0.1, 0.65), '#a8693a');
      seat.position.y = 0.45;
      const back = mesh(new THREE.BoxGeometry(0.7, 0.6, 0.08), '#a8693a');
      back.position.set(0, 0.8, 0.3);
      ch.add(seat, back);
      for (const [lx, lz] of [[-0.3, -0.27], [0.3, -0.27], [-0.3, 0.27], [0.3, 0.27]]) {
        const leg = mesh(new THREE.BoxGeometry(0.07, 0.45, 0.07), '#8a5530');
        leg.position.set(lx, 0.22, lz);
        ch.add(leg);
      }
      ch.position.set(x, 0, z);
      ch.rotation.y = Math.atan2(0 - x, 2.2 - z) + Math.PI;
      this.scene.add(ch);
      this.chairs.push({ x, z });
    }
    // 이정표
    const post = mesh(new THREE.BoxGeometry(0.18, 2.2, 0.18), '#8a5530');
    post.position.set(5.6, 1.1, -4);
    this.scene.add(post);
    ['개울 · 다리 →', '테라스 · 그네 →'].forEach((t, i) => {
      const tex = labelTexture(t, { size: 40, bg: '#c58a52', color: '#fff8ec', pad: 14, radius: 6 });
      const sgn = new THREE.Mesh(new THREE.PlaneGeometry(1.7, (1.7 * tex.image.height) / tex.image.width), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      sgn.position.set(5.6, 1.85 - i * 0.5, -3.88);
      this.scene.add(sgn);
    });
    // 가로등
    for (const [x, z] of [[-5.5, -3], [5.5, 2.5], [-5.5, 2.5], [-2, -9], [2, -9], [-2, -19], [2, -19], [-9, 1.2], [9, 1.2]]) this.lampPost(x, z);
  }

  lampPost(x, z) {
    const p = mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.8, 6), '#3c3530');
    p.position.set(x, 0.9, z);
    const head = mesh(new THREE.BoxGeometry(0.32, 0.4, 0.32), '#fff2c6', { emissive: '#ffd27a', emissiveIntensity: 0.5 });
    head.position.set(x, 1.95, z);
    const cap = mesh(new THREE.ConeGeometry(0.28, 0.2, 4), '#3c3530');
    cap.position.set(x, 2.25, z);
    cap.rotation.y = Math.PI / 4;
    this.scene.add(p, head, cap);
  }

  buildStream() {
    // 굽이치는 개울 (z ≈ -15 근처)
    const pts = [];
    for (let x = -40; x <= 40; x += 2) pts.push(new THREE.Vector3(x, 0.02, -15.6 + Math.sin(x * 0.18) * 1.6));
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.BufferGeometry();
    const pos = [];
    const N = 120;
    for (let i = 0; i < N; i++) {
      const a = curve.getPoint(i / N);
      const b = curve.getPoint((i + 1) / N);
      const w = 1.5;
      pos.push(a.x, 0.04, a.z - w, b.x, 0.04, b.z - w, a.x, 0.04, a.z + w, b.x, 0.04, b.z - w, b.x, 0.04, b.z + w, a.x, 0.04, a.z + w);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const water = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#4c9ee8', roughness: 0.25, metalness: 0.05, side: THREE.DoubleSide }));
    water.receiveShadow = true;
    this.scene.add(water);
    this.water = water;
    // 돌 둑
    const rng = mulberry(11);
    for (let i = 0; i < 70; i++) {
      const t = i / 70;
      const p = curve.getPoint(t);
      for (const side of [-1, 1]) {
        if (Math.abs(p.x) < 1.8) continue;
        const r = mesh(new THREE.DodecahedronGeometry(0.35 + rng() * 0.3, 0), rng() < 0.5 ? '#9a9a96' : '#a9a7a1', { receive: true });
        r.position.set(p.x + (rng() - 0.5) * 0.6, 0.12, p.z + side * (1.75 + rng() * 0.3));
        r.scale.y = 0.55;
        r.rotation.set(rng(), rng() * 6, rng());
        this.scene.add(r);
      }
    }
  }

  buildDateSpot(d) {
    const g = new THREE.Group();
    if (d.kind === 'bench' || d.kind === 'swing') {
      const seat = mesh(new THREE.BoxGeometry(2.4, 0.12, 0.7), '#a8693a');
      seat.position.y = 0.5;
      const back = mesh(new THREE.BoxGeometry(2.4, 0.5, 0.1), '#a8693a');
      back.position.set(0, 0.85, -0.32);
      g.add(seat, back);
      for (const lx of [-1, 1]) {
        const leg = mesh(new THREE.BoxGeometry(0.12, 0.5, 0.6), '#7d4c27');
        leg.position.set(lx, 0.25, 0);
        g.add(leg);
      }
      if (d.kind === 'swing') {
        seat.position.y = 0.6;
        back.position.y = 0.95;
        for (const lx of [-1.5, 1.5]) {
          const pole = mesh(new THREE.BoxGeometry(0.16, 3, 0.16), '#7d4c27');
          pole.position.set(lx, 1.5, -0.1);
          g.add(pole);
        }
        const top = mesh(new THREE.BoxGeometry(3.3, 0.18, 0.2), '#7d4c27');
        top.position.set(0, 3, -0.1);
        g.add(top);
      }
    } else if (d.kind === 'bridge') {
      const deck = mesh(new THREE.BoxGeometry(3, 0.2, 4.2), '#b37643');
      deck.position.y = 0.45;
      g.add(deck);
      for (const lx of [-1.45, 1.45]) {
        const rail = mesh(new THREE.BoxGeometry(0.1, 0.1, 4.2), '#8a5530');
        rail.position.set(lx, 1.15, 0);
        g.add(rail);
        for (let k = -2; k <= 2; k++) {
          const p = mesh(new THREE.BoxGeometry(0.14, 0.75, 0.14), '#8a5530');
          p.position.set(lx, 0.8, k);
          g.add(p);
        }
      }
    } else {
      const deck = mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.15, 8), '#c79b6a', { receive: true });
      deck.position.y = 0.07;
      const top = mesh(new THREE.CylinderGeometry(0.65, 0.65, 0.08, 10), '#fff8ec');
      top.position.y = 0.78;
      const leg = mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.7, 6), '#7d4c27');
      leg.position.y = 0.4;
      g.add(deck, top, leg);
      for (let k = 0; k < 6; k++) {
        const pot = mesh(new THREE.IcosahedronGeometry(0.28, 0), k % 2 ? '#f2a585' : '#6faa4d');
        pot.position.set(Math.cos(k * 1.05) * 2.2, 0.3, Math.sin(k * 1.05) * 2.2 - 0.4);
        if (Math.sin(k * 1.05) > 0.3) continue; // 카메라 쪽은 비워 둔다
        g.add(pot);
      }
    }
    g.position.set(d.x, 0, d.z - (d.kind === 'bench' || d.kind === 'swing' ? 0.6 : 0));
    g.rotation.y = d.rot;
    this.scene.add(g);
  }

  buildNature() {
    const rng = mulberry(3);
    const tree = (x, z, s = 1) => {
      const g = new THREE.Group();
      const trunk = mesh(new THREE.CylinderGeometry(0.18 * s, 0.28 * s, 1.6 * s, 6), '#7a5232');
      trunk.position.y = 0.8 * s;
      g.add(trunk);
      const greens = ['#6faa4d', '#7fb85a', '#5f9b43'];
      for (let k = 0; k < 3; k++) {
        const leaf = mesh(new THREE.IcosahedronGeometry((0.95 + rng() * 0.4) * s, 0), greens[k % 3]);
        leaf.position.set((rng() - 0.5) * 0.9 * s, (1.9 + k * 0.55) * s, (rng() - 0.5) * 0.9 * s);
        leaf.rotation.set(rng(), rng(), rng());
        g.add(leaf);
      }
      g.position.set(x, 0, z);
      this.scene.add(g);
    };
    const spots = [[-22, -6], [-20, 6], [22, -6], [20, 6], [-9, -6], [9, -6], [-12, -12], [12, -12], [-24, -14], [24, -14],
      [-6, -20], [6, -20], [-11, -23], [11, -23], [-20, -24], [20, -24], [-4, -27], [4, -27], [-26, 0], [26, 0], [-7, 8], [7, 8]];
    for (const [x, z] of spots) tree(x + (rng() - 0.5) * 1.5, z + (rng() - 0.5) * 1.5, 0.9 + rng() * 0.5);
    for (let i = 0; i < 40; i++) {
      const x = (rng() - 0.5) * 56;
      const z = -30 + rng() * 42;
      if (Math.hypot(x, z) < 7 || Math.abs(z + 15.6) < 3) continue;
      const b = mesh(new THREE.IcosahedronGeometry(0.35 + rng() * 0.35, 0), rng() < 0.5 ? '#5e9d4a' : '#6faa4d');
      b.position.set(x, 0.25, z);
      b.scale.y = 0.75;
      this.scene.add(b);
    }
    // 울타리
    for (let x = -30; x <= 30; x += 2.2) {
      if (Math.abs(x) < 1.6) continue;
      const p = mesh(new THREE.BoxGeometry(0.14, 0.9, 0.14), '#8a5530');
      p.position.set(x, 0.45, -28);
      this.scene.add(p);
    }
    const rail = mesh(new THREE.BoxGeometry(60, 0.1, 0.1), '#8a5530');
    rail.position.set(0, 0.7, -28);
    this.scene.add(rail);
    // 먼 언덕·구름
    for (const [x, z, r, c] of [[-40, -60, 22, '#86b27a'], [0, -70, 28, '#79a86f'], [42, -62, 24, '#86b27a'], [-70, -40, 20, '#8cb880'], [70, -40, 20, '#8cb880']]) {
      const h = mesh(new THREE.ConeGeometry(r, r * 0.55, 7), c, { cast: false });
      h.position.set(x, r * 0.2, z);
      this.scene.add(h);
    }
    this.clouds = [];
    for (let i = 0; i < 6; i++) {
      const cl = new THREE.Group();
      for (let k = 0; k < 4; k++) {
        const p = mesh(new THREE.IcosahedronGeometry(1.4 + rng(), 0), '#ffffff', { cast: false, emissive: '#ffffff', emissiveIntensity: 0.35 });
        p.position.set(k * 1.6 - 2.4, rng() * 0.6, rng());
        p.scale.y = 0.6;
        cl.add(p);
      }
      cl.position.set(-60 + i * 22, 24 + rng() * 6, -50 - rng() * 20);
      this.scene.add(cl);
      this.clouds.push(cl);
    }
  }

  // ───────── 캐릭터 ─────────
  makeCharacter(p) {
    const L = LOOKS[p.characterId] ?? LOOKS.c01;
    const root = new THREE.Group();
    const body = new THREE.Group(); // 앉기·통통 효과용
    root.add(body);
    const female = ['dress', 'skirt'].includes(L.bottom);

    // 다리
    const legs = [];
    for (const sx of [-0.15, 0.15]) {
      const leg = new THREE.Group();
      leg.position.set(sx, 0.62, 0);
      const bare = L.bottom === 'shorts' || L.bottom === 'dress' || L.bottom === 'skirt';
      const thigh = mesh(new THREE.CylinderGeometry(0.12, 0.11, 0.44, 7), bare ? SKIN : L.botC);
      thigh.position.y = -0.22;
      leg.add(thigh);
      if (L.bottom === 'shorts') {
        const sh = mesh(new THREE.CylinderGeometry(0.15, 0.14, 0.22, 7), L.botC);
        sh.position.y = -0.08;
        leg.add(sh);
      }
      const shoe = mesh(new THREE.SphereGeometry(0.16, 8, 6), '#f3ede0');
      shoe.scale.set(1, 0.6, 1.35);
      shoe.position.set(0, -0.47, 0.05);
      leg.add(shoe);
      body.add(leg);
      legs.push(leg);
    }
    // 몸통
    const torso = mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.55, 8), L.topC);
    torso.position.y = 0.92;
    body.add(torso);
    if (L.bottom === 'pants' || L.bottom === 'shorts') {
      const hip = mesh(new THREE.CylinderGeometry(0.34, 0.33, 0.14, 8), L.botC);
      hip.position.y = 0.64;
      body.add(hip);
    }
    if (L.bottom === 'dress' || L.bottom === 'skirt') {
      const skirt = mesh(new THREE.CylinderGeometry(0.3, L.bottom === 'dress' ? 0.5 : 0.46, 0.42, 8), L.botC);
      skirt.position.y = L.bottom === 'dress' ? 0.58 : 0.55;
      body.add(skirt);
    }
    const front = (geo, color, y, z = 0.31) => {
      const m = mesh(geo, color);
      m.position.set(0, y, z);
      body.add(m);
      return m;
    };
    if (L.top === 'hoodie') {
      const hood = mesh(new THREE.TorusGeometry(0.26, 0.09, 6, 10), L.topC);
      hood.position.set(0, 1.18, -0.1);
      hood.rotation.x = Math.PI / 2.4;
      body.add(hood);
      front(new THREE.BoxGeometry(0.02, 0.18, 0.02), '#d99a12', 1.08, 0.33);
    }
    if (L.top === 'jacket') front(new THREE.BoxGeometry(0.2, 0.5, 0.06), L.inner, 0.94, 0.3);
    if (L.top === 'vest') {
      torso.material = M(L.inner);
      const v = mesh(new THREE.CylinderGeometry(0.32, 0.375, 0.48, 8, 1, true, 0.45, Math.PI * 2 - 0.9), L.topC);
      v.material = M(L.topC, { side: THREE.DoubleSide });
      v.position.y = 0.9;
      body.add(v);
    }
    if (L.top === 'stripe') {
      const band = mesh(new THREE.CylinderGeometry(0.335, 0.345, 0.1, 8), L.inner);
      band.position.y = 0.95;
      body.add(band);
    }
    if (L.top === 'pinafore') {
      torso.material = M(L.inner);
      front(new THREE.BoxGeometry(0.3, 0.3, 0.06), L.topC, 0.88, 0.32);
    }
    if (L.top === 'overall') {
      front(new THREE.BoxGeometry(0.34, 0.3, 0.06), L.overallC, 0.86, 0.32);
      for (const sx of [-0.12, 0.12]) {
        const strap = mesh(new THREE.BoxGeometry(0.05, 0.3, 0.05), L.overallC);
        strap.position.set(sx, 1.08, 0.3);
        body.add(strap);
      }
    }
    if (L.top === 'zip') front(new THREE.BoxGeometry(0.02, 0.5, 0.02), '#8f74bd', 0.93, 0.34);

    // 팔
    const arms = [];
    for (const sx of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(sx * 0.36, 1.12, 0);
      const sleeve = mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.3, 6), L.top === 'pinafore' ? L.inner : L.topC);
      sleeve.position.y = -0.14;
      const hand = mesh(new THREE.SphereGeometry(0.1, 7, 5), SKIN);
      hand.position.y = -0.36;
      arm.add(sleeve, hand);
      arm.rotation.z = sx * 0.18;
      body.add(arm);
      arms.push(arm);
    }

    // 머리
    const head = new THREE.Group();
    head.position.y = 1.62;
    body.add(head);
    const skull = mesh(new THREE.IcosahedronGeometry(0.52, 1), SKIN);
    skull.scale.set(1.08, 0.98, 1);
    head.add(skull);
    for (const sx of [-1, 1]) {
      const ear = mesh(new THREE.SphereGeometry(0.09, 6, 5), SKIN);
      ear.position.set(sx * 0.55, -0.02, 0);
      head.add(ear);
    }
    // 얼굴
    const eyeMat = '#2a2320';
    for (const sx of [-0.17, 0.17]) {
      if (L.smile === 'closed') {
        const e = mesh(new THREE.TorusGeometry(0.055, 0.018, 4, 8, Math.PI), eyeMat, { cast: false });
        e.position.set(sx, 0.02, 0.5);
        head.add(e);
      } else {
        const e = mesh(new THREE.SphereGeometry(0.06, 8, 6), eyeMat, { cast: false });
        e.scale.set(0.85, 1.25, 0.5);
        e.position.set(sx, 0.02, 0.49);
        head.add(e);
        const hl = mesh(new THREE.SphereGeometry(0.018, 5, 4), '#ffffff', { cast: false });
        hl.position.set(sx + 0.02, 0.06, 0.52);
        head.add(hl);
      }
      const brow = mesh(new THREE.BoxGeometry(L.brows === 'thick' ? 0.16 : 0.12, L.brows === 'thick' ? 0.04 : 0.025, 0.02), eyeMat, { cast: false });
      brow.position.set(sx, 0.17, 0.48);
      brow.rotation.z = (L.brows === 'sharp' || L.hair === 'spiky' ? -0.3 : 0.1) * Math.sign(sx);
      head.add(brow);
    }
    const mouth = mesh(new THREE.TorusGeometry(0.07, 0.018, 4, 8, Math.PI), '#7a3528', { cast: false });
    mouth.rotation.z = Math.PI;
    mouth.position.set(0, -0.16, 0.48);
    head.add(mouth);
    for (const sx of [-0.3, 0.3]) {
      const blush = mesh(new THREE.CircleGeometry(0.06, 8), '#f4a99a', { cast: false, transparent: true, opacity: 0.6 });
      blush.position.set(sx, -0.08, 0.47);
      head.add(blush);
    }
    if (L.glasses) {
      for (const sx of [-0.17, 0.17]) {
        const ring = mesh(new THREE.TorusGeometry(0.1, 0.018, 5, 14), '#2a2320', { cast: false });
        ring.position.set(sx, 0.02, 0.52);
        head.add(ring);
      }
      const bridge = mesh(new THREE.BoxGeometry(0.12, 0.02, 0.02), '#2a2320', { cast: false });
      bridge.position.set(0, 0.04, 0.53);
      head.add(bridge);
    }
    this.addHair(head, L);

    // 바닥 링 (성별 / 나) + 말하는 표시
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.6, 28), new THREE.MeshBasicMaterial({ color: p.gender === 'male' ? '#6f95c9' : '#e0849a', transparent: true, opacity: 0.75, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    root.add(ring);
    const voiceRing = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.82, 28), new THREE.MeshBasicMaterial({ color: '#59c27a', transparent: true, opacity: 0, depthWrite: false }));
    voiceRing.rotation.x = -Math.PI / 2;
    voiceRing.position.y = 0.07;
    root.add(voiceRing);
    const label = labelSprite(p.alias);
    label.position.y = 2.65;
    root.add(label);

    root.traverse((o) => (o.userData.pid = p.id));
    root.scale.setScalar(1.05);
    void female;
    return { group: root, body, legs, arms, head, target: new THREE.Vector3(), face: 0, voiceRing, ring, label, sit: false, phase: Math.random() * 6 };
  }

  addHair(head, L) {
    const c = L.hairC;
    const cap = (s = 1.06, cut = 2.05) => {
      const m = mesh(new THREE.SphereGeometry(0.54 * s, 10, 7, 0, Math.PI * 2, 0, Math.PI / cut), c);
      m.position.y = 0.04;
      m.rotation.x = -0.25;
      head.add(m);
      return m;
    };
    switch (L.hair) {
      case 'spiky':
        cap();
        for (let i = 0; i < 7; i++) {
          const sp = mesh(new THREE.ConeGeometry(0.14, 0.38, 5), c);
          const a = (i / 7) * Math.PI * 2;
          sp.position.set(Math.cos(a) * 0.28, 0.48, Math.sin(a) * 0.24 - 0.02);
          sp.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6);
          head.add(sp);
        }
        break;
      case 'round': {
        const m = cap(1.12, 1.8);
        m.scale.set(1.05, 1.05, 1.05);
        break;
      }
      case 'flat': {
        const t = mesh(new THREE.BoxGeometry(1.0, 0.32, 0.95), c);
        t.position.set(0, 0.42, -0.04);
        head.add(t);
        cap(1.04, 2.3);
        break;
      }
      case 'cap': {
        cap(1.04, 2.2);
        const dome = mesh(new THREE.SphereGeometry(0.58, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.2), L.hatC);
        dome.position.y = 0.1;
        head.add(dome);
        const brim = mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.05, 10, 1, false, -Math.PI / 2, Math.PI), L.hatC);
        brim.position.set(0, 0.2, 0.42);
        brim.rotation.x = 0.12;
        head.add(brim);
        break;
      }
      case 'curly':
        cap(1.05, 2.1);
        for (let i = 0; i < 10; i++) {
          const b = mesh(new THREE.IcosahedronGeometry(0.17, 0), c);
          const a = (i / 10) * Math.PI * 2;
          b.position.set(Math.cos(a) * 0.36, 0.38 + (i % 2) * 0.08, Math.sin(a) * 0.32);
          head.add(b);
        }
        break;
      case 'beanie': {
        cap(1.03, 2.4);
        const hat = mesh(new THREE.SphereGeometry(0.6, 10, 7, 0, Math.PI * 2, 0, Math.PI / 2), L.hatC);
        hat.position.y = 0.1;
        hat.scale.y = 1.05;
        const fold = mesh(new THREE.CylinderGeometry(0.61, 0.61, 0.16, 12), L.hatC);
        fold.position.y = 0.14;
        head.add(hat, fold);
        break;
      }
      case 'bob': {
        cap(1.1, 1.9);
        const back = mesh(new THREE.CylinderGeometry(0.6, 0.58, 0.62, 10, 1, true, Math.PI * 0.55, Math.PI * 0.9), c);
        back.material = M(c, { side: THREE.DoubleSide });
        back.position.y = -0.12;
        head.add(back);
        const clip = mesh(new THREE.BoxGeometry(0.2, 0.07, 0.05), L.clip);
        clip.position.set(0.3, 0.3, 0.42);
        clip.rotation.z = 0.5;
        head.add(clip);
        break;
      }
      case 'long': {
        cap(1.1, 1.9);
        const back = mesh(new THREE.BoxGeometry(1.05, 1.0, 0.4), c);
        back.position.set(0, -0.25, -0.28);
        head.add(back);
        for (const sx of [-0.5, 0.5]) {
          const side = mesh(new THREE.BoxGeometry(0.16, 0.8, 0.4), c);
          side.position.set(sx, -0.2, 0.05);
          head.add(side);
        }
        break;
      }
      case 'ponytail': {
        cap(1.08, 2);
        const tail = mesh(new THREE.ConeGeometry(0.22, 0.95, 7), c);
        tail.position.set(0.1, 0.25, -0.62);
        tail.rotation.x = -2.6;
        head.add(tail);
        break;
      }
      case 'short': {
        cap(1.1, 1.85);
        break;
      }
      case 'buns':
        cap(1.08, 2);
        for (const sx of [-0.36, 0.36]) {
          const b = mesh(new THREE.IcosahedronGeometry(0.2, 1), c);
          b.position.set(sx, 0.5, -0.05);
          head.add(b);
        }
        break;
      case 'bunvisor': {
        cap(1.06, 2);
        const bun = mesh(new THREE.IcosahedronGeometry(0.22, 1), c);
        bun.position.set(0, 0.62, -0.12);
        head.add(bun);
        const band = mesh(new THREE.CylinderGeometry(0.57, 0.57, 0.1, 12), L.hatC);
        band.position.y = 0.18;
        head.add(band);
        const visor = mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 10, 1, false, -Math.PI / 2, Math.PI), L.hatC);
        visor.position.set(0, 0.2, 0.45);
        visor.rotation.x = 0.15;
        head.add(visor);
        break;
      }
    }
  }

  // ───────── GLB 캐릭터 (있으면 코드 캐릭터 대신 사용) ─────────
  async loadModels() {
    let manifest = {};
    try {
      manifest = await fetch('/models/manifest.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {}));
    } catch { /* 모델 없음 */ }
    const loader = new GLTFLoader();
    await Promise.all(Object.entries(manifest).map(async ([cid, url]) => {
      try {
        this.models[cid] = await loader.loadAsync(url);
        for (const c of this.chars.values()) if (c.characterId === cid) this.attachModel(c);
      } catch (e) {
        console.warn('model load failed', cid, e);
      }
    }));
  }

  attachModel(c) {
    const gltf = this.models[c.characterId];
    if (!gltf || c.model) return;
    const model = SkeletonUtils.clone(gltf.scene);
    // 높이를 코드 캐릭터와 비슷하게(약 2.3) 맞추고 발을 바닥에
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const k = 2.3 / Math.max(size.y, 0.001);
    model.scale.setScalar(k);
    const box2 = new THREE.Box3().setFromObject(model);
    const center = box2.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box2.min.y, -center.z);
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.frustumCulled = false;
      }
      o.userData.pid = c.pid;
    });
    const wrap = new THREE.Group();
    wrap.add(model);
    c.group.add(wrap);
    c.body.visible = false;
    c.model = wrap;
    // 뼈대가 있으면 다리·팔 뼈를 찾아 걷기 흔들기에 사용
    const bones = [];
    model.traverse((o) => o.isBone && bones.push(o));
    const find = (re, not) => bones.find((b) => re.test(b.name) && !(not && not.test(b.name)));
    const L = (side) => new RegExp(`(^|[^a-z])(${side}|${side[0]}[_.]?)`, 'i');
    const pick = (side, re, not) => bones.find((b) => L(side).test(b.name) && re.test(b.name) && !(not && not.test(b.name))) ?? find(new RegExp(`${side}.*${re.source}`, 'i'), not);
    const legs = ['left', 'right'].map((sd) => pick(sd, /(up.?leg|thigh|upperleg)/i)).filter(Boolean);
    const arms = ['left', 'right'].map((sd) => pick(sd, /(arm|upperarm)/i, /(fore|lower|hand)/i)).filter(Boolean);
    c.boneLegs = legs.map((b) => ({ b, rest: b.quaternion.clone() }));
    c.boneArms = arms.map((b) => ({ b, rest: b.quaternion.clone() }));
    if (gltf.animations?.length) {
      c.mixer = new THREE.AnimationMixer(model);
      c.clips = gltf.animations;
    }
    console.info('model attached', c.characterId, 'bones', bones.length, 'legs', legs.map((b) => b.name), 'arms', arms.map((b) => b.name), 'clips', gltf.animations.map((a) => a.name));
  }

  // ───────── 서버 상태 반영 ─────────
  update(view) {
    this.meId = view.me.id;
    this.phase = view.phase;
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
        c.characterId = p.characterId;
        c.pid = p.id;
        this.chars.set(p.id, c);
        this.scene.add(c.group);
        c.fresh = true;
        this.attachModel(c);
      }
      const zone = view.zones[p.id];
      c.sit = false;
      c.lookAt = null;
      let pos;
      if (zone === 'free') {
        const sv = p.id === this.meId && this.localPos ? this.localPos : view.positions[p.id];
        pos = sv ? new THREE.Vector3(sv.x, 0, sv.z) : this.circle(ZONES.lounge, view.participants.map((x) => x.id).indexOf(p.id), view.participants.length);
        if (p.id === this.meId && !this.localPos) this.localPos = { x: pos.x, z: pos.z };
      } else if (view.phase === 'selfIntro' && zone === 'lounge') {
        // 자기소개: 청중은 의자에 앉는다
        const order = view.intro?.order ?? view.participants.map((x) => x.id);
        const seatIdx = order.indexOf(p.id);
        const ch = this.chairs[seatIdx % 12];
        pos = new THREE.Vector3(ch.x, 0, ch.z);
        c.sit = true;
        c.lookAt = new THREE.Vector3(ZONES.stage.x, 0, ZONES.stage.z);
      } else if (zone === 'stage') {
        pos = new THREE.Vector3(ZONES.stage.x, 0, ZONES.stage.z);
        c.lookAt = new THREE.Vector3(0, 0, 30); // 발표자는 카메라(앞)를 본다
      } else {
        const members = byZone.get(zone);
        pos = this.circle(ZONES[zone] ?? ZONES.lounge, members.indexOf(p.id), members.length);
        const z = ZONES[zone] ?? ZONES.lounge;
        if (members.length > 1) c.lookAt = new THREE.Vector3(z.x, 0, z.z);
      }
      if (zone !== 'free' && p.id === this.meId) this.localPos = null;
      c.target.copy(pos);
      if (c.fresh) {
        c.group.position.copy(pos);
        c.fresh = false;
      }
      c.connected = p.connected;
      c.ring.material.color.set(p.id === this.meId ? '#f08a3c' : p.gender === 'male' ? '#6f95c9' : '#e0849a');
      c.ring.material.opacity = p.id === this.meId ? 1 : 0.6;
    }
    this.speaking = new Set(view.speakingIds);
    const myZone = view.zones[view.me.id];
    this.freeRoam = myZone === 'free';
    this.myZone = myZone;
    if (!this.freeRoam) {
      const f = myZone === 'stage' || view.phase === 'selfIntro' ? { x: 0, z: 1.2 } : ZONES[myZone] ?? ZONES.lounge;
      this.camTarget.set(f.x, 0, f.z);
    }
    this.closeUp = view.phase.startsWith('date') && !!view.myDate;
  }

  setRemotePos(id, x, z) {
    const c = this.chars.get(id);
    if (c && id !== this.meId) c.target.set(x, 0, z);
  }

  /** 조이스틱 이동 (자유 구경). dx, dz 는 -1..1 */
  moveLocal(dx, dz, dt) {
    if (!this.freeRoam || !this.localPos) return null;
    const sp = 5.2;
    this.localPos.x = clamp(this.localPos.x + dx * sp * dt, WORLD.minX, WORLD.maxX);
    this.localPos.z = clamp(this.localPos.z + dz * sp * dt, WORLD.minZ, WORLD.maxZ);
    this.pushOutOfHouses(this.localPos);
    const c = this.chars.get(this.meId);
    if (c) c.target.set(this.localPos.x, 0, this.localPos.z);
    return this.localPos;
  }

  /** 건물 안으로 들어가지 않게 가장 가까운 바깥쪽으로 밀어낸다 */
  pushOutOfHouses(p) {
    for (const h of this.houses ?? []) {
      if (p.x > h.minX && p.x < h.maxX && p.z > h.minZ && p.z < h.maxZ) {
        const opts = [[h.minX - p.x, 0], [h.maxX - p.x, 0], [0, h.minZ - p.z], [0, h.maxZ - p.z]];
        opts.sort((a, b) => Math.abs(a[0] + a[1]) - Math.abs(b[0] + b[1]));
        p.x += opts[0][0];
        p.z += opts[0][1];
      }
    }
    return p;
  }

  circle(z, i, n) {
    if (n <= 1) return new THREE.Vector3(z.x, 0, z.z + 0.6);
    const r = Math.max(z.r * 0.55, (0.62 * n) / Math.PI);
    const a = (i / n) * Math.PI * 2 + Math.PI / 2;
    return new THREE.Vector3(z.x + Math.cos(a) * r, 0, z.z + Math.sin(a) * r * 0.85);
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
    if (this.freeRoam && this.meId && this.chars.get(this.meId)) {
      const me = this.chars.get(this.meId).group.position;
      this.camTarget.set(me.x, 0, me.z);
    }
    for (const [id, c] of this.chars) {
      const g = c.group;
      const d = c.target.clone().sub(g.position);
      d.y = 0;
      const dist = d.length();
      const moving = dist > 0.05;
      if (moving) {
        const step = Math.min(dist, Math.max(dt * 5.5, dist * dt * 3));
        g.position.addScaledVector(d.normalize(), step);
        c.face = Math.atan2(d.x, d.z);
      } else if (c.lookAt) {
        c.face = Math.atan2(c.lookAt.x - g.position.x, c.lookAt.z - g.position.z);
      } else if (c.faceFixed != null && !moving) {
        c.face = c.faceFixed;
      }
      // 부드러운 회전
      let diff = c.face - g.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      g.rotation.y += diff * Math.min(1, dt * 8);
      // 걷기·앉기·숨쉬기
      const w = t * 10 + c.phase;
      const seated = c.sit && !moving;
      c.legs.forEach((leg, i) => {
        const goal = seated ? -1.45 : moving ? Math.sin(w + i * Math.PI) * 0.6 : 0;
        leg.rotation.x += (goal - leg.rotation.x) * Math.min(1, dt * 12);
      });
      c.arms.forEach((arm, i) => {
        const goal = moving ? Math.sin(w + (1 - i) * Math.PI) * 0.7 : seated ? -0.5 : Math.sin(t * 1.6 + c.phase) * 0.04;
        arm.rotation.x += (goal - arm.rotation.x) * Math.min(1, dt * 12);
      });
      if (c.model) {
        const q = new THREE.Quaternion();
        const X = new THREE.Vector3(1, 0, 0);
        c.boneLegs?.forEach(({ b, rest }, i) => {
          const a = seated ? 1.3 : moving ? Math.sin(w + i * Math.PI) * 0.55 : 0;
          b.quaternion.copy(rest).multiply(q.setFromAxisAngle(X, a));
        });
        c.boneArms?.forEach(({ b, rest }, i) => {
          const a = moving ? Math.sin(w + (1 - i) * Math.PI) * 0.5 : 0;
          b.quaternion.copy(rest).multiply(q.setFromAxisAngle(X, a));
        });
        c.model.position.y = seated ? -0.15 : moving ? Math.abs(Math.sin(w)) * 0.07 : Math.sin(t * 2 + c.phase) * 0.012;
        c.mixer?.update(dt);
      }
      const sp = this.speaking.has(id);
      c.body.position.y = seated ? -0.12 : moving ? Math.abs(Math.sin(w)) * 0.07 : Math.sin(t * 2 + c.phase) * 0.012 + (sp ? Math.abs(Math.sin(t * 7)) * 0.03 : 0);
      if (sp && !moving) c.arms[1].rotation.z = -0.18 - Math.abs(Math.sin(t * 2.4)) * 0.6; // 말할 때 손짓
      else c.arms[1].rotation.z = -0.18;
      c.voiceRing.material.opacity = sp ? 0.45 + Math.sin(t * 6) * 0.35 : 0;
      c.group.visible = true;
      c.label.material.opacity = c.connected === false ? 0.45 : 1;
    }
    // 내 캐릭터가 건물 뒤에 있으면 건물을 반투명하게
    const me = this.chars.get(this.meId)?.group.position;
    for (const h of this.houses ?? []) {
      const behind = me && me.x > h.minX - 1 && me.x < h.maxX + 1 && me.z < h.maxZ + 0.5 && me.z > h.minZ - 9;
      const goal = behind ? 0.22 : 1;
      if (Math.abs(h.fade - goal) > 0.01) {
        h.fade += (goal - h.fade) * Math.min(1, dt * 6);
        h.g.traverse((o) => {
          if (o.material) {
            o.material.opacity = h.fade;
            o.material.depthWrite = h.fade > 0.95;
          }
        });
      }
    }
    for (const cl of this.clouds) {
      cl.position.x += dt * 0.6;
      if (cl.position.x > 70) cl.position.x = -70;
    }
    // 카메라
    this.camLook.lerp(this.camTarget, Math.min(1, dt * 3));
    const portrait = this.camera.aspect < 0.8;
    let dist = this.freeRoam ? 10.5 : this.closeUp ? 7 : this.phase === 'selfIntro' ? 11 : 11;
    if (portrait) dist *= 1.35;
    this.camera.position.set(this.camLook.x, dist * 0.62, this.camLook.z + dist);
    this.camera.lookAt(this.camLook.x, 0.8, this.camLook.z - 0.5);
    this.sun.position.set(this.camLook.x + 12, 22, this.camLook.z + 14);
    this.sun.target.position.set(this.camLook.x, 0, this.camLook.z);
    this.renderer.render(this.scene, this.camera);
  }

  /** 미니맵: 월드 배치 + 참가자 점 */
  drawMinimap(cv) {
    const ctx = cv.getContext('2d');
    const W = cv.width;
    const H = cv.height;
    const sx = (x) => ((x - WORLD.minX) / (WORLD.maxX - WORLD.minX)) * W;
    const sz = (z) => ((z - WORLD.minZ) / (WORLD.maxZ - WORLD.minZ)) * H;
    ctx.fillStyle = '#8fc163';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#4c9ee8';
    ctx.lineWidth = W * 0.06;
    ctx.beginPath();
    for (let x = WORLD.minX; x <= WORLD.maxX; x += 2) ctx.lineTo(sx(x), sz(-15.6 + Math.sin(x * 0.18) * 1.6));
    ctx.stroke();
    ctx.strokeStyle = '#e4d6c2';
    ctx.lineWidth = W * 0.04;
    ctx.beginPath();
    ctx.moveTo(sx(-14), sz(1.5));
    ctx.lineTo(sx(14), sz(1.5));
    ctx.moveTo(sx(0), sz(0));
    ctx.lineTo(sx(0), sz(-22));
    ctx.stroke();
    ctx.fillStyle = '#e4d6c2';
    ctx.beginPath();
    ctx.arc(sx(0), sz(0), W * 0.1, 0, 7);
    ctx.fill();
    ctx.fillStyle = '#3f5f97';
    ctx.fillRect(sx(-18.5), sz(-5), sx(-9.5) - sx(-18.5), sz(0) - sz(-5));
    ctx.fillStyle = '#d9665a';
    ctx.fillRect(sx(9.5), sz(-5), sx(18.5) - sx(9.5), sz(0) - sz(-5));
    for (const [id, c] of this.chars) {
      const p = c.group.position;
      const me = id === this.meId;
      ctx.fillStyle = me ? '#f08a3c' : c.ring.material.color.getStyle();
      ctx.beginPath();
      ctx.arc(sx(p.x), sz(p.z), me ? W * 0.05 : W * 0.03, 0, 7);
      ctx.fill();
      if (me) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  bindInput() {
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) return;
      const r = this.canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const hit = this.raycaster.intersectObjects([...this.chars.values()].map((c) => c.group), true)[0];
      if (hit) return this.onTapCharacter(hit.object.userData.pid);
      const fh = this.raycaster.intersectObject(this.floor)[0];
      if (fh) {
        if (this.freeRoam && this.localPos) {
          this.localPos = { x: clamp(fh.point.x, WORLD.minX, WORLD.maxX), z: clamp(fh.point.z, WORLD.minZ, WORLD.maxZ) };
          this.pushOutOfHouses(this.localPos);
          this.chars.get(this.meId)?.target.set(this.localPos.x, 0, this.localPos.z);
        }
        this.onTapFloor(fh.point.x, fh.point.z);
      }
    });
  }
}

// ───────── 유틸 ─────────
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function mulberry(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function labelTexture(text, { size = 40, bg, color, pad = 16, radius = 999 }) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `800 ${size}px "Pretendard","Apple SD Gothic Neo","Noto Sans KR",sans-serif`;
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  c.height = Math.ceil(size * 1.5);
  ctx.font = font;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, Math.min(radius, c.height / 2));
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, c.width / 2, c.height / 2 + size * 0.05);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
function labelSprite(text) {
  const tex = labelTexture(text, { size: 44, bg: 'rgba(255,252,246,0.95)', color: '#3a2e25', pad: 22 });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const h = 0.44;
  sp.scale.set((h * tex.image.width) / tex.image.height, h, 1);
  sp.renderOrder = 10;
  return sp;
}
