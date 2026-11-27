"""Compare a measured room workload. All money amounts retain provider billing currency."""
import argparse
import json
import math
from pathlib import Path

def compare(usage):
    rounds=usage['roomsPerWave']*usage['wavesPerDay']*usage['days']
    active_seconds=usage['activeSecondsPerRoom']*rounds
    game_gb=usage['serverBytesOutPerRoom']*rounds/1e9
    duration=active_seconds*0.128
    # These are account-wide included allocations. Defaults model an otherwise unused Paid plan.
    taxable_gbs=max(0,duration-usage.get('doIncludedGbS',400000))
    out={'rounds':rounds,'roomHours':active_seconds/3600,'incrementalGameOutGB':game_gb,
         'doDurationGBs':duration,'doDurationUSD':12.5*math.ceil(taxable_gbs/1000000),
         'workersPaidBaseUSD':5,'cafe24IncrementKRW':None,'realtimeUSD':None}
    if 'doHttpRequests' in usage and 'doInboundMessages' in usage:
        metered=usage['doHttpRequests']+usage['doInboundMessages']/20
        out['doRequestUnits']=metered
        out['doRequestUSD']=.15*math.ceil(max(0,metered-usage.get('doIncludedRequests',1e6))/1e6)
    if 'workerRequests' in usage and 'workerCpuMs' in usage:
        out['workerRequestsUSD']=.30*max(0,usage['workerRequests']-usage.get('workerIncludedRequests',10e6))/1e6
        out['workerCpuUSD']=.02*max(0,usage['workerCpuMs']-usage.get('workerIncludedCpuMs',30e6))/1e6
    c=usage.get('cafe24')
    if c:
        # Both series must contain every aligned 5-minute bucket in the complete billing period.
        # Monthly projections may use modeled game buckets; the baseline must use contract billing direction.
        before,extra=c['existingMbps'],c['gameMbps']
        if len(before)!=usage['days']*24*12 or len(extra)!=len(before):
            raise ValueError('Expected a complete aligned billing period')
        def charge(samples):
            billable=min(max(samples),3*sum(samples)/len(samples))
            return max(0,billable-c['includedMbps'])*c['wonPerMbps']*(1+c['vatFraction'])
        out['cafe24IncrementKRW']=charge([a+b for a,b in zip(before,extra)])-charge(before)
    if 'realtimeEgressGB' in usage:
        remaining=usage.get('realtimeRemainingFreeGB',1000)
        out['realtimeUSD']=max(0,usage['realtimeEgressGB']-remaining)*.05
    return out

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('usage',type=Path)
    data=json.loads(parser.parse_args().usage.read_text(encoding='utf-8-sig'))
    for key in ['days','wavesPerDay','roomsPerWave','activeSecondsPerRoom','serverBytesOutPerRoom']:
        if not isinstance(data[key],(int,float)) or not math.isfinite(data[key]) or data[key]<=0:
            parser.error('invalid '+key)
    print(json.dumps(compare(data),indent=2))
