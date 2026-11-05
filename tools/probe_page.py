# -*- coding: utf-8 -*-
"""打开页面、挂错误监听、等一会儿、把想知道的表达式都 eval 出来。"""
import json, subprocess, sys, tempfile, time, urllib.request
import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9334

HOOK = r"""
window.__err = [];
addEventListener('error', e => window.__err.push('ERR ' + (e.message || e.type) + ' @' + (e.filename||'') + ':' + (e.lineno||'')));
addEventListener('unhandledrejection', e => window.__err.push('REJ ' + (e.reason && (e.reason.stack || e.reason.message || e.reason))));
"""


def http(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open(f'http://127.0.0.1:{PORT}{path}', timeout=5) as r:
        return json.loads(r.read().decode('utf-8'))


def main():
    url = sys.argv[1]
    wait = float(sys.argv[2]) if len(sys.argv) > 2 else 12
    exprs = sys.argv[3:] or ['document.title']
    profile = tempfile.mkdtemp(prefix='probe-')
    import os
    gpu = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] if os.environ.get('SW') else []
    proc = subprocess.Popen([EDGE, '--headless=new', *gpu,
                             '--mute-audio', '--no-first-run',
                             '--no-default-browser-check',
                             f'--remote-debugging-port={PORT}', f'--user-data-dir={profile}',
                             'about:blank'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        t0 = time.time()
        while True:
            try:
                http('/json/version'); break
            except Exception:
                if time.time() - t0 > 12: raise
                time.sleep(.25)
        page = [t for t in http('/json') if t['type'] == 'page'][0]
        ws = websocket.create_connection(page['webSocketDebuggerUrl'],
                                        timeout=float(os.environ.get('WS_TIMEOUT', 60)),
                                        suppress_origin=True)
        i = 0

        def send(method, **params):
            nonlocal i
            i += 1
            ws.send(json.dumps({'id': i, 'method': method, 'params': params}))
            while True:
                m = json.loads(ws.recv())
                if m.get('method') == 'Runtime.consoleAPICalled':
                    a = ' '.join(str(x.get('value', x.get('description', ''))) for x in m['params']['args'])
                    print('  [console]', a[:300])
                if m.get('id') == i:
                    return m.get('result', {})

        send('Runtime.enable'); send('Page.enable')
        send('Page.addScriptToEvaluateOnNewDocument', source=HOOK)
        send('Page.navigate', url=url)
        for k in range(int(wait)):
            time.sleep(1)
        for e in exprs:
            # 表达式以 "await " 开头时等 Promise 落地（动作类调用要等走位完成）
            aw = e.startswith('await ')
            src = ('(async()=>{ return await (' + e[6:] + '); })()') if aw else e
            r = send('Runtime.evaluate', expression=src, returnByValue=True, awaitPromise=aw)
            v = r.get('result', {})
            print(f'>> {e}\n   {str(v.get("value", v))[:600]}')
        ws.close()
    finally:
        proc.terminate()


if __name__ == '__main__':
    main()
