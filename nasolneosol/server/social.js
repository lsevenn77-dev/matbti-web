// 간편 로그인 검증 (구글 · 카카오 · 애플) — 사이그램 api/social_auth.py 와 같은 방식을 Node 로 옮김
// - 구글·애플: 브라우저가 받은 ID 토큰(JWT, RS256)을 공급자 공개키(JWKS)로 서명·발급자·대상(aud)·만료를 검증
// - 카카오: 인가 코드를 REST API 키로 토큰으로 바꾼 뒤, 토큰의 app_id 가 우리 앱인지 확인하고 회원번호를 얻는다
// 공급자 토큰은 저장하지 않는다. 회원 식별값(sub / 카카오 회원번호)만 계정에 연결한다.

import { createPublicKey, createVerify } from 'node:crypto';

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_JWKS = 'https://appleid.apple.com/auth/keys';

export class SocialAuthError extends Error {}

const jwksCache = new Map();
async function jwks(url, force = false) {
  const hit = jwksCache.get(url);
  if (!force && hit && hit.until > Date.now()) return hit.keys;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new SocialAuthError('로그인 제공자 확인에 실패했어');
  const keys = (await r.json()).keys ?? [];
  jwksCache.set(url, { until: Date.now() + 3600_000, keys });
  return keys;
}

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export async function verifyJwt(token, { jwksUrl, audiences, issuers }) {
  if (!audiences.length) throw new SocialAuthError('간편 로그인 설정이 아직 없어');
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new SocialAuthError('올바르지 않은 로그인 토큰이야');
  let header, payload;
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'));
    payload = JSON.parse(b64url(parts[1]).toString('utf8'));
  } catch {
    throw new SocialAuthError('올바르지 않은 로그인 토큰이야');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new SocialAuthError('지원하지 않는 로그인 토큰이야');
  let key = (await jwks(jwksUrl)).find((k) => k.kid === header.kid);
  if (!key) key = (await jwks(jwksUrl, true)).find((k) => k.kid === header.kid); // 키 회전 직후
  if (!key || key.kty !== 'RSA') throw new SocialAuthError('로그인 토큰 서명키를 확인할 수 없어');
  const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(createPublicKey({ key, format: 'jwk' }), b64url(parts[2]));
  if (!ok) throw new SocialAuthError('로그인 토큰 서명이 올바르지 않아');
  const now = Math.floor(Date.now() / 1000);
  if (!(payload.exp > now - 30) || payload.iat > now + 120) throw new SocialAuthError('로그인 토큰이 만료됐어');
  if (!issuers.includes(payload.iss)) throw new SocialAuthError('로그인 토큰 발급자가 올바르지 않아');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.some((a) => audiences.includes(a))) throw new SocialAuthError('다른 앱에서 발급된 로그인 토큰이야');
  if (!payload.sub) throw new SocialAuthError('로그인 사용자 정보를 확인할 수 없어');
  return payload;
}

export function socialConfig(env) {
  const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    googleClientIds: list(env.GOOGLE_OAUTH_CLIENT_IDS),
    appleAudiences: list(env.APPLE_SIGN_IN_AUDIENCES), // 웹은 Services ID
    kakaoRestKey: env.KAKAO_REST_API_KEY || '',
    kakaoClientSecret: env.KAKAO_CLIENT_SECRET || '',
    kakaoAppId: env.KAKAO_APP_ID || '',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  };
}

export async function verifyGoogle(cfg, idToken) {
  const p = await verifyJwt(idToken, { jwksUrl: GOOGLE_JWKS, audiences: cfg.googleClientIds, issuers: ['https://accounts.google.com', 'accounts.google.com'] });
  return { provider: 'google', sub: String(p.sub) };
}

export async function verifyApple(cfg, idToken) {
  const p = await verifyJwt(idToken, { jwksUrl: APPLE_JWKS, audiences: cfg.appleAudiences, issuers: ['https://appleid.apple.com'] });
  return { provider: 'apple', sub: String(p.sub) };
}

export function kakaoAuthorizeUrl(cfg, state) {
  const q = new URLSearchParams({ client_id: cfg.kakaoRestKey, redirect_uri: `${cfg.publicUrl}/auth/kakao/callback`, response_type: 'code', state });
  return `https://kauth.kakao.com/oauth/authorize?${q}`;
}

export async function verifyKakaoCode(cfg, code) {
  if (!cfg.kakaoRestKey || !cfg.kakaoAppId) throw new SocialAuthError('카카오 로그인 설정이 아직 없어');
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.kakaoRestKey, redirect_uri: `${cfg.publicUrl}/auth/kakao/callback`, code });
  if (cfg.kakaoClientSecret) body.set('client_secret', cfg.kakaoClientSecret);
  const tr = await fetch('https://kauth.kakao.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body });
  if (!tr.ok) throw new SocialAuthError('카카오 로그인에 실패했어');
  const { access_token } = await tr.json();
  const auth = { Authorization: `Bearer ${access_token}` };
  const info = await (await fetch('https://kapi.kakao.com/v1/user/access_token_info', { headers: auth })).json();
  if (String(info.app_id ?? '') !== String(cfg.kakaoAppId)) throw new SocialAuthError('다른 앱에서 발급된 카카오 토큰이야');
  const me = await (await fetch('https://kapi.kakao.com/v2/user/me', { headers: auth })).json();
  if (!me.id) throw new SocialAuthError('카카오 회원 정보를 확인할 수 없어');
  return { provider: 'kakao', sub: String(me.id) };
}
