# -*- coding: utf-8 -*-
"""
用 Edge 的无头模式截任意本地页面（走 CDP，能等真实时间）。

为什么不用 Electron：本机 `electron shot.js` 起不来（ELECTRON_RUN_AS_NODE 被外部设了，
真绕开之后离屏捕获又不出图）。Edge 的 `--screenshot` 只等 load 事件，
它等不到 VRM 贴图解码这种真实异步——所以这里用 CDP，自己控制等待。

    python tools/shot_cdp.py <url> <out.png> [等待秒数] [宽] [高]

例：python tools/shot_cdp.py "http://127.0.0.1:8099/life/预览-61.html" life/v61.png 14
"""
import base64, json, os, socket, subprocess, sys, tempfile, time, urllib.request
import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9333


def http(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open(f'http://127.0.0.1:{PORT}{path}', timeout=5) as r:
        return json.loads(r.read().decode('utf-8'))


def wait_port(deadline=12):
    t0 = time.time()
    while time.time() - t0 < deadline:
        try:
            return http('/json/version')
        except Exception:
            time.sleep(.25)
    raise RuntimeError('Edge 调试端口没起来')


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.id = 0
        self.logs = []

    def send(self, method, **params):
        self.id += 1
        self.ws.send(json.dumps({'id': self.id, 'method': method, 'params': params or {}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('method') == 'Runtime.consoleAPICalled':
                args = ' '.join(str(a.get('value', a.get('description', ''))) for a in m['params']['args'])
                self.logs.append(f"[{m['params']['type']}] {args}")
            elif m.get('method') == 'Runtime.exceptionThrown':
                d = m['params']['exceptionDetails']
                self.logs.append(f"[异常] {d.get('text')} {d.get('exception', {}).get('description', '')}")
            if m.get('id') == self.id:
                if 'error' in m:
                    raise RuntimeError(f"{method} 失败: {m['error']}")
                return m.get('result', {})


def main():
    url = sys.argv[1]
    out = sys.argv[2]
    wait = float(sys.argv[3]) if len(sys.argv) > 3 else 10
    w = int(sys.argv[4]) if len(sys.argv) > 4 else 1280
    h = int(sys.argv[5]) if len(sys.argv) > 5 else 800

    profile = tempfile.mkdtemp(prefix='cdp-')
    gpu = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] if os.environ.get('SW') else []
    proc = subprocess.Popen([EDGE, '--headless=new', *gpu, '--hide-scrollbars',
                             '--mute-audio', '--no-first-run', '--no-default-browser-check',
                             f'--remote-debugging-port={PORT}', f'--user-data-dir={profile}',
                             'about:blank'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_port()
        page = [t for t in http('/json') if t['type'] == 'page'][0]
        ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=60,
                                        suppress_origin=True)
        c = CDP(ws)
        c.send('Runtime.enable')
        c.send('Page.enable')
        c.send('Emulation.setDeviceMetricsOverride', width=w, height=h,
               deviceScaleFactor=1, mobile=False)
        c.send('Page.navigate', url=url)
        time.sleep(wait)                       # 真实等待：贴图解码/编译着色器都在这段时间里
        ev = os.environ.get('EVAL')
        if ev:                                 # 截图前先在页面里执行一段（用来摆姿势）
            r0 = c.send('Runtime.evaluate', expression=ev, returnByValue=True)
            print('EVAL →', str(r0.get('result', {}).get('value'))[:200])
            time.sleep(float(os.environ.get('EVAL_WAIT', '1.6')))
        r = c.send('Runtime.evaluate', expression='document.title', returnByValue=True)
        print('页面标题：', r.get('result', {}).get('value'))
        png = c.send('Page.captureScreenshot', format='png')['data']
        with open(out, 'wb') as f:
            f.write(base64.b64decode(png))
        print('已存', out, os.path.getsize(out) // 1024, 'KB')
        if c.logs:
            print('--- 控制台 ---')
            for l in c.logs[-25:]:
                print('  ', l)
        ws.close()
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except Exception:
            proc.kill()


if __name__ == '__main__':
    main()
