import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export class RoomWorker {
  constructor(target, onEvent, onFailure) {
    const local = target === 'local';
    if (!local && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(target))
      throw new Error('Invalid worker SSH alias');
    const args = local
      ? [fileURLToPath(new URL('./room-worker.js', import.meta.url))]
      : [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'ConnectTimeout=5',
          '-o',
          'ServerAliveInterval=5',
          '-o',
          'ServerAliveCountMax=2',
          target,
          'node /opt/nasol-game/server/room-worker.js'
        ];
    this.proc = spawn(local ? process.execPath : 'ssh', args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    });
    this.lastSeen = 0;
    this.pending = new Map();
    this.seq = 0;
    this.received = 0;
    this.sent = 0;
    this.actions = new Array(2048);
    this.actionCount = 0;
    const stop = () => {
      if (this.stopped) return;
      this.stopped = true;
      clearInterval(this.watch);
      for (const cb of this.pending.values()) cb({ ok: false, error: '서버 연결이 종료됐어' });
      this.pending.clear();
      this.proc.kill();
      onFailure();
    };
    this.proc.on('error', stop);
    this.proc.on('exit', stop);
    this.proc.stdin.on('error', stop);
    const lines = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      try {
        this.received += Buffer.byteLength(line) + 1;
        const m = JSON.parse(line);
        if (m.kind === 'ready') {
          this.lastSeen = Date.now();
          this.rss = m.rss;
          this.host = m.host;
          return;
        }
        if (m.kind === 'ack') {
          this.pending.get(m.seq)?.(m);
          this.pending.delete(m.seq);
          return;
        }
        onEvent(m);
      } catch {
        stop();
      }
    });
    const started = Date.now();
    this.watch = setInterval(() => {
      if (Date.now() - (this.lastSeen || started) > 15000) stop();
    }, 1000);
    this.stop = stop;
  }
  get ready() {
    return !this.stopped && Date.now() - this.lastSeen < 7000;
  }
  write(message) {
    if (this.stopped || this.proc.stdin.writableLength > 8 * 1024 * 1024) {
      this.stop();
      return false;
    }
    const line = JSON.stringify(message) + '\n';
    this.sent += Buffer.byteLength(line);
    this.proc.stdin.write(line);
    return true;
  }
  recentActions() {
    const rows = this.actions.filter((r) => r && Date.now() - r.at <= 60000);
    if (!rows.length) return {};
    const times = rows.map((r) => r.ms).sort((a, b) => a - b);
    return {
      gameP95Ms: times[Math.ceil(times.length * 0.95) - 1],
      gameErrorRate: rows.filter((r) => !r.ok).length / rows.length
    };
  }
  action(id, pid, action) {
    const seq = ++this.seq;
    const start = performance.now();
    return new Promise((resolve) => {
      const done = (m) => {
        this.actions[this.actionCount++ % this.actions.length] = {
          at: Date.now(),
          ms: performance.now() - start,
          ok: m.ok
        };
        resolve(m);
      };
      const timeout = setTimeout(() => {
        this.pending.delete(seq);
        done({ ok: false, error: '게임 동작 응답 시간이 초과됐어' });
      }, 5000);
      this.pending.set(seq, (m) => {
        clearTimeout(timeout);
        done(m);
      });
      if (!this.write({ kind: 'act', id, pid, action, seq }) && this.pending.has(seq)) {
        this.pending.get(seq)({ ok: false, error: '게임 서버 연결 실패' });
        this.pending.delete(seq);
      }
    });
  }
}
