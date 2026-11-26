// PWA·로그인 공급자용 아이콘 생성. npm run icons
// 원본: scripts/assets/icon-source.webp (둥근 카드 + 검은 모서리)
// 카드만 잘라 낸 뒤, 모서리는 같은 그림을 흐리게 키운 배경으로 채워서 꽉 찬 정사각형으로 만든다.
import sharp from 'sharp';
import fs from 'node:fs';

const SRC = 'scripts/assets/icon-source.webp';
const CARD = { left: 18, top: 18, width: 1212, height: 1217 }; // 원본에서 카드가 차지하는 영역
const RADIUS = 0.27;   // 카드 모서리 둥글기 (한 변 대비)
const INSET = 0.012;   // 카드 테두리 선을 지우려고 살짝 안쪽만 쓴다
const M = 1024;        // 작업 해상도

const card = await sharp(SRC).extract(CARD).resize(M, M).png().toBuffer();

async function square(scale = 1) {
  const bg = await sharp(card).resize(Math.round(M * 1.25)).extract({ left: Math.round(M * 0.125), top: Math.round(M * 0.125), width: M, height: M })
    .blur(40).modulate({ brightness: 1.05 }).png().toBuffer();
  const s = Math.round(M * scale);
  const i = Math.round(s * INSET);
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><rect x="${i}" y="${i}" width="${s - 2 * i}" height="${s - 2 * i}" rx="${s * RADIUS}" fill="#fff"/></svg>`);
  const fg = await sharp(card).resize(s, s).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const off = Math.round((M - s) / 2);
  return sharp(bg).composite([{ input: fg, left: off, top: off }]).png().toBuffer();
}

const full = await square(1);
const safe = await square(0.82); // maskable: 가운데 80% 원 안에 글자가 들어오게

const out = 'client/public/icons';
fs.mkdirSync(out, { recursive: true });
const png = { palette: true, quality: 92, compressionLevel: 9 }; // 색 수만 줄여서 용량 약 1/3
await sharp(full).resize(192).png(png).toFile(`${out}/icon-192.png`);
await sharp(full).resize(512).png(png).toFile(`${out}/icon-512.png`);
await sharp(safe).resize(512).png(png).toFile(`${out}/icon-maskable-512.png`);
await sharp(full).resize(180).png(png).toFile(`${out}/apple-touch-icon.png`);
// 카카오·구글 콘솔 업로드용 (저장소 밖으로 내보내지 않는다)
fs.mkdirSync('scripts/assets/out', { recursive: true });
await sharp(full).resize(512).png(png).toFile('scripts/assets/out/provider-512.png');
await sharp(full).resize(120).png(png).toFile('scripts/assets/out/provider-120.png');
console.log('icons ok');
