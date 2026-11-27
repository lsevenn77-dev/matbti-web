import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createServer } from '../server/index.js';
const app = createServer({ dataDir: null, env: { CAPACITY_MANAGED: '0', DEV_TOOLS: '0' } });
const port = await app.listen(0);
const paths = [
  '/',
  '/app.js',
  '/style.css',
  '/scene.js',
  '/img/logo.webp',
  '/img/bg-wide.webp',
  '/img/bg-tall.webp',
  '/audio/waiting.mp3',
  '/models/manifest.json',
  '/models/props.json',
  '/vendor/three/three.core.js',
  '/vendor/three/three.module.js'
];
try {
  for (const path of paths) {
    const start = performance.now();
    const r = await fetch('http://127.0.0.1:' + port + path, { redirect: 'error' });
    assert.equal(r.status, 200, path);
    const data = await r.arrayBuffer();
    console.log(
      JSON.stringify({
        path,
        bytes: data.byteLength,
        ms: performance.now() - start,
        cache: r.headers.get('cache-control')
      })
    );
  }
} finally {
  app.close();
}
