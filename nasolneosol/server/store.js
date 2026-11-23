// 회원·프로필·사진·회차 기록 저장소.
//
// 시제품: 메모리 + data/ 폴더 JSON 파일.  [임시]
// 실제 서비스에서는 같은 메서드를 가진 SupabaseStore(또는 PostgreSQL) 로 교체한다.
// 아이팩트 회원 데이터와는 공유하지 않는다 (독립 서비스 방향).

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_PHOTO_BYTES = 400 * 1024;

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.users = new Map(); // userId → user
    this.tokens = new Map(); // token → userId
    this.photos = new Map(); // photoId → { buf, mime }
    if (dir) {
      fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'games'), { recursive: true });
      this.load();
    }
  }

  load() {
    const f = path.join(this.dir, 'users.json');
    if (!fs.existsSync(f)) return;
    for (const u of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      this.users.set(u.id, u);
      this.tokens.set(u.token, u.id);
    }
  }

  persist() {
    if (!this.dir) return;
    const real = [...this.users.values()].filter((u) => !u.isBot);
    fs.writeFileSync(path.join(this.dir, 'users.json'), JSON.stringify(real, null, 1));
  }

  createUser(profile, { isBot = false } = {}) {
    const id = randomUUID();
    const token = randomBytes(24).toString('base64url');
    const user = { id, token, isBot, createdAt: Date.now(), profile };
    this.users.set(id, user);
    this.tokens.set(token, id);
    this.persist();
    return user;
  }

  byToken(token) {
    const id = this.tokens.get(token);
    return id ? this.users.get(id) : null;
  }

  get(id) {
    return this.users.get(id) ?? null;
  }

  updateProfile(id, patch) {
    const u = this.users.get(id);
    Object.assign(u.profile, patch);
    this.persist();
    return u;
  }

  /** @returns {string} photoUrl */
  savePhoto(buf, mime) {
    if (buf.length > MAX_PHOTO_BYTES) throw new Error('사진 용량이 너무 크다');
    const photoId = randomBytes(16).toString('hex'); // 추측하기 어려운 ID
    this.photos.set(photoId, { buf, mime });
    if (this.dir && mime !== 'image/svg+xml') fs.writeFileSync(path.join(this.dir, 'photos', `${photoId}`), buf);
    return `/photos/${photoId}`;
  }

  getPhoto(photoId) {
    if (!/^[0-9a-f]{32}$/.test(photoId)) return null;
    const p = this.photos.get(photoId);
    if (p) return p;
    if (this.dir) {
      const f = path.join(this.dir, 'photos', photoId);
      if (fs.existsSync(f)) {
        const buf = fs.readFileSync(f);
        const mime = sniffImage(buf);
        if (mime) return { buf, mime };
      }
    }
    return null;
  }

  saveGameRecord(roomId, record) {
    if (!this.dir) return;
    fs.writeFileSync(path.join(this.dir, 'games', `${roomId}.json`), JSON.stringify(record, null, 1));
  }
}

export function sniffImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.slice(1, 4).toString() === 'PNG') return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function decodeDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw new Error('사진 형식이 올바르지 않다 (jpeg/png/webp)');
  const buf = Buffer.from(m[2], 'base64');
  const mime = sniffImage(buf);
  if (!mime) throw new Error('이미지 파일이 아니다');
  return { buf, mime };
}

/** 프로필 입력 검증. 실명·상세주소·연락처·생년월일은 받지 않는다. */
export function validateProfile(input, { minAge, partial = false }) {
  const out = {};
  if (!partial || input.gender != null) {
    if (!['male', 'female'].includes(input.gender)) throw new Error('성별을 선택해 줘');
    out.gender = input.gender;
  }
  if (!partial || input.age != null) {
    const age = Number(input.age);
    if (!Number.isInteger(age) || age < minAge || age > 80) throw new Error(`나이는 ${minAge}~80 사이 숫자로 입력해 줘`);
    out.age = age;
  }
  for (const [k, label, max] of [['job', '직업', 20], ['region', '사는 곳', 20]]) {
    if (!partial || input[k] != null) {
      const v = String(input[k] ?? '').trim();
      if (!v) throw new Error(`${label}을(를) 입력해 줘`);
      if (v.length > max) throw new Error(`${label}은(는) ${max}자 이내로 입력해 줘`);
      out[k] = v;
    }
  }
  return out;
}
