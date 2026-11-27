import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Replay the public SSR function with fixture tracks and three queries from api_card_price.
// The caller supplies its local renderer.mjs checkout. Never open an existing SQLite file.
const rendererPath = process.argv[2];
assert(
  rendererPath && path.isAbsolute(rendererPath),
  'pass an absolute path to the local AIFECT renderer.mjs'
);
const profile = Number(process.argv[3] || 1);
assert([1, 2].includes(profile));
const { render } = await import(pathToFileURL(rendererPath));
const tracks = Array.from({ length: 24 }, (_, i) => ({
  id: 'fixture-' + i,
  title: 'fixture track ' + i,
  artist: 'fixture',
  kind: 'original',
  genre: 'pop',
  duration: 180
}));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nasol-service-replay-'));
const db = new DatabaseSync(path.join(scratch, 'fixture.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE card_price_daily(card_id TEXT,region TEXT,date INT,raw_avg_price INT,raw_lowest_price INT);
  CREATE INDEX history ON card_price_daily(card_id,region,date);
  CREATE TABLE price_listings(card_id TEXT,region TEXT,status TEXT,price INT);
  CREATE INDEX listings ON price_listings(card_id,region,status,price)`);
const day = db.prepare("INSERT INTO card_price_daily VALUES(?, 'KR', ?, ?, ?)");
const listing = db.prepare("INSERT INTO price_listings VALUES(?, 'KR','active',?)");
let offset = 0;
function writeListings(n) {
  db.exec('BEGIN');
  for (let j = 0; j < n; j++, offset++) {
    const id = String(offset % 128);
    day.run(id, offset, offset % 32013, offset % 19073);
    listing.run(id, offset % 19073);
  }
  db.exec('COMMIT');
}
writeListings(50000);
const queries = [
  'SELECT * FROM card_price_daily WHERE card_id=? AND region=? ORDER BY date DESC LIMIT 1',
  'SELECT date,raw_avg_price,raw_lowest_price FROM card_price_daily WHERE card_id=? AND region=? ORDER BY date DESC LIMIT 30',
  "SELECT * FROM price_listings WHERE card_id=? AND region=? AND status='active' ORDER BY price ASC LIMIT 10"
].map((sql) => db.prepare(sql));
const server = http.createServer(async (req, res) => {
  try {
    const result =
      req.url === '/prices'
        ? JSON.stringify(queries.map((q) => q.all('31', 'KR')))
        : await (await render('/music', { tracks }, '<main></main>')).text();
    res.end(result);
  } catch {
    res.writeHead(500);
    res.end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => {
  assert.equal(new URL(url).origin, base, 'only loopback fixture calls are allowed');
  return originalFetch(url, ...args);
};
const quantile = (a, q) => a.sort((l, r) => l - r)[Math.ceil(a.length * q) - 1];
let round = 0;
async function window(seconds) {
  const data = { prices: [], music: [] };
  const end = performance.now() + seconds * 1000;
  do {
    for (const route of Object.keys(data)) {
      await Promise.all(
        Array.from({ length: profile }, async () => {
          const start = performance.now();
          const res = await fetch(base + '/' + route, { signal: AbortSignal.timeout(2000) });
          const body = await res.text();
          assert.equal(res.status, 200);
          assert(route === 'music' ? body.includes('fixture track 0') : JSON.parse(body)[1].length === 30);
          data[route].push(performance.now() - start);
        })
      );
    }
    if (++round % 16 === 0) writeListings(128 * profile);
    await delay(45);
  } while (performance.now() < end);
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k,
      { n: v.length, p50: quantile(v, 0.5), p95: quantile(v, 0.95), p99: quantile(v, 0.99) }
    ])
  );
}
let game = null;
try {
  await window(2);
  const baseline = await window(15);
  console.log(JSON.stringify({ profile, baseline }));
  game = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./simulate.js', import.meta.url)),
      '60',
      'threeDates',
      '10',
      'both',
      'walking',
      'disk'
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  let strikes = 0,
    stopped = false;
  while (game.exitCode === null && game.signalCode === null) {
    const metrics = await window(5);
    const ratios = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, v.p95 / baseline[k].p95]));
    strikes = Object.values(ratios).some((r) => r >= 1.1) ? strikes + 1 : 0;
    console.log(JSON.stringify({ metrics, ratios, strikes }));
    if (strikes >= 3 && game.exitCode === null && game.signalCode === null) {
      stopped = true;
      const exited = once(game, 'exit');
      game.kill();
      await exited;
      break;
    }
  }
  console.log(JSON.stringify({ stopped, gameExit: game.exitCode, writtenRows: (offset - 50000) * 2 }));
  if (stopped || game.exitCode !== 0) process.exitCode = 1;
} finally {
  if (game && game.exitCode === null && game.signalCode === null) game.kill();
  server.closeAllConnections();
  server.close();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
