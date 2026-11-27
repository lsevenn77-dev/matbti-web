// 나솔너솔 3D 공간 (코드로 만든 저폴리 임시 자산)
// - 시안(따뜻한 저폴리 마을, SD 캐릭터) 방향을 따르되, 최종 3D 자산(GLB)이 오면 makeCharacter 만 교체한다.
// - 서버가 정한 구역(zone)에 따라 자리 배치, 자유 구경에서는 위치 동기화.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// ───────── 월드 배치 (화면 위쪽이 -z) ─────────
export const WORLD = { minX: -24, maxX: 24, minZ: -26, maxZ: 10 };
export const ZONES = {
  lounge: { x: 0, z: 0, r: 4, label: '자기소개 마당' },
  stage: { x: 0, z: 2.2, r: 0.1, label: '자기소개 마당' },
  dorm_male: { x: -14, z: -1.2, r: 1.8, label: '남자 숙소' },
  dorm_female: { x: 14, z: -1.2, r: 1.8, label: '여자 숙소' },
};
const DATE_SPOTS = [
  { x: -9.6, z: -11.8, label: '개울 벤치', kind: 'bench', rot: 0.35 },
  { x: 9.6, z: -11.8, label: '개울 벤치', kind: 'bench', rot: -0.35 },
  { x: 0, z: -15.6, label: '나무 다리', kind: 'bridge', rot: 0 },
  { x: -16, z: -21, label: '테라스', kind: 'table', rot: 0 },
  { x: 16, z: -21, label: '그네', kind: 'swing', rot: 0 },
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
    // 폰(터치 기기)은 발열·배터리를 위해 해상도·그림자·프레임을 낮춘다
    this.mobile = matchMedia('(pointer: coarse)').matches;
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
    window.__nsnsScene = this; // 진단용
    this.models = {}; // characterId → gltf (최종 3D 자산). 없으면 코드 캐릭터 사용
    this.buildWorld();
    this.bindInput();
    this.loadModels();
    this.loadProps();
    this.resize();
    addEventListener('resize', () => this.resize());
    // 발열 줄이기 (화질은 그대로):
    //  1) 90·120Hz 화면 폰에서도 초당 60프레임까지만 그린다 (60Hz 폰은 변화 없음)
    //  2) 폰에서는 그림자 계산을 두 프레임에 한 번 한다 (그림자 모양·해상도는 같음)
    if (this.mobile) this.renderer.shadowMap.autoUpdate = false;
    let lastFrame = 0;
    this.frameNo = 0;
    this.renderer.setAnimationLoop((now) => {
      if (this.mobile && now - lastFrame < 15) return;
      lastFrame = now;
      if (this.mobile && this.frameNo++ % 2 === 0) this.renderer.shadowMap.needsUpdate = true;
      this.frame();
    });
  }

  /** GLTF 로더 (압축 텍스처 KTX2 지원: 폰 그래픽 메모리·발열 감소) */
  gltfLoader() {
    const l = new GLTFLoader();
    if (!this.ktx2) {
      this.ktx2 = new KTX2Loader().setTranscoderPath('/vendor/three-addons/libs/basis/').detectSupport(this.renderer);
    }
    l.setKTX2Loader(this.ktx2);
    return l;
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
    this.sky = sky;
    s.fog = new THREE.Fog('#d9eefc', 60, 140);

    this.hemi = new THREE.HemisphereLight('#fff6e8', '#7f9a62', 1.6);
    s.add(this.hemi);
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
    this.buildHouse(-14, -2.2, '#3f5f97', '남자 숙소', { kind: 'dorm', accent: '#9fb7da' });
    this.buildHouse(14, -2.2, '#d9665a', '여자 숙소', { kind: 'dorm', accent: '#eab0bd' });
    this.buildHouse(0, -9.2, '#4f8a5b', '공용 라운지', { kind: 'lounge', W: 12, D: 6.6, backDoor: true });
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
    // 돌끼리 겹치는 곳에서 윗면 높이가 똑같으면 카메라가 움직일 때 두 색이 번갈아 깜빡인다(z-fighting).
    // 돌마다 높이를 0~1.5cm 씩 다르게 해서 겹친 면이 같은 평면에 놓이지 않게 한다. (배치는 그대로 두려고 난수는 따로)
    const lift = mulberry(91);
    pts.forEach(([x, z], i) => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6.28);
      const sc = 0.85 + rng() * 0.35;
      m4.compose(new THREE.Vector3(x, 0.03 + lift() * 0.015, z), q, new THREE.Vector3(sc, 1, sc));
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

  /**
   * 들어갈 수 있는 건물 (숙소·공용 라운지).
   * - 앞벽에 문 틈, 안에 가구. 벽은 충돌 처리.
   * - 내 캐릭터가 안이나 뒤에 있으면 지붕·앞벽(cover)이 반투명해져 내부가 보인다.
   */
  buildHouse(x, z, roofC, sign, { kind = 'dorm', W = 9, D = 5.4, backDoor = false, accent = '#9fb7da' } = {}) {
    const g = new THREE.Group(); // 항상 보이는 부분 (바닥·뒷벽·옆벽·가구)
    const cover = new THREE.Group(); // 반투명 처리 대상 (지붕·앞벽·간판)
    const H = 2.6;
    const T = 0.24; // 벽 두께
    const doorW = 2.0;
    const colliders = [];
    const wallBox = (grp, cx, cz, w, d, color = '#f4e6cc', h = H) => {
      const m = mesh(new THREE.BoxGeometry(w, h, d), color, { receive: true });
      m.position.set(cx, h / 2 + 0.06, cz);
      grp.add(m);
      colliders.push({ minX: x + cx - w / 2, maxX: x + cx + w / 2, minZ: z + cz - d / 2, maxZ: z + cz + d / 2 });
      return m;
    };
    // 바닥 (나무)
    const floorM = mesh(new THREE.BoxGeometry(W, 0.08, D), '#d9b07c', { cast: false, receive: true });
    floorM.position.y = 0.04;
    g.add(floorM);
    for (let i = -Math.floor(W / 2); i <= Math.floor(W / 2); i++) {
      const line = mesh(new THREE.BoxGeometry(0.03, 0.005, D - 0.1), '#c49764', { cast: false });
      line.position.set(i, 0.085, 0);
      g.add(line);
    }
    // 벽
    // 벽은 모두 cover: 안이나 뒤에 있으면 벽 전체가 반투명해져 캐릭터가 가려지지 않는다
    if (backDoor) {
      const sw = (W - doorW) / 2;
      wallBox(cover, -(doorW / 2 + sw / 2), -D / 2, sw, T);
      wallBox(cover, doorW / 2 + sw / 2, -D / 2, sw, T);
    } else {
      wallBox(cover, 0, -D / 2, W, T);
    }
    wallBox(cover, -W / 2, 0, T, D);
    wallBox(cover, W / 2, 0, T, D);
    const fw = (W - doorW) / 2;
    wallBox(cover, -(doorW / 2 + fw / 2), D / 2, fw, T);
    wallBox(cover, doorW / 2 + fw / 2, D / 2, fw, T);
    const lintel = mesh(new THREE.BoxGeometry(doorW, 0.5, T), '#f4e6cc');
    lintel.position.set(0, H - 0.19, D / 2);
    cover.add(lintel);
    // 모서리 기둥
    for (const [px, pz] of [[-W / 2, D / 2], [W / 2, D / 2], [-W / 2, -D / 2], [W / 2, -D / 2], [-doorW / 2 - 0.1, D / 2], [doorW / 2 + 0.1, D / 2]]) {
      const post = mesh(new THREE.BoxGeometry(0.3, H + 0.1, 0.3), '#a8693a');
      post.position.set(px, (H + 0.1) / 2, pz);
      cover.add(post);
    }
    // 창문 (밤에는 불빛)
    const winMat = new THREE.MeshStandardMaterial({ color: '#a9d2ea', roughness: 0.3, emissive: '#ffd58a', emissiveIntensity: 0 });
    (this.windowMats ??= []).push(winMat);
    for (const wx of [-W / 2 + fw / 2 + 0.1, W / 2 - fw / 2 - 0.1]) {
      const frame = mesh(new THREE.BoxGeometry(1.5, 1.0, T + 0.04), '#5a3d28');
      frame.position.set(wx, 1.55, D / 2);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.78, T + 0.06), winMat);
      glass.position.copy(frame.position);
      cover.add(frame, glass);
    }
    // 지붕 (박공)
    const roofShape = new THREE.Shape();
    roofShape.moveTo(-D / 2 - 0.8, 0);
    roofShape.lineTo(0, 1.8);
    roofShape.lineTo(D / 2 + 0.8, 0);
    roofShape.lineTo(-D / 2 - 0.8, 0);
    const roof = mesh(new THREE.ExtrudeGeometry(roofShape, { depth: W + 1.2, bevelEnabled: false }), roofC);
    roof.rotation.y = Math.PI / 2;
    roof.position.set(-(W + 1.2) / 2, H + 0.06, 0);
    cover.add(roof);
    // 간판
    const signTex = labelTexture(sign, { size: 64, bg: '#6b4428', color: '#fbeedd', pad: 26, radius: 14 });
    const signM = new THREE.Mesh(new THREE.PlaneGeometry(2.1, (2.1 * signTex.image.height) / signTex.image.width), new THREE.MeshBasicMaterial({ map: signTex, transparent: true }));
    signM.position.set(0, H + 0.45, D / 2 + 0.14);
    cover.add(signM);
    // 문 옆 등 (밤에 켜짐)
    for (const lx of [-doorW / 2 - 0.45, doorW / 2 + 0.45]) {
      const lamp = mesh(new THREE.BoxGeometry(0.26, 0.4, 0.26), '#fff1c9', { emissive: '#ffd27a', emissiveIntensity: 0.4 });
      lamp.position.set(lx, 1.95, D / 2 + 0.25);
      cover.add(lamp);
      lamp.userData.isLamp = true;
    }
    // 가구
    if (kind === 'dorm') {
      const n = 3;
      for (let i = 0; i < n; i++) {
        const bx = -W / 2 + 1.3 + i * ((W - 2.6) / (n - 1));
        const frame = mesh(new THREE.BoxGeometry(1.3, 0.35, 2.1), '#a8693a');
        frame.position.set(bx, 0.25, -D / 2 + 1.25);
        const mat = mesh(new THREE.BoxGeometry(1.2, 0.18, 2.0), '#fbf7ee');
        mat.position.set(bx, 0.5, -D / 2 + 1.25);
        const blanket = mesh(new THREE.BoxGeometry(1.24, 0.1, 1.3), i % 2 ? accent : '#f2c57c');
        blanket.position.set(bx, 0.62, -D / 2 + 1.6);
        const pillow = mesh(new THREE.BoxGeometry(0.8, 0.14, 0.35), '#ffffff');
        pillow.position.set(bx, 0.66, -D / 2 + 0.5);
        for (const m of [frame, mat, blanket, pillow]) m.userData.furn = 'bed';
        g.add(frame, mat, blanket, pillow);
        colliders.push({ minX: x + bx - 0.65, maxX: x + bx + 0.65, minZ: z - D / 2, maxZ: z - D / 2 + 2.3 });
      }
      const rug = mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.02, 24), accent, { cast: false, receive: true });
      rug.position.set(0, 0.1, 0.7);
      rug.scale.z = 0.6;
      g.add(rug);
    } else {
      // 공용 라운지: 양옆 소파 + 테이블 + 화분 (가운데 통로는 비움)
      for (const sx of [-1, 1]) {
        const base = mesh(new THREE.BoxGeometry(1.0, 0.45, 2.6), '#e98a5d');
        base.position.set(sx * (W / 2 - 0.9), 0.3, 0);
        const back = mesh(new THREE.BoxGeometry(0.3, 0.6, 2.6), '#d9774c');
        back.position.set(sx * (W / 2 - 0.45), 0.7, 0);
        const table = mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.06, 12), '#fff8ec');
        table.position.set(sx * (W / 2 - 2.0), 0.55, 0);
        const leg = mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.5, 6), '#7d4c27');
        leg.position.set(sx * (W / 2 - 2.0), 0.28, 0);
        base.userData.furn = back.userData.furn = 'sofa';
        table.userData.furn = leg.userData.furn = 'table';
        g.add(base, back, table, leg);
        colliders.push({ minX: x + sx * (W / 2 - 0.9) - 0.5, maxX: x + sx * (W / 2 - 0.9) + 0.5, minZ: z - 1.3, maxZ: z + 1.3 });
        const pot = mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.35, 8), '#c97b63');
        pot.position.set(sx * (W / 2 - 0.5), 0.2, -D / 2 + 0.5);
        const plant = mesh(new THREE.IcosahedronGeometry(0.45, 0), '#5f9b43');
        plant.position.set(sx * (W / 2 - 0.5), 0.75, -D / 2 + 0.5);
        g.add(pot, plant);
      }
      const rug = mesh(new THREE.BoxGeometry(2.2, 0.02, D - 0.6), '#f3d9c4', { cast: false, receive: true });
      rug.position.y = 0.1;
      g.add(rug);
    }
    // 화단 (밖)
    for (const fx of [-W / 2 + 1.4, W / 2 - 1.4]) {
      const box = mesh(new THREE.BoxGeometry(1.8, 0.45, 0.7), '#a8693a');
      box.position.set(fx, 0.22, D / 2 + 0.8);
      box.userData.planter = true;
      g.add(box);
      for (let i = -1; i <= 1; i++) {
        const b2 = mesh(new THREE.IcosahedronGeometry(0.36, 0), '#5e9d4a');
        b2.position.set(fx + i * 0.5, 0.6, D / 2 + 0.8);
        b2.userData.planter = true;
        g.add(b2);
      }
      (this.planterSpots ??= []).push({ g, x: fx, z: D / 2 + 0.8 });
      colliders.push({ minX: x + fx - 0.9, maxX: x + fx + 0.9, minZ: z + D / 2 + 0.45, maxZ: z + D / 2 + 1.15 });
    }
    g.position.set(x, 0, z);
    cover.position.set(x, 0, z);
    cover.traverse((o) => {
      if (o.material && !this.windowMats.includes(o.material)) {
        o.material = o.material.clone();
        o.material.transparent = true;
      }
    });
    this.scene.add(g, cover);
    cover.traverse((o) => o.userData.isLamp && (this.lampMats ??= new Set()).add(o.material));
    (this.colliders ??= []).push(...colliders);
    (this.houses ??= []).push({ cover, g, sign: signM, kind, W, D, H, name: sign, x, z, minX: x - W / 2, maxX: x + W / 2, minZ: z - D / 2, maxZ: z + D / 2, fade: 1 });
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
    for (const [x, z] of [[-5.5, -3], [5.5, 2.5], [-5.5, 2.5], [-5.2, -12.2], [5.2, -12.2], [-2, -19], [2, -19], [-9, 1.2], [9, 1.2]]) this.lampPost(x, z);
  }

  lampPost(x, z) {
    const p = mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.8, 6), '#3c3530');
    p.position.set(x, 0.9, z);
    const head = mesh(new THREE.BoxGeometry(0.32, 0.4, 0.32), '#fff2c6', { emissive: '#ffd27a', emissiveIntensity: 0.5 });
    head.position.set(x, 1.95, z);
    (this.lampMats ??= new Set()).add(head.material);
    const cap = mesh(new THREE.ConeGeometry(0.28, 0.2, 4), '#3c3530');
    cap.position.set(x, 2.25, z);
    cap.rotation.y = Math.PI / 4;
    this.scene.add(p, head, cap);
    (this.lampPosts ??= []).push({ x, z, pole: p, head, cap });
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
        const rz = p.z + side * 1.9;
        // 데이트 장소(데크·의자)와 겹치는 돌은 두지 않는다
        if (DATE_SPOTS.some((d) => d.kind !== 'bridge' && Math.hypot(d.x - p.x, d.z - rz) < 3.2)) continue;
        const r = mesh(new THREE.DodecahedronGeometry(0.35 + rng() * 0.3, 0), rng() < 0.5 ? '#9a9a96' : '#a9a7a1', { receive: true });
        r.position.set(p.x + (rng() - 0.5) * 0.6, 0.12, p.z + side * (1.75 + rng() * 0.3));
        r.scale.y = 0.55;
        r.rotation.set(rng(), rng() * 6, rng());
        this.scene.add(r);
        (this.rockMeshes ??= []).push(r);
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
      deck.userData.keep = true;
      deck.position.y = 0.07;
      const top = mesh(new THREE.CylinderGeometry(0.65, 0.65, 0.08, 10), '#fff8ec');
      top.position.y = 0.78;
      const leg = mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.7, 6), '#7d4c27');
      leg.position.y = 0.4;
      g.add(deck, top, leg);
      for (let k = 0; k < 6; k++) {
        const pot = mesh(new THREE.IcosahedronGeometry(0.28, 0), k % 2 ? '#f2a585' : '#6faa4d');
        pot.userData.keep = true;
        pot.position.set(Math.cos(k * 1.05) * 2.2, 0.3, Math.sin(k * 1.05) * 2.2 - 0.4);
        if (Math.sin(k * 1.05) > 0.3) continue; // 카메라 쪽은 비워 둔다
        g.add(pot);
      }
    }
    g.position.set(d.x, 0, d.z - (d.kind === 'bench' || d.kind === 'swing' ? 0.6 : 0));
    g.rotation.y = d.rot;
    this.scene.add(g);
    (this.dateSpotGroups ??= []).push({ g, d });
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
      // 카메라 시야를 가릴 때 반투명하게 하려고 나무마다 재질을 따로 둔다
      g.traverse((o) => {
        if (o.material) {
          o.material = o.material.clone();
          o.material.transparent = true;
        }
      });
      this.scene.add(g);
      (this.trees ??= []).push({ g, x, z, s, r: 1.4 * s, fade: 1 });
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
      (this.fenceMeshes ??= []).push(p);
    }
    const rail = mesh(new THREE.BoxGeometry(60, 0.1, 0.1), '#8a5530');
    rail.position.set(0, 0.7, -28);
    this.scene.add(rail);
    this.fenceMeshes.push(rail);
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
    ring.position.y = 0.1; // 돌판 윗면(최대 8.5cm)보다 위
    root.add(ring);
    const voiceRing = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.82, 28), new THREE.MeshBasicMaterial({ color: '#59c27a', transparent: true, opacity: 0, depthWrite: false }));
    voiceRing.rotation.x = -Math.PI / 2;
    voiceRing.position.y = 0.105;
    root.add(voiceRing);
    // 이름은 옷(가슴·등)에 명찰로. 머리 위는 채팅 말풍선 자리
    const badges = makeBadges(p.alias, p.gender);
    badges.front.position.set(0, 0.98, 0.36);
    badges.back.position.set(0, 0.98, -0.36);
    body.add(badges.front, badges.back);
    const label = { material: { opacity: 1 } }; // (호환용)

    root.traverse((o) => (o.userData.pid = p.id));
    root.scale.setScalar(1.05);
    void female;
    return { group: root, body, legs, arms, head, target: new THREE.Vector3(), face: 0, voiceRing, ring, label, badges, alias: p.alias, gender: p.gender, sit: false, phase: Math.random() * 6 };
  }

  addHair(head, L) {
    const c = L.hairC;
    // 머리카락 덮개: 두피(각진 구, 가로 0.56)보다 확실히 크게 + 앞쪽으로 그려지게(polygonOffset).
    // 크기가 거의 같으면 면 사이로 피부색이 비쳐 '흰 갈라짐'처럼 보인다 (특히 검은 머리)
    const cap = (s = 1.06, cut = 2.05) => {
      const m = mesh(new THREE.SphereGeometry(0.54 * s, 16, 9, 0, Math.PI * 2, 0, Math.PI / cut), c, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      m.position.y = 0.04;
      m.rotation.x = -0.25;
      m.scale.set(1.1, 1.06, 1.08);
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

  // ───────── GLB 소품·건물 (있으면 코드 도형 대신 사용) ─────────
  async loadProps() {
    let list = {};
    try {
      list = await fetch('/models/props.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {}));
    } catch { /* 없음 */ }
    const loader = this.gltfLoader();
    this.props = {};
    await Promise.all(Object.entries(list).map(async ([id, spec]) => {
      if (id.startsWith('_')) return;
      try {
        const gltf = await loader.loadAsync(spec.url);
        if (spec.mipmaps === false) disableMipmaps(gltf);
        this.props[id] = { gltf, spec };
      } catch (e) {
        console.warn('prop load failed', id, e);
      }
    }));
    this.placeProps();
  }

  /** 소품 하나를 정규화해서 만든다: 회전(spec.rot) → 지정 축 크기에 맞춤 → 바닥(y=0)·중앙 정렬 */
  makeProp(id, { fit = 'x', size = 1, rotY = 0, opaqueShadow = true, box: fitBox = null } = {}) {
    const p = this.props?.[id];
    if (!p) return null;
    const inner = p.gltf.scene.clone(true);
    inner.rotation.y = THREE.MathUtils.degToRad(p.spec.rot ?? 0);
    const holder = new THREE.Group();
    holder.add(inner);
    holder.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(holder);
    const dims = box.getSize(new THREE.Vector3());
    let k = size / Math.max(1e-4, fit === 'x' ? dims.x : fit === 'z' ? dims.z : dims.y);
    if (fitBox) k = Math.min(fitBox.x / Math.max(1e-4, dims.x), fitBox.z / Math.max(1e-4, dims.z));
    holder.scale.setScalar(k);
    holder.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(holder);
    const c = box.getCenter(new THREE.Vector3());
    const out = new THREE.Group();
    holder.position.set(-c.x, -box.min.y, -c.z);
    out.add(holder);
    out.rotation.y = rotY;
    out.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = opaqueShadow;
        o.receiveShadow = true;
        o.material = o.material.clone();
      }
    });
    return out;
  }

  placeProps() {
    const P = this.props ?? {};
    // 건물 외관
    const houseId = { '남자 숙소': 'house_m', '여자 숙소': 'house_f', '공용 라운지': 'lounge' };
    for (const h of this.houses ?? []) {
      const id = houseId[h.name];
      if (!P[id]) continue;
      // 벽 충돌 범위(W×D) 밖으로 건물이 튀어나오지 않게: 처마 포함 W+0.6 × D+0.9 안에 맞춤
      const m = this.makeProp(id, { box: { x: h.W + 0.6, z: h.D + 0.9 } });
      if (!m) continue;
      for (const ch of h.cover.children) if (ch !== h.sign) ch.visible = false;
      m.traverse((o) => o.material && (o.material.transparent = true));
      h.cover.add(m);
      h.sign.position.y = Math.max(h.sign.position.y, new THREE.Box3().setFromObject(m).max.y * 0 + h.H + 0.55);
      // 가구 교체
      const furnHide = (tag) => h.g.traverse((o) => o.userData.furn === tag && (o.visible = false));
      const add = (mm, x, z) => {
        if (!mm) return;
        mm.position.x += x;
        mm.position.z += z;
        mm.position.y += 0.08;
        h.g.add(mm);
      };
      if (h.kind === 'dorm') {
        if (P.bed) {
          furnHide('bed');
          for (let i = 0; i < 3; i++) add(this.makeProp('bed', { fit: 'z', size: 2.1 }), -h.W / 2 + 1.3 + i * ((h.W - 2.6) / 2), -h.D / 2 + 1.25);
        }
        if (P.nightstand) {
          for (const nx of [-(h.W - 2.6) / 4, (h.W - 2.6) / 4]) {
            add(this.makeProp('nightstand', { fit: 'y', size: 1.0 }), nx, -h.D / 2 + 0.45);
            this.colliders.push({ minX: h.x + nx - 0.3, maxX: h.x + nx + 0.3, minZ: h.z - h.D / 2, maxZ: h.z - h.D / 2 + 0.8 });
          }
        }
        if (P.wardrobe) {
          const wx = -h.W / 2 + 0.55;
          const wz = h.D / 2 - 1.1;
          add(this.makeProp('wardrobe', { fit: 'y', size: 2.0, rotY: Math.PI / 2 }), wx, wz);
          this.colliders.push({ minX: h.x + wx - 0.45, maxX: h.x + wx + 0.45, minZ: h.z + wz - 0.6, maxZ: h.z + wz + 0.6 });
        }
        if (P.lowtable) {
          add(this.makeProp('lowtable', { fit: 'x', size: 1.8 }), h.W / 2 - 1.6, h.D / 2 - 1.3);
          this.colliders.push({ minX: h.x + h.W / 2 - 2.3, maxX: h.x + h.W / 2 - 0.9, minZ: h.z + h.D / 2 - 1.9, maxZ: h.z + h.D / 2 - 0.7 });
        }
      } else {
        if (P.sofa) {
          furnHide('sofa');
          add(this.makeProp('sofa', { fit: 'x', size: 2.6, rotY: Math.PI / 2 }), -(h.W / 2 - 0.75), 0);
          add(this.makeProp('sofa', { fit: 'x', size: 2.6, rotY: -Math.PI / 2 }), h.W / 2 - 0.75, 0);
          // 넓어진 라운지: 뒷벽 쪽 소파 2개 (뒷문 양옆, 앞을 보게)
          for (const sx of [-1, 1]) {
            add(this.makeProp('sofa', { fit: 'x', size: 2.6, rotY: 0 }), sx * 3.2, -(h.D / 2 - 0.75));
            this.colliders.push({ minX: h.x + sx * 3.2 - 1.3, maxX: h.x + sx * 3.2 + 1.3, minZ: h.z - h.D / 2, maxZ: h.z - h.D / 2 + 1.2 });
          }
          if (P.lowtable) add(this.makeProp('lowtable', { fit: 'x', size: 1.6 }), 0, 0.2);
        }
        if (P.lowtable) {
          furnHide('table');
          add(this.makeProp('lowtable', { fit: 'x', size: 1.4 }), -(h.W / 2 - 2.1), 0);
          add(this.makeProp('lowtable', { fit: 'x', size: 1.4 }), h.W / 2 - 2.1, 0);
        }
      }
    }
    // 데이트 장소
    for (const { g, d } of this.dateSpotGroups ?? []) {
      let m = null;
      if (d.kind === 'bench' && P.bench) m = this.makeProp('bench', { fit: 'x', size: 2.4 });
      if (d.kind === 'swing' && P.swing) m = this.makeProp('swing', { fit: 'x', size: 3.4 });
      if (d.kind === 'bridge' && P.bridge) m = this.makeProp('bridge', { fit: 'z', size: 5.2 });
      if (d.kind === 'table' && P.cafe) m = this.makeProp('cafe', { fit: 'x', size: 2.4 });
      if (!m) continue;
      for (const ch of g.children) if (!ch.userData.keep) ch.visible = false;
      if (d.kind === 'table') m.position.y += 0.15;
      g.add(m);
    }
    this.placeBackgroundProps();
  }

  /** 나무·가로등·화단·울타리·바위 (배경) */
  placeBackgroundProps() {
    const P = this.props ?? {};
    const rnd = mulberry(21);
    if (P.tree) {
      for (const t of this.trees ?? []) {
        const m = this.makeProp('tree', { fit: 'y', size: 3.7 * t.s, rotY: rnd() * Math.PI * 2 });
        if (!m) continue;
        for (const ch of t.g.children) ch.visible = false;
        m.traverse((o) => o.material && (o.material.transparent = true));
        t.g.add(m);
      }
    }
    if (P.lamp) {
      for (const l of this.lampPosts ?? []) {
        const m = this.makeProp('lamp', { fit: 'y', size: 2.5 });
        if (!m) continue;
        m.position.set(l.x, 0, l.z);
        this.scene.add(m);
        l.pole.visible = l.cap.visible = false;
        // 밤 불빛: 코드 등(발광)을 랜턴 안쪽으로 옮겨 작게
        l.head.scale.setScalar(0.55);
        l.head.position.y = 2.5 * 0.86;
      }
    }
    if (P.planter) {
      for (const sp of this.planterSpots ?? []) {
        const m = this.makeProp('planter', { fit: 'x', size: 1.9 });
        if (!m) continue;
        sp.g.traverse((o) => o.userData.planter && (o.visible = false));
        m.position.set(sp.x, 0, sp.z);
        sp.g.add(m);
      }
    }
    if (P.fence && this.fenceMeshes) {
      const tf = [];
      for (let x = -30; x < 30; x += 3) {
        if (Math.abs(x + 1.5) < 2) continue; // 길 자리 비움
        tf.push({ x: x + 1.5, z: -28, rot: 0, s: 1 });
      }
      const inst = this.instancedProp('fence', tf, { fit: 'x', size: 3.05 });
      if (inst) {
        for (const m of this.fenceMeshes) m.visible = false;
        this.scene.add(inst);
      }
    }
    if (P.rocks && this.rockMeshes) {
      const tf = this.rockMeshes.filter((_, i) => i % 2 === 0).map((r) => ({ x: r.position.x, z: r.position.z, rot: rnd() * Math.PI * 2, s: 0.75 + rnd() * 0.6 }));
      const inst = this.instancedProp('rocks', tf, { fit: 'x', size: 1.3 });
      if (inst) {
        for (const m of this.rockMeshes) m.visible = false;
        this.scene.add(inst);
      }
    }
  }

  /** 같은 소품을 여러 개 한 번에 그린다 (InstancedMesh). 소품의 메쉬마다 하나씩 */
  instancedProp(id, transforms, { fit = 'x', size = 1 } = {}) {
    const p = this.props?.[id];
    if (!p || !transforms.length) return null;
    const src = p.gltf.scene;
    src.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(src);
    const dims = box.getSize(new THREE.Vector3());
    const k = size / Math.max(1e-4, fit === 'x' ? dims.x : fit === 'z' ? dims.z : dims.y);
    const c = box.getCenter(new THREE.Vector3());
    const base = new THREE.Matrix4().makeScale(k, k, k).multiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z));
    const group = new THREE.Group();
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    src.traverse((o) => {
      if (!o.isMesh) return;
      const local = base.clone().multiply(o.matrixWorld);
      const im = new THREE.InstancedMesh(o.geometry, o.material, transforms.length);
      transforms.forEach((t, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot ?? 0);
        m4.compose(new THREE.Vector3(t.x, 0, t.z), q, new THREE.Vector3(t.s ?? 1, t.s ?? 1, t.s ?? 1)).multiply(local);
        im.setMatrixAt(i, m4);
      });
      im.castShadow = true;
      im.receiveShadow = true;
      group.add(im);
    });
    return group;
  }

  // ───────── GLB 캐릭터 (있으면 코드 캐릭터 대신 사용) ─────────
  async loadModels() {
    let manifest = {};
    try {
      manifest = await fetch('/models/manifest.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {}));
    } catch { /* 모델 없음 */ }
    const loader = this.gltfLoader();
    await Promise.all(Object.entries(manifest).map(async ([cid, entry]) => {
      if (cid.startsWith('_')) return;
      const spec = typeof entry === 'string' ? { url: entry } : entry;
      try {
        const gltf = await loader.loadAsync(spec.url);
        gltf.spec = spec;
        // UV 섬 재배치(여백)를 거친 모델은 밉맵을 켠다. 처리 안 한 원본(mipmaps:false)만 끈다.
        if (spec.mipmaps === false) disableMipmaps(gltf);
        this.models[cid] = gltf;
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
    // 높이를 코드 캐릭터와 비슷하게(약 2.3) 맞추고 발을 바닥에.
    // 뼈대 모델은 뼈 행렬을 먼저 갱신해야 실제(스키닝된) 크기가 나온다. (Armature 0.01 배율 등)
    const measure = () => {
      model.updateMatrixWorld(true);
      model.traverse((o) => {
        if (o.isSkinnedMesh) {
          o.skeleton.update();
          o.computeBoundingBox();
        }
      });
      return new THREE.Box3().setFromObject(model, true);
    };
    const box = measure();
    const size = box.getSize(new THREE.Vector3());
    const k = 2.3 / Math.max(size.y, 0.001);
    model.scale.multiplyScalar(k);
    const box2 = measure();
    const center = box2.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box2.min.y, -center.z);
    // 진단용 정보 (콘솔에서 window.__nsnsScene 으로 확인 가능)
    const meshes = [];
    model.traverse((o) => o.isMesh && meshes.push({ name: o.name, skinned: !!o.isSkinnedMesh, verts: o.geometry.attributes.position.count, mat: o.material?.type, transparent: o.material?.transparent, opacity: o.material?.opacity, visible: o.visible }));
    const r2 = (v) => v.toArray().map((x) => Math.round(x * 1000) / 1000);
    c.modelDebug = { sizeBefore: r2(size), k: Math.round(k * 10000) / 10000, boxAfter: [r2(box2.min), r2(box2.max)], rootScale: r2(gltf.scene.scale), meshes };
    console.info('model debug', JSON.stringify(c.modelDebug));
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
    // 캐릭터별 머리 비율 보정 (생성 모델마다 머리:몸 비율이 달라서)
    const hs = gltf.spec?.headScale;
    if (hs) model.traverse((o) => o.isBone && o.name === 'Head' && o.scale.multiplyScalar(hs));
    {
      const h = box2.max.y - box2.min.y;
      const nb = makeBadges(c.alias, c.gender);
      const fz = box2.max.z - center.z;
      const bz = box2.min.z - center.z;
      nb.front.position.set(0, h * 0.42, fz * 0.62 + 0.02);
      nb.back.position.set(0, h * 0.42, bz * 0.62 - 0.02);
      wrap.add(nb.front, nb.back);
      // 앉으면 허벅지가 이름표 높이로 올라오므로 가슴 쪽으로 올린다
      c.mBadges = { nb, y: h * 0.42, lift: h * 0.1, fz: fz * 0.62 + 0.02, bz: bz * 0.62 - 0.02 };
    }
    // 뼈대가 있으면 다리·팔 뼈를 찾아 걷기 흔들기에 사용
    const bones = [];
    model.traverse((o) => o.isBone && bones.push(o));
    const find = (re, not) => bones.find((b) => re.test(b.name) && !(not && not.test(b.name)));
    const L = (side) => new RegExp(`(^|[^a-z])(${side}|${side[0]}[_.]?)`, 'i');
    const pick = (side, re, not) => bones.find((b) => L(side).test(b.name) && re.test(b.name) && !(not && not.test(b.name))) ?? find(new RegExp(`${side}.*${re.source}`, 'i'), not);
    const legs = ['left', 'right'].map((sd) => pick(sd, /(up.?leg|thigh|upperleg)/i)).filter(Boolean);
    const arms = ['left', 'right'].map((sd) => pick(sd, /(arm|upperarm)/i, /(fore|lower|hand)/i)).filter(Boolean);
    c.boneLegs = legs.map((b) => ({ b, rest: b.quaternion.clone() }));
    const knees = bones.filter((b) => /^(mixamorig:)?(Left|Right)Leg$/i.test(b.name));
    c.boneKnees = knees.map((b) => ({ b, rest: b.quaternion.clone() }));
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
    this.todTarget = timeOfPhase(view.phase);
    const phaseChanged = this.phase !== view.phase;
    if (phaseChanged) this.localPos = null; // 새 단계는 정해진 자리에서 시작
    this.phase = view.phase;
    const roaming = new Set(view.roaming ?? []);
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
      if (!roaming.has(p.id) || phaseChanged) c.freePose = null;
      c.roam = roaming.has(p.id);
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
        const z = ZONES[zone] ?? ZONES.lounge;
        if (members.length > 1) {
          // 카메라(앞, +z) 쪽으로 열린 반원에 서서, 서로와 카메라를 함께 보게 한다
          pos = this.arc(z, members.indexOf(p.id), members.length);
          c.lookAt = new THREE.Vector3(z.x, 0, z.z + 2.4);
        } else {
          pos = this.circle(z, 0, 1);
        }
      }
      if (roaming.has(p.id) && zone !== 'free') {
        // 숙소 대기 중에도 돌아다닐 수 있다: 움직였으면 그 위치, 아니면 숙소 자리
        const sv = p.id === this.meId && this.localPos ? this.localPos : view.positions?.[p.id];
        if (sv) {
          pos = new THREE.Vector3(sv.x, 0, sv.z);
          c.lookAt = null;
        }
        if (p.id === this.meId && !this.localPos) this.localPos = { x: pos.x, z: pos.z };
      }
      if (!roaming.has(p.id) && p.id === this.meId) this.localPos = null;
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
    this.freeRoam = roaming.has(view.me.id);
    // 데이트 중인 장소는 대기 인원이 들어가지 못하게 (방해 금지)
    this.busySpots = [...byZone.keys()].filter((k) => k.startsWith('date:')).map((k) => ZONES[k]).filter(Boolean);
    this.myZone = myZone;
    if (!this.freeRoam) {
      const f = myZone === 'stage' || view.phase === 'selfIntro' ? { x: 0, z: 1.2 } : ZONES[myZone] ?? ZONES.lounge;
      this.camTarget.set(f.x, 0, f.z);
    }
    this.closeUp = /^date\d$/.test(view.phase) && !!view.myDate;
  }

  // ── 보물찾기: 땅 위에 희미하게 반짝이는 빛 ──
  /** tr = { id, x, z } 또는 null(숨김) */
  setTreasure(tr) {
    if (!this.treasure) {
      const g = new THREE.Group();
      const glowTex = radialTexture('rgba(255,250,215,1)', 'rgba(255,214,120,0.35)');
      const starTex = starTexture();
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      glow.scale.set(1.1, 1.1, 1);
      glow.position.y = 0.22;
      g.add(glow);
      // 바닥에 깔리는 옅은 원 (가까이 가야 겨우 보이는 정도)
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.11;
      g.add(disc);
      const stars = [];
      for (let i = 0; i < 6; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
        s.userData = { a: (i / 6) * Math.PI * 2, r: 0.18 + (i % 3) * 0.12, sp: 0.6 + (i % 4) * 0.25, ph: i * 1.7 };
        g.add(s);
        stars.push(s);
      }
      g.visible = false;
      this.scene.add(g);
      this.treasure = { g, glow, disc, stars, id: null, appear: 0 };
    }
    const T = this.treasure;
    if (!tr) {
      T.id = null;
      return;
    }
    if (T.id !== tr.id) {
      T.id = tr.id;
      T.appear = 0;
      T.g.position.set(tr.x, 0, tr.z);
    }
  }

  animateTreasure(t, dt) {
    const T = this.treasure;
    if (!T) return;
    const on = T.id != null;
    T.appear += ((on ? 1 : 0) - T.appear) * Math.min(1, dt * (on ? 1.2 : 6));
    T.g.visible = T.appear > 0.02;
    if (!T.g.visible) return;
    // 희미하게: 대부분 은은하다가 가끔 반짝
    const pulse = 0.55 + 0.45 * Math.sin(t * 2.2);
    const twinkle = Math.max(0, Math.sin(t * 0.9) * Math.sin(t * 3.7)) ** 6;
    T.glow.material.opacity = T.appear * (0.16 + 0.16 * pulse + 0.5 * twinkle);
    T.glow.scale.setScalar(0.9 + 0.25 * pulse + 0.5 * twinkle);
    T.disc.material.opacity = T.appear * (0.12 + 0.1 * pulse);
    for (const s of T.stars) {
      const u = s.userData;
      const k = (t * u.sp + u.ph) % 1.6;
      s.position.set(Math.cos(u.a + t * 0.6) * u.r, 0.15 + k * 0.45, Math.sin(u.a + t * 0.6) * u.r);
      s.scale.setScalar(0.12 + 0.08 * Math.sin(t * 5 + u.ph));
      s.material.opacity = T.appear * Math.max(0, Math.sin((k / 1.6) * Math.PI)) * (0.35 + 0.5 * twinkle);
    }
  }

  /** 채팅 말풍선: 보낸 사람 머리 위에 몇 초간 */
  showBubble(pid, text) {
    const c = this.chars.get(pid);
    if (!c) return;
    if (c.bubble) {
      c.group.remove(c.bubble);
      c.bubble.material.map.dispose();
      c.bubble.material.dispose();
    }
    const sp = bubbleSprite(text);
    sp.position.y = 2.5;
    c.group.add(sp);
    c.bubble = sp;
    c.bubbleUntil = performance.now() + Math.min(9000, 3500 + text.length * 120);
  }

  setRemotePos(id, x, z) {
    const c = this.chars.get(id);
    if (c && id !== this.meId) c.target.set(x, 0, z);
  }

  /** 조이스틱 이동 (자유 구경). dx, dz 는 -1..1 */
  moveLocal(dx, dz, dt) {
    if (!this.freeRoam || !this.localPos) return null;
    const meC = this.chars.get(this.meId);
    if (meC?.freePose) {
      meC.freePose = null;
      this.onPoseCleared?.();
    }
    const sp = 5.2;
    this.localPos.x = clamp(this.localPos.x + dx * sp * dt, WORLD.minX, WORLD.maxX);
    this.localPos.z = clamp(this.localPos.z + dz * sp * dt, WORLD.minZ, WORLD.maxZ);
    this.pushOutOfHouses(this.localPos);
    if (this.phase !== 'freeRoam') {
      for (const b of this.busySpots ?? []) {
        const ddx = this.localPos.x - b.x;
        const ddz = this.localPos.z - b.z;
        const d = Math.hypot(ddx, ddz);
        const R = 3.2;
        if (d < R) {
          const k = d > 1e-3 ? R / d : 0;
          this.localPos.x = k ? b.x + ddx * k : b.x + R;
          this.localPos.z = k ? b.z + ddz * k : b.z;
        }
      }
    }
    const c = this.chars.get(this.meId);
    if (c) c.target.set(this.localPos.x, 0, this.localPos.z);
    return this.localPos;
  }

  /** 벽·가구와 겹치지 않게 밀어낸다 (캐릭터 반지름 0.35). 문으로는 드나들 수 있다 */
  pushOutOfHouses(p) {
    const r = 0.35;
    for (let iter = 0; iter < 3; iter++) {
      for (const c of this.colliders ?? []) {
        const minX = c.minX - r;
        const maxX = c.maxX + r;
        const minZ = c.minZ - r;
        const maxZ = c.maxZ + r;
        if (p.x > minX && p.x < maxX && p.z > minZ && p.z < maxZ) {
          const opts = [[minX - p.x, 0], [maxX - p.x, 0], [0, minZ - p.z], [0, maxZ - p.z]];
          opts.sort((u, v) => Math.abs(u[0] + u[1]) - Math.abs(v[0] + v[1]));
          p.x += opts[0][0];
          p.z += opts[0][1];
        }
      }
    }
    return p;
  }

  applyTimeOfDay(t) {
    if (this._lastTod != null && Math.abs(this._lastTod - t) < 0.0005) return;
    this._lastTod = t;
    const k = sampleTod(t);
    this.sky.material.uniforms.top.value.copy(k.top);
    this.sky.material.uniforms.bottom.value.copy(k.bottom);
    this.scene.fog.color.copy(k.bottom);
    this.hemi.color.copy(k.hemiSky);
    this.hemi.groundColor.copy(k.hemiGround);
    this.hemi.intensity = k.hemi;
    this.sun.color.copy(k.sun);
    this.sun.intensity = k.sunI;
    this.sunAngle = k.sunAngle;
    for (const m of this.lampMats ?? []) m.emissiveIntensity = k.lamp;
    for (const m of this.windowMats ?? []) m.emissiveIntensity = k.window;
    for (const cl of this.clouds ?? []) cl.children.forEach((c) => (c.material.emissiveIntensity = 0.35 * k.cloud));
  }

  /** 앉기·눕기 가능한 자리 (자유 구경용) */
  buildSeats() {
    const seats = [];
    for (const ch of this.chairs ?? []) seats.push({ kind: 'sit', label: '앉기', x: ch.x, z: ch.z, face: Math.atan2(0 - ch.x, 2.2 - ch.z), y: 0.05 });
    for (const { d } of this.dateSpotGroups ?? []) {
      if (d.kind === 'table') {
        // 카페 탁자 양옆 의자
        for (const sx of [-1, 1]) {
          const ox = sx * 1.0;
          seats.push({ kind: 'sit', label: '앉기', x: d.x + Math.cos(d.rot) * ox, z: d.z - Math.sin(d.rot) * ox, face: d.rot + (sx < 0 ? Math.PI / 2 : -Math.PI / 2), y: 0.2 });
        }
        continue;
      }
      if (d.kind !== 'bench' && d.kind !== 'swing') continue;
      const cx = d.x;
      const cz = d.z - 0.6;
      for (const off of [-0.55, 0.55]) {
        seats.push({ kind: 'sit', label: '앉기', x: cx + Math.cos(d.rot) * off, z: cz - Math.sin(d.rot) * off + 0.15, face: d.rot, y: d.kind === 'swing' ? 0.12 : 0.05 });
      }
    }
    for (const h of this.houses ?? []) {
      if (h.kind === 'dorm') {
        for (let i = 0; i < 3; i++) {
          const bx = h.x - h.W / 2 + 1.3 + i * ((h.W - 2.6) / 2);
          // 누우면 발이 침대 발치, 머리가 머리판 쪽
          seats.push({ kind: 'lie', label: '눕기', x: bx, z: h.z - h.D / 2 + 2.25, face: 0 });
        }
      } else {
        for (const sx of [-1, 1]) for (const sz of [-0.6, 0.6]) {
          seats.push({ kind: 'sit', label: '앉기', x: h.x + sx * (h.W / 2 - 1.0), z: h.z + sz, face: sx < 0 ? Math.PI / 2 : -Math.PI / 2, y: 0.05 });
        }
        if (h.W >= 11) for (const sx of [-1, 1]) for (const ox of [-0.6, 0.6]) {
          seats.push({ kind: 'sit', label: '앉기', x: h.x + sx * 3.2 + ox, z: h.z - h.D / 2 + 1.0, face: 0, y: 0.05 });
        }
      }
    }
    this.seats = seats;
  }

  /** 내 근처 자리 (1.3 이내) */
  nearestSeat() {
    if (!this.freeRoam || !this.localPos) return null;
    this.seats ?? this.buildSeats();
    let best = null;
    let bd = 1.6;
    for (const st of this.seats) {
      const dd = Math.hypot(st.x - this.localPos.x, st.z - this.localPos.z);
      if (dd < bd) {
        bd = dd;
        best = st;
      }
    }
    return best;
  }

  /** 포즈 적용 (나 또는 다른 사람). kind: sit | lie | stand | jump */
  applyPose(id, { kind, x, z, face, y }) {
    const c = this.chars.get(id);
    if (!c) return;
    if (kind === 'jump') {
      if (!c.jumpT) c.jumpT = 0.6;
      return;
    }
    if (kind === 'stand') {
      c.freePose = null;
      return;
    }
    c.freePose = { kind, x, z, face, y };
    // 버튼을 누르면 걸어가지 않고 바로 그 자리에 앉거나 눕는다
    c.group.position.x = x;
    c.group.position.z = z;
    c.target.set(x, 0, z);
    c.group.rotation.y = face;
    if (id === this.meId && this.localPos) {
      this.localPos.x = x;
      this.localPos.z = z;
    }
  }

  /** 지금 내 위치 이름 (자유 구경 HUD 용) */
  placeOf(pos) {
    for (const h of this.houses ?? []) if (pos.x > h.minX && pos.x < h.maxX && pos.z > h.minZ && pos.z < h.maxZ) return h.name;
    if (Math.hypot(pos.x, pos.z - 0.5) < 6) return '자기소개 마당';
    if (pos.z < -12) return '개울가';
    return '숙소 마을';
  }

  /** 뒤쪽 반원 배치 (앞이 열려 있음) */
  arc(z, i, n) {
    const r = Math.max(1.1, 0.55 * n);
    const span = Math.min(Math.PI * 0.85, 0.75 * (n - 1));
    const a = -Math.PI / 2 - span / 2 + (n > 1 ? (span * i) / (n - 1) : span / 2);
    return new THREE.Vector3(z.x + Math.cos(a) * r, 0, z.z + 0.4 + Math.sin(a) * r * 0.55);
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
      if (c.freePose) {
        c.target.set(c.freePose.x, 0, c.freePose.z);
        c.lookAt = null;
      }
      const d = c.target.clone().sub(g.position);
      d.y = 0;
      const dist = d.length();
      const moving = dist > 0.05;
      if (moving) {
        const step = Math.min(dist, Math.max(dt * 5.5, dist * dt * 3));
        const ox = g.position.x;
        const oz = g.position.z;
        g.position.addScaledVector(d.normalize(), step);
        // 돌아다니는 다른 사람(봇 포함)도 벽·가구를 통과하지 않게. 오래 막히면 목적지로 순간이동
        if (c.roam && id !== this.meId && !c.freePose) {
          this.pushOutOfHouses(g.position);
          const moved = Math.hypot(g.position.x - ox, g.position.z - oz);
          c.stuckT = moved < step * 0.25 ? (c.stuckT ?? 0) + dt : 0;
          if (c.stuckT > 1.2) {
            g.position.set(c.target.x, g.position.y, c.target.z);
            c.stuckT = 0;
          }
        }
        c.face = Math.atan2(d.x, d.z);
      } else if (c.lookAt) {
        c.face = Math.atan2(c.lookAt.x - g.position.x, c.lookAt.z - g.position.z);
      } else if (c.faceFixed != null && !moving) {
        c.face = c.faceFixed;
      }
      if (c.freePose && !moving) c.face = c.freePose.face;
      // 부드러운 회전
      let diff = c.face - g.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      g.rotation.y += diff * Math.min(1, dt * 8);
      // 걷기·앉기·숨쉬기
      const w = t * 10 + c.phase;
      const lying = c.freePose?.kind === 'lie' && !moving;
      const seated = (c.sit || c.freePose?.kind === 'sit') && !moving;
      // 눕기: 몸을 뒤로 눕힘 (머리는 침대 머리판 쪽)
      const tilt = lying ? -Math.PI / 2 : 0;
      g.rotation.x += (tilt - g.rotation.x) * Math.min(1, dt * 8);
      c.ring.visible = c.voiceRing.visible = !lying;
      // 점프
      let jumpY = 0;
      if (c.jumpT > 0) {
        c.jumpT = Math.max(0, c.jumpT - dt);
        const u = 1 - c.jumpT / 0.6;
        jumpY = Math.sin(Math.PI * u) * 1.1;
      }
      g.position.y = (lying ? 0.95 : seated && c.freePose ? (c.freePose.y ?? 0) : 0) + jumpY;
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
          // 생성 모델 리그: 허벅지는 -X 로 돌려야 앞으로 든다 (+X 면 뒤로 꺾임)
          const a = seated ? -1.45 : moving ? Math.sin(w + i * Math.PI) * 0.55 : 0;
          b.quaternion.copy(rest).multiply(q.setFromAxisAngle(X, a));
        });
        c.boneKnees?.forEach(({ b, rest }, i) => {
          const a = seated ? 1.45 : moving ? Math.max(0, Math.sin(w + i * Math.PI + 0.6)) * 0.5 : 0;
          b.quaternion.copy(rest).multiply(q.setFromAxisAngle(X, a));
        });
        c.boneArms?.forEach(({ b, rest }, i) => {
          const a = moving ? Math.sin(w + (1 - i) * Math.PI) * 0.5 : 0;
          b.quaternion.copy(rest).multiply(q.setFromAxisAngle(X, a));
        });
        if (c.mBadges) {
          const mb = c.mBadges;
          const goal = seated ? mb.y + mb.lift : mb.y;
          const y = mb.nb.front.position.y + (goal - mb.nb.front.position.y) * Math.min(1, dt * 10);
          const sc = seated ? 0.82 : 1;
          mb.nb.front.position.set(0, y, mb.fz + (seated ? 0.04 : 0));
          mb.nb.back.position.set(0, y, mb.bz);
          mb.nb.front.scale.setScalar(sc);
          mb.nb.back.scale.setScalar(sc);
        }
        c.model.position.y = seated ? -0.15 : moving ? Math.abs(Math.sin(w)) * 0.07 : Math.sin(t * 2 + c.phase) * 0.012;
        c.mixer?.update(dt);
      }
      const sp = this.speaking.has(id);
      c.body.position.y = seated ? -0.12 : moving ? Math.abs(Math.sin(w)) * 0.07 : Math.sin(t * 2 + c.phase) * 0.012 + (sp ? Math.abs(Math.sin(t * 7)) * 0.03 : 0);
      if (sp && !moving) c.arms[1].rotation.z = -0.18 - Math.abs(Math.sin(t * 2.4)) * 0.6; // 말할 때 손짓
      else c.arms[1].rotation.z = -0.18;
      c.voiceRing.material.opacity = sp ? 0.45 + Math.sin(t * 6) * 0.35 : 0;
      c.group.visible = true;
      // 말풍선 표시 시간
      if (c.bubble) {
        const left = c.bubbleUntil - performance.now();
        c.bubble.material.opacity = Math.max(0, Math.min(1, left / 400));
        if (left <= 0) {
          c.group.remove(c.bubble);
          c.bubble.material.map.dispose();
          c.bubble.material.dispose();
          c.bubble = null;
        }
      }
    }
    // 내 캐릭터가 건물 안이나 뒤에 있으면 지붕·앞벽을 반투명하게
    const me = this.chars.get(this.meId)?.group.position;
    for (const h of this.houses ?? []) {
      const inside = me && me.x > h.minX - 0.3 && me.x < h.maxX + 0.3 && me.z > h.minZ - 0.3 && me.z < h.maxZ + 0.3;
      const behind = me && me.x > h.minX - 1 && me.x < h.maxX + 1 && me.z < h.minZ && me.z > h.minZ - 9;
      const goal = inside ? 0.07 : behind ? 0.2 : 1;
      if (Math.abs(h.fade - goal) > 0.01) {
        h.fade += (goal - h.fade) * Math.min(1, dt * 6);
        h.cover.traverse((o) => {
          if (o.material) {
            o.material.opacity = h.fade;
            o.material.transparent = h.fade < 0.99;
            o.material.depthWrite = h.fade > 0.95;
            o.castShadow = h.fade > 0.95;
          }
        });
      }
    }
    // 카메라와 보고 있는 지점 사이에 있는 나무는 반투명하게 (데이트 장소 등을 가리지 않게)
    {
      const cx = this.camera.position.x;
      const cz = this.camera.position.z;
      const tx = this.camLook.x;
      const tz = this.camLook.z;
      const dx = tx - cx;
      const dz = tz - cz;
      const len2 = dx * dx + dz * dz || 1;
      for (const tr of this.trees ?? []) {
        const t = ((tr.x - cx) * dx + (tr.z - cz) * dz) / len2;
        const px = cx + dx * t - tr.x;
        const pz = cz + dz * t - tr.z;
        const blocks = t > 0 && t < 1.08 && px * px + pz * pz < (tr.r + 1.2) ** 2;
        const goal = blocks ? 0 : 1; // 흐릿한 잔상 대신 완전히 숨김
        if (Math.abs(tr.fade - goal) > 0.01) {
          tr.fade += (goal - tr.fade) * Math.min(1, dt * 6);
          tr.g.visible = tr.fade > 0.03;
          tr.g.traverse((o) => {
            if (o.material) {
              o.material.opacity = tr.fade;
              o.material.depthWrite = tr.fade > 0.95;
            }
          });
          tr.g.traverse((o) => (o.castShadow = tr.fade > 0.95));
        }
      }
    }
    this.animateTreasure(t, dt);
    // 시간대 (아침→밤) 부드럽게 전환
    this.tod ??= this.todTarget ?? 0.4;
    this.tod += ((this.todTarget ?? 0.4) - this.tod) * Math.min(1, dt * 0.8);
    this.applyTimeOfDay(this.tod);
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
    const sa = this.sunAngle ?? 1.2; // 0=동쪽 지평선, π=서쪽
    this.sun.position.set(this.camLook.x + Math.cos(sa) * 20, 6 + Math.sin(sa) * 18, this.camLook.z + 12);
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

