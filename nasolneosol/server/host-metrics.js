import os from 'node:os';
import fs from 'node:fs';

function linuxCounters() {
  const route = fs
    .readFileSync('/proc/net/route', 'utf8')
    .split('\n')
    .map((x) => x.trim().split(/\s+/))
    .find((parts) => parts[1] === '00000000');
  if (!route || !/^[A-Za-z0-9_.:-]+$/.test(route[0])) return null;
  const root = '/sys/class/net/' + route[0] + '/statistics/';
  const read = (key) => Number(fs.readFileSync(root + key, 'utf8').trim());
  const mem = Object.fromEntries(
    [...fs.readFileSync('/proc/meminfo', 'utf8').matchAll(/^(\w+):\s+(\d+) kB/gm)].map((m) => [
      m[1],
      Number(m[2]) * 1024
    ])
  );
  return {
    rxBytes: read('rx_bytes'),
    txBytes: read('tx_bytes'),
    availableBytes: mem.MemAvailable,
    swapUsedBytes: mem.SwapTotal - mem.SwapFree
  };
}
export function hostMonitor() {
  let last;
  return () => {
    const now = Date.now(),
      cpus = os.cpus().map((c) => c.times);
    let linux = null;
    if (process.platform === 'linux') {
      try {
        linux = linuxCounters();
      } catch {}
    }
    const row = { at: now, availableBytes: linux?.availableBytes ?? os.freemem(), ...linux };
    if (last && last.cpus.length === cpus.length) {
      row.cores = cpus.map((c, i) => {
        const old = last.cpus[i],
          total = Object.keys(c).reduce((sum, k) => sum + c[k] - old[k], 0);
        return total > 0 ? Math.round(1000 * (1 - (c.idle - old.idle) / total)) / 10 : null;
      });
      if (linux && last.linux && now > last.now) {
        row.rxBps = Math.max(0, ((linux.rxBytes - last.linux.rxBytes) * 1000) / (now - last.now));
        row.txBps = Math.max(0, ((linux.txBytes - last.linux.txBytes) * 1000) / (now - last.now));
      }
    }
    last = { now, cpus, linux };
    return row;
  };
}
