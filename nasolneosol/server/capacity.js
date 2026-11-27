import fs from 'node:fs';
import path from 'node:path';
export function makeGate(id, env, size, managed, dir) {
  const limit = (v) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const policy = {
    maxRooms: limit(env.MAX_ROOMS),
    maxPlayers: limit(env.MAX_PLAYERS),
    maintenance: false,
    blocked: false,
    enabled: true,
    recoverySeconds: 30,
    staleSeconds: 15,
    cpuLimit: 70,
    coreLimit: 95,
    memoryLimit: 80,
    latencyIncreasePct: 10,
    queueTtlSeconds: 600,
    recoveryMarginPct: 5,
    gameLimitMs: 100,
    minAvailableMiB: 0,
    monthlyBudgetWon: 0,
    tripSeconds: 0
  };
  const stateFile = dir && path.join(dir, `capacity-${id}.json`);
  const validSetting = ([k, v]) =>
    Object.hasOwn(policy, k) &&
    (typeof policy[k] === 'boolean'
      ? typeof v === 'boolean'
      : Number.isSafeInteger(v) &&
        v >= 0 &&
        (!['cpuLimit', 'coreLimit', 'memoryLimit', 'recoveryMarginPct'].includes(k) || v <= 100) &&
        (!['staleSeconds', 'queueTtlSeconds'].includes(k) || v > 0));
  let audit = [];
  if (managed && stateFile && fs.existsSync(stateFile)) {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!Object.entries(saved.policy).every(validSetting) || !Array.isArray(saved.audit))
      throw new Error('Invalid capacity policy');
    Object.assign(policy, saved.policy);
    audit = saved.audit.slice(-200);
  }
  let lastMetrics = null;
  let metadata = null;
  const numeric = [
    'availableBytes',
    'swapUsedBytes',
    'rxBps',
    'txBps',
    'rxBytes',
    'txBytes',
    'diskReadBps',
    'diskWriteBps',
    'diskAwaitMs',
    'apiP50Ms',
    'apiP95Ms',
    'apiP99Ms',
    'apiErrorRate',
    'baselineP95Ms',
    'gameP95Ms',
    'gameErrorRate',
    'contractMbps',
    'monthlyBytes',
    'projectedOverageWon',
    'budgetWon',
    'drops'
  ];

  let lastSample = 0;
  let healthySince = 0;
  let hotSince = null;
  let lastGateReason;
  let protection = '상태 미수신';
  function record(action, detail) {
    audit.push({ at: Date.now(), action, detail });
    if (audit.length > 200) audit.shift();
    if (stateFile) {
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify({ policy, audit }), { mode: 0o600 });
      fs.renameSync(stateFile + '.tmp', stateFile);
    }
  }
  function noteReason(reason) {
    if (reason !== lastGateReason) {
      record(reason ? '신규 입장 제한' : '신규 입장 허용', reason || '복귀');
      lastGateReason = reason;
    }
  }
  function snapshot(active, queued, extra = 1, forming = false) {
    const playing = active * size;
    const used = playing + queued;
    let reason = '';
    if (managed) {
      if (!policy.enabled || policy.maintenance) reason = '점검';
      else if (policy.blocked) reason = '수동 차단';
      else if (Date.now() - lastSample > policy.staleSeconds * 1000) reason = '상태 미수신';
      else if (protection) reason = protection;
      else if (
        active >= policy.maxRooms ||
        playing + size > policy.maxPlayers ||
        (!forming && used + extra > Math.min(policy.maxPlayers, policy.maxRooms * size))
      )
        reason = '정원';
    }
    const ratio =
      managed && policy.maxPlayers ? used / Math.min(policy.maxPlayers, policy.maxRooms * size) : 0;
    const status =
      reason === '점검' ? reason : reason ? 'FULL' : ratio >= 0.8 ? '혼잡' : ratio >= 0.5 ? '보통' : '원활';
    return {
      status,
      reason,
      active,
      playing,
      queued: queued,
      lastSample,
      ...policy,
      id,
      freeRooms: Math.max(
        0,
        Math.min(policy.maxRooms - active, Math.floor((policy.maxPlayers - playing - queued) / size))
      )
    };
  }

  function sample(m) {
    const now = Date.now();
    const fields = ['cpuPct', 'corePeakPct', 'memPct', 'p95Ratio', 'errorRatio'];
    if (
      !m ||
      !Number.isSafeInteger(m.at) ||
      m.at <= lastSample ||
      m.at > now ||
      now - m.at > 10000 ||
      fields.some((k) => !Number.isFinite(m[k]) || m[k] < 0) ||
      typeof m.ioOk !== 'boolean' ||
      typeof m.networkOk !== 'boolean' ||
      typeof m.budgetOk !== 'boolean'
    )
      throw new RangeError('측정값 오류');
    if (
      m.details !== undefined &&
      (!m.details ||
        typeof m.details !== 'object' ||
        Array.isArray(m.details) ||
        Object.entries(m.details).some(([k, v]) =>
          k === 'cores'
            ? !Array.isArray(v) || v.length > 256 || v.some((x) => !Number.isFinite(x) || x < 0 || x > 100)
            : !numeric.includes(k) || !Number.isFinite(v) || v < 0
        ))
    )
      throw new RangeError('세부 측정값 오류');
    metadata = m.details ?? null;
    if (now - lastSample > policy.staleSeconds * 1000) {
      healthySince = 0;
      hotSince = null;
      protection = '상태 미수신';
    }
    lastSample = m.at;
    lastMetrics = Object.fromEntries([...fields, 'ioOk', 'networkOk', 'budgetOk'].map((k) => [k, m[k]]));
    const reserveExceeded =
      policy.minAvailableMiB > 0 && !(m.details?.availableBytes >= policy.minAvailableMiB * 1048576);
    const overBudget =
      policy.monthlyBudgetWon > 0 && !(m.details?.projectedOverageWon <= policy.monthlyBudgetWon);
    const risk =
      !m.budgetOk || overBudget
        ? '비용 한도'
        : m.p95Ratio >= 1 + policy.latencyIncreasePct / 100 || m.errorRatio > 1
          ? '기존 서비스 보호'
          : m.cpuPct >= policy.cpuLimit ||
              m.corePeakPct >= policy.coreLimit ||
              m.memPct >= policy.memoryLimit ||
              reserveExceeded ||
              !m.ioOk ||
              !m.networkOk
            ? '자원'
            : '';
    const issue = risk || (m.details?.gameP95Ms > policy.gameLimitMs ? '게임 응답 지연' : '');
    let next = protection;
    if (issue) {
      hotSince ??= now;
      healthySince = 0;
      if (issue === '비용 한도' || !m.networkOk || !m.ioOk || now - hotSince >= policy.tripSeconds * 1000)
        next = issue;
    } else {
      hotSince = null;
      const factor = 1 - policy.recoveryMarginPct / 100;
      const recovered =
        m.cpuPct <= policy.cpuLimit * factor &&
        m.corePeakPct <= policy.coreLimit * factor &&
        m.memPct <= policy.memoryLimit * factor &&
        m.p95Ratio <= 1 + (policy.latencyIncreasePct * factor) / 100;
      if (!recovered) healthySince = 0;
      else if (!healthySince) healthySince = now;
      if (protection)
        next = healthySince && now - healthySince >= policy.recoverySeconds * 1000 ? '' : '복귀 대기';
    }
    if (next !== protection) record('보호 상태', next);
    protection = next;
  }
  function configure(input) {
    if (!input || !Object.keys(input).length || !Object.entries(input).every(validSetting))
      throw new RangeError('설정값 오류');
    const before = { ...policy };
    Object.assign(policy, input);
    try {
      record('설정 변경', input);
    } catch (error) {
      Object.assign(policy, before);
      throw error;
    }
  }
  function invalidate(reason) {
    lastSample = 0;
    healthySince = 0;
    if (protection !== reason) record('보호 상태', reason);
    protection = reason;
  }
  return {
    snapshot,
    configure,
    sample,
    invalidate,
    noteReason,
    policy,
    details: () => ({ audit, lastMetrics, metrics: metadata })
  };
}