// ───────── 시간대 (게임 단계 → 하루 중 시각, 연출 전용) ─────────
const PHASE_TOD = {
  waiting: 0.3, intro: 0.22, firstVote: 0.28, date1: 0.34, freeRoam: 0.42, selfIntro: 0.52, date2: 0.6, minigame: 0.66,
  date3Pick: 0.7, date3: 0.75, randomAssign: 0.8, date4: 0.85, finalChoice: 0.9, result: 0.93, contact: 0.95, ended: 0.97,
};
export function timeOfPhase(phase) {
  return PHASE_TOD[phase] ?? 0.4;
}
export function timeLabel(t) {
  if (t < 0.33) return '🌅 아침';
  if (t < 0.52) return '☀️ 낮';
  if (t < 0.7) return '🌤 오후';
  if (t < 0.84) return '🌇 저녁';
  return '🌙 밤';
}
const TOD_KEYS = [
  { t: 0.2, top: '#86bdf0', bottom: '#fde3c8', sun: '#ffdcae', sunI: 2.0, hemiSky: '#fff0e0', hemiGround: '#86a06a', hemi: 1.4, lamp: 0.2, window: 0, cloud: 1, sunAngle: 0.5 },
  { t: 0.45, top: '#5aa7ec', bottom: '#d9eefc', sun: '#fff3dd', sunI: 2.4, hemiSky: '#fff6e8', hemiGround: '#7f9a62', hemi: 1.6, lamp: 0.2, window: 0, cloud: 1, sunAngle: 1.45 },
  { t: 0.64, top: '#6f86cc', bottom: '#f6b17c', sun: '#ffb377', sunI: 1.8, hemiSky: '#ffd9bd', hemiGround: '#7a8a5a', hemi: 1.15, lamp: 0.9, window: 0.3, cloud: 0.9, sunAngle: 2.45 },
  { t: 0.8, top: '#3a4a8a', bottom: '#c4849f', sun: '#e0a6d6', sunI: 1.05, hemiSky: '#b4a6e0', hemiGround: '#5a665c', hemi: 1.0, lamp: 2.2, window: 1.0, cloud: 0.5, sunAngle: 2.9 },
  { t: 0.95, top: '#121c42', bottom: '#33427a', sun: '#b3c4ff', sunI: 0.7, hemiSky: '#97a8ff', hemiGround: '#38434e', hemi: 0.75, lamp: 2.8, window: 1.4, cloud: 0.25, sunAngle: 1.9 },
].map((k) => ({ ...k, top: new THREE.Color(k.top), bottom: new THREE.Color(k.bottom), sun: new THREE.Color(k.sun), hemiSky: new THREE.Color(k.hemiSky), hemiGround: new THREE.Color(k.hemiGround) }));
const _tod = { top: new THREE.Color(), bottom: new THREE.Color(), sun: new THREE.Color(), hemiSky: new THREE.Color(), hemiGround: new THREE.Color() };
function sampleTod(t) {
  let i = 0;
  while (i < TOD_KEYS.length - 2 && t > TOD_KEYS[i + 1].t) i++;
  const a = TOD_KEYS[i];
  const b = TOD_KEYS[i + 1];
  const f = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  const out = {};
  for (const c of ['top', 'bottom', 'sun', 'hemiSky', 'hemiGround']) out[c] = _tod[c].lerpColors(a[c], b[c], f);
  for (const n of ['sunI', 'hemi', 'lamp', 'window', 'cloud', 'sunAngle']) out[n] = a[n] + (b[n] - a[n]) * f;
  return out;
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
/**
 * AI 생성 모델(Meshy 등)은 텍스처 조각(UV 섬)이 여백 없이 촘촘히 붙어 있어,
 * 축소판(밉맵)에서 옆 조각 색이 섞여 머리에 노란 줄, 바지에 흰 줄 같은 금이 생긴다.
 * 밉맵을 끄면 사라진다 (Higgsfield 샌드박스 렌더 비교로 확인).
 */
export function disableMipmaps(gltf) {
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
        const t = m?.[k];
        if (t && t.generateMipmaps !== false) {
          t.generateMipmaps = false;
          t.minFilter = THREE.LinearFilter;
          t.needsUpdate = true;
        }
      }
    }
  });
}

