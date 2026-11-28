import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../server/index.js';
import { FileStore } from '../server/store.js';
import { consumeEntry, entryStatus } from '../server/wallet.js';

test('interrupted admissions are reconciled once across two restarts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nasol-reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  const users = ['r123', 'r124'].map((roomId) => {
    const user = store.createUser({ birthDate: '1995-06-15', gender: 'female', age: 30, job: 'fixture', region: 'fixture' });
    user.pendingGameEntry = { roomId, kind: consumeEntry(user) };
    return user.id;
  });
  store.persist();
  store.saveGameRecord('r124', { id: 'r124', events: [], matches: [] });
  for (let i = 0; i < 2; i++) {
    const app = createServer({
      env: { DATA_DIR: dir, CAPACITY_MANAGED: '1', GAME_WORKER_1: '', GAME_WORKER_2: '' }
    });
    try {
      assert.equal(entryStatus(app.store.get(users[0])).total, 1);
      assert.equal(entryStatus(app.store.get(users[1])).total, 0);
      assert(users.every((id) => !app.store.get(id).pendingGameEntry));
    } finally {
      app.close();
    }
  }
});
