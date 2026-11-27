"""Offline coexistence regression fixture. All clients use a newly created loopback port."""
import concurrent.futures
import http.client
import http.server
import json
import math
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

def quantile(rows,q):
    return sorted(rows)[math.ceil(q*len(rows))-1]

def run(profile):
    # Standard-library fixture. No service credentials, real cards, music files, or external fetches.
    import contextlib
    with tempfile.TemporaryDirectory() as scratch:
        dbpath=Path(scratch)/'fixture.sqlite'
        with contextlib.closing(sqlite3.connect(dbpath)) as db:
            db.execute('pragma journal_mode=wal')
            db.execute('create table prices(card integer, tick integer, price integer)')
            db.execute('create index prices_idx on prices(card,tick)')
            db.executemany('insert into prices values (?,?,?)',((i%256,i,i%7919) for i in range(50000)))
            db.commit()
        if not shutil.which('ffmpeg'): raise RuntimeError('ffmpeg is required for the render fixture')
        stopped=threading.Event()
        failures=[]
        renders=[]
        def background():
            count=0
            try:
                with contextlib.closing(sqlite3.connect(dbpath)) as db:
                    while not stopped.is_set():
                        db.executemany('insert into prices values (?,?,?)',((k%256,count+k,k%7919) for k in range(128*profile)))
                        db.commit()
                        start=time.perf_counter()
                        subprocess.run(['ffmpeg','-nostdin','-loglevel','error','-f','lavfi','-i',
                            'sine=frequency=330:sample_rate=48000','-t',str(12*profile),
                            '-threads','1','-c:a','aac','-f','null','-'],check=True,timeout=8,
                            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                        renders.append((time.perf_counter()-start)*1000)
                        count+=128*profile
                        stopped.wait(1)
            except Exception as err: failures.append(type(err).__name__)
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                if self.path=='/prices':
                    with contextlib.closing(sqlite3.connect(dbpath)) as db:
                        result=db.execute('select tick,price from prices where card=? order by tick desc limit 24',(31,)).fetchall()
                elif self.path=='/render-status': result={'completed':len(renders)}
                else: self.send_error(404);return
                body=json.dumps(result).encode()
                self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
        job=threading.Thread(target=background);job.start()
        def window(seconds):
            data={'/prices':[],'/render-status':[]};errors=0;end=time.monotonic()+seconds
            while time.monotonic()<end:
                for route,rows in data.items():
                    c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=2)
                    now=time.perf_counter()
                    try:
                        c.request('GET',route);r=c.getresponse();r.read()
                        if r.status!=200: errors+=1
                        rows.append((time.perf_counter()-now)*1000)
                    except (OSError,http.client.HTTPException): errors+=1
                    finally:c.close()
                time.sleep(.06)
            return {'p95':{k:quantile(v,.95) for k,v in data.items() if v},'samples':{k:len(v) for k,v in data.items()},'errors':errors}
        proc=None
        try:
            time.sleep(1)
            baseline=window(15)
            print(json.dumps({'fixture':profile,'baseline':baseline}),flush=True)
            assert baseline['errors']==0 and renders and not failures
            strikes=0
            with tempfile.TemporaryFile() as log:
                proc=subprocess.Popen(['node',str(Path(__file__).with_name('simulate.js')),'80','fourDates','10','both'],stdout=log,stderr=log)
                while proc.poll() is None:
                    current=window(5)
                    ratios={route:val/baseline['p95'][route] for route,val in current['p95'].items()}
                    strikes=strikes+1 if any(r>=1.1 for r in ratios.values()) else 0
                    print(json.dumps({'window':current,'ratio':ratios,'consecutive':strikes}),flush=True)
                    if strikes>=3 or current['errors'] or failures:
                        proc.terminate();proc.wait()
                        print(json.dumps({'stop':'existing-service fixture threshold','fixture':profile}),flush=True)
                        return False
                print(json.dumps({'gameExit':proc.returncode,'renderJobs':len(renders),'renderP95Ms':quantile(renders,.95)}),flush=True)
                return proc.returncode==0
        finally:
            if proc and proc.poll() is None:proc.terminate();proc.wait()
            stopped.set();job.join(9);server.shutdown();server.server_close();t.join()

if __name__=='__main__':
    setting=int(sys.argv[1]) if len(sys.argv)>1 else 1
    if setting not in [1,2]:raise SystemExit('expected 1 or 2')
    raise SystemExit(0 if run(setting) else 1)