function makeBadges(alias, gender) {
  const tex = labelTexture(alias, { size: 56, bg: '#fffaf2', color: gender === 'male' ? '#2f4f7f' : '#9a3f55', pad: 18, radius: 14 });
  const w = Math.min(0.62, 0.17 * alias.length + 0.18);
  const h = (w * tex.image.height) / tex.image.width;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 });
  const front = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  back.rotation.y = Math.PI;
  return { front, back };
}

function bubbleSprite(text) {
  const t = String(text).slice(0, 40);
  // 한 줄 최대 14자, 최대 2줄
  const lines = [];
  for (let i = 0; i < t.length && lines.length < 2; i += 14) lines.push(t.slice(i, i + 14));
  if (t.length > 28) lines[1] = lines[1].slice(0, 13) + '…';
  const size = 40;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `700 ${size}px "Pretendard","Apple SD Gothic Neo","Noto Sans KR",sans-serif`;
  ctx.font = font;
  const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + 44;
  const lh = size * 1.3;
  const bh = Math.ceil(lh * lines.length + 26);
  c.width = Math.max(w, 90);
  c.height = bh + 22;
  ctx.font = font;
  ctx.fillStyle = 'rgba(255,255,255,0.97)';
  ctx.strokeStyle = 'rgba(58,46,37,0.25)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(2, 2, c.width - 4, bh - 2, 22);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath(); // 꼬리
  ctx.moveTo(c.width / 2 - 14, bh - 2);
  ctx.lineTo(c.width / 2, bh + 18);
  ctx.lineTo(c.width / 2 + 14, bh - 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#3a2e25';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, c.width / 2, 13 + lh * i + lh / 2));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const H = 0.26 * (c.height / 60);
  sp.scale.set((H * c.width) / c.height, H, 1);
  sp.center.set(0.5, 0);
  sp.renderOrder = 11;
  return sp;
}

function labelSprite(text) {
  const tex = labelTexture(text, { size: 44, bg: 'rgba(255,252,246,0.95)', color: '#3a2e25', pad: 22 });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const h = 0.34;
  sp.scale.set((h * tex.image.width) / tex.image.height, h, 1);
  sp.renderOrder = 10;
  return sp;
}

/** 가운데가 밝고 바깥으로 사라지는 원 (보물 빛) */
function radialTexture(inner, mid) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner);
  gr.addColorStop(0.35, mid);
  gr.addColorStop(1, 'rgba(255,214,120,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 작은 십자 반짝이 */
function starTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,240,1)');
  gr.addColorStop(0.25, 'rgba(255,240,180,0.6)');
  gr.addColorStop(1, 'rgba(255,240,180,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = 'rgba(255,255,240,0.9)';
  g.fillRect(15, 2, 2, 28);
  g.fillRect(2, 15, 28, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
