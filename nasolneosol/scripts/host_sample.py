"""Read Linux host counters. Writes only JSON lines to stdout. No packages or agent installation."""
import argparse
import json
import os
from pathlib import Path
import time

def read_host(nic):
    cpu = {}
    for line in Path('/proc/stat').read_text().splitlines():
        key, *values = line.split()
        if key.startswith('cpu'):
            # guest and guest_nice are already included in user/nice.
            cpu[key] = list(map(int, values[:8]))
    mem = {key.rstrip(':'): int(value) for key, value, *_ in
           (line.split() for line in Path('/proc/meminfo').read_text().splitlines())}
    net = {name: int((Path('/sys/class/net') / nic / 'statistics' / name).read_text())
           for name in ['rx_bytes','tx_bytes','rx_dropped','tx_dropped','rx_errors','tx_errors']}
    disk = {p.name: list(map(int,(p/'stat').read_text().split()))
            for p in Path('/sys/block').iterdir() if not p.name.startswith(('loop','ram','dm-','sr'))}
    return time.monotonic(), cpu, mem, net, disk

def measure(before, after):
    start, old_cpu, _, old_net, old_disk = before
    end, cpu, mem, net, disk = after
    seconds = end - start
    busy = {}
    for key, fields in cpu.items():
        if key not in old_cpu: continue
        diff = [b-a for a,b in zip(old_cpu[key],fields)]
        if sum(diff) > 0:
            busy[key] = round(100*(1-(diff[3]+diff[4])/sum(diff)),2)
    delta = {k:net[k]-old_net[k] for k in net}
    devices = {}
    for key, fields in disk.items():
        if key not in old_disk: continue
        d=[b-a for a,b in zip(old_disk[key],fields)]
        devices[key]={'readBps':round(d[2]*512/seconds),'writeBps':round(d[6]*512/seconds),
                      'readAwaitMs':round(d[3]/d[0],3) if d[0] else None,
                      'writeAwaitMs':round(d[7]/d[4],3) if d[4] else None,
                      'busyPct':round(d[9]/(seconds*10),2)}
    return {'at':round(time.time()*1000),'seconds':round(seconds,3),'cpuPct':busy.pop('cpu'),
            'cores':list(busy.values()),'memPct':round(100*(1-mem['MemAvailable']/mem['MemTotal']),2),
            'availableBytes':mem['MemAvailable']*1024,'swapUsedBytes':(mem['SwapTotal']-mem['SwapFree'])*1024,
            'rxBps':round(delta['rx_bytes']/seconds),'txBps':round(delta['tx_bytes']/seconds),
            'rxBytes':net['rx_bytes'],'txBytes':net['tx_bytes'],
            'drops':delta['rx_dropped']+delta['tx_dropped'],'errors':delta['rx_errors']+delta['tx_errors'],
            'disks':devices}

if __name__ == '__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('--nic',default='eno1')
    ap.add_argument('--interval',type=int,default=5)
    ap.add_argument('--count',type=int,default=1)
    args=ap.parse_args()
    if not (1<=args.count<=1440 and 1<=args.interval<=300): ap.error('invalid interval/count')
    before=read_host(args.nic)
    for _ in range(args.count):
        time.sleep(args.interval)
        current=read_host(args.nic)
        print(json.dumps(measure(before,current),separators=(',',':')),flush=True)
        before=current
