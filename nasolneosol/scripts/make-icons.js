// PWA 아이콘 생성 (임시 디자인). npm run icons
import sharp from 'sharp';
import fs from 'node:fs';

const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#f6efe4"/>
<g transform="translate(256 256) scale(${1 - pad}) translate(-256 -256)">
  <circle cx="190" cy="230" r="92" fill="#6f95c9"/>
  <circle cx="322" cy="230" r="92" fill="#e0849a"/>
  <path d="M256 196 c-22-40-86-34-86 12 c0 40 52 70 86 98 c34-28 86-58 86-98 c0-46-64-52-86-12z" fill="#fff"/>
  <text x="256" y="420" font-family="sans-serif" font-weight="800" font-size="84" text-anchor="middle" fill="#e98a5d">나솔너솔</text>
</g></svg>`;

const out = 'client/public/icons';
fs.mkdirSync(out, { recursive: true });
await sharp(Buffer.from(svg(0.04))).resize(192).png().toFile(`${out}/icon-192.png`);
await sharp(Buffer.from(svg(0.04))).resize(512).png().toFile(`${out}/icon-512.png`);
await sharp(Buffer.from(svg(0.2))).resize(512).png().toFile(`${out}/icon-maskable-512.png`);
await sharp(Buffer.from(svg(0.06))).resize(180).png().toFile(`${out}/apple-touch-icon.png`);
console.log('icons ok');
