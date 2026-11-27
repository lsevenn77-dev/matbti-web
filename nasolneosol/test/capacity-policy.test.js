import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGate } from '../server/capacity.js';

test('capacity protects the operator budget, growth reserve and sustained recovery', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const gate = makeGate('2', {}, 12, true, null);
  gate.configure({
    maxRooms: 2,
    maxPlayers: 24,
    recoverySeconds: 1,
    monthlyBudgetWon: 2000,
    minAvailableMiB: 512,
    tripSeconds: 2
  });
  const send = (changes = {}) => {
    t.mock.timers.tick(1000);
    gate.sample({
      at: Date.now(),
      cpuPct: 10,
      corePeakPct: 25,
      memPct: 20,
      p95Ratio: 1,
      errorRatio: 0,
      ioOk: true,
      networkOk: true,
      budgetOk: true,
      details: { availableBytes: 1024 * 1048576, projectedOverageWon: 100 },
      ...changes
    });
    return gate.snapshot(0, 0);
  };
  send();
  assert.equal(send().status, '원활');
  assert.equal(
    send({ details: { projectedOverageWon: 2001, availableBytes: 1024 * 1048576 } }).reason,
    '비용 한도'
  );
  send();
  assert.equal(send().status, '원활');
  for (let i = 0; i < 3; i++) send({ details: { projectedOverageWon: 100, availableBytes: 256 * 1048576 } });
  assert.equal(gate.snapshot(0, 0).reason, '자원');
  send();
  assert.equal(send().status, '원활');
  t.mock.timers.tick(16000);
  assert.equal(gate.snapshot(0, 0).reason, '상태 미수신');
  assert.equal(send().reason, '복귀 대기');
  assert.equal(send().status, '원활');
  assert.throws(() => gate.configure({ memoryLimit: 101 }), RangeError);
  assert.throws(() => gate.sample({}), RangeError);
});
