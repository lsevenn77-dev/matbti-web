"""Combine Linux counters and a fresh, externally measured API/billing observation.
Default is stdout. --push-port posts only to a local coordinator or local tunnel.
"""
import argparse
import http.client
import json
import math
import os
from pathlib import Path
import time
from host_sample import measure, read_host

def metrics(host, evidence, now):
    """Missing, stale or inconsistent evidence fails closed by suppressing the heartbeat."""
    fields=['at','apiP50Ms','apiP95Ms','apiP99Ms','apiErrorRate','baselineP95Ms','baselineErrorRate',
            'contractMbps','monthlyBytes','projectedOverageWon','budgetWon','diskAwaitLimitMs','minAvailableBytes']
    for field in fields:
        value=evidence[field]
        if type(value) not in (float,int) or not math.isfinite(value) or value<0:
            raise ValueError('Invalid '+field)
    if not 0<=now-evidence['at']<=10000 or evidence['baselineP95Ms']<=0 or evidence['contractMbps']<=0:
        raise ValueError('Expired or incomplete baseline')
    if not 0<=evidence['apiP50Ms']<=evidence['apiP95Ms']<=evidence['apiP99Ms']:
        raise ValueError('Invalid response time percentiles')
    if max(evidence['apiErrorRate'],evidence['baselineErrorRate'])>1:raise ValueError('Invalid error fraction')
    disk=list(host['disks'].values())
    await_ms=max((v for row in disk for k,v in row.items() if k.endswith('AwaitMs') and v is not None),default=0)
    detail={k:host[k] for k in ['cores','availableBytes','swapUsedBytes','rxBps','txBps','rxBytes','txBytes','drops']}
    detail.update({k:evidence[k] for k in fields[1:] if k not in ['baselineErrorRate','diskAwaitLimitMs','minAvailableBytes']})
    detail.update(diskReadBps=sum(d['readBps'] for d in disk),diskWriteBps=sum(d['writeBps'] for d in disk),diskAwaitMs=await_ms)
    error,baseline=evidence['apiErrorRate'],evidence['baselineErrorRate']
    return {'at':now,'cpuPct':host['cpuPct'],'corePeakPct':max(host['cores']),'memPct':host['memPct'],
            'p95Ratio':evidence['apiP95Ms']/evidence['baselineP95Ms'],
            'errorRatio':error/baseline if baseline else (2 if error else 0),
            'ioOk':bool(disk) and await_ms<=evidence['diskAwaitLimitMs'] and host['availableBytes']>=evidence['minAvailableBytes'],
            'networkOk':host['drops']==0 and host['errors']==0 and max(host['rxBps'],host['txBps'])*8<=evidence['contractMbps']*1e6,
            'budgetOk':evidence['projectedOverageWon']<=evidence['budgetWon'],'details':detail}

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--evidence',required=True,type=Path)
    parser.add_argument('--nic',default='eno1')
    parser.add_argument('--server',required=True,type=int)
    parser.add_argument('--count',default=1,type=int)
    parser.add_argument('--push-port',type=int)
    args=parser.parse_args()
    if not 1<=args.count<=17280 or not 0<args.server<=9999:parser.error('invalid count/server')
    prior=read_host(args.nic)
    for i in range(args.count):
        time.sleep(5)
        current=read_host(args.nic)
        host=measure(prior,current);prior=current
        try:
            packet=metrics(host,json.loads(args.evidence.read_text()),int(time.time()*1000))
            if args.push_port:
                conn=http.client.HTTPConnection('127.0.0.1',args.push_port,timeout=2)
                try:
                    conn.request('POST','/api/admin/health-sample?server='+str(args.server),json.dumps(packet),
                                 {'Content-Type':'application/json','x-monitor-key':os.environ['MONITOR_KEY']})
                    reply=conn.getresponse();reply.read()
                    if reply.status!=200:raise RuntimeError('monitor submission rejected')
                finally:conn.close()
            else: print(json.dumps(packet),flush=True)
        except (OSError,KeyError,ValueError,RuntimeError) as err:
            print(json.dumps({'sample':'unavailable','category':type(err).__name__}),flush=True)
