# -*- coding: utf-8 -*-
"""
打开真页面、跑一轮对话、读动作计数。用来验证"改完的东西浏览器里到底吃到没有"。

为什么必须走真页面：loop.mjs 是静态文件，serve 每次从磁盘读；但页面一旦打开，
模块就进了内存。改完不刷新，跑的还是旧那份——P9 那种"合成全过、真页面全 0"的坑就出在这。

    python tools/refresh-and-check.py "把顶灯关掉" [端口]
"""
import json, os, socket, subprocess, sys, tempfile, time, urllib.request
import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9335


def http(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open(f'http://127.0.0.1:{PORT}{path}', timeout=5) as r:
        return json.loads(r.read().decode('utf-8'))


def wait_port(deadline=15):
    t0 = time.time()
    while time.time() - t0 < deadline:
        try:
            return http('/json/version')
        except Exception:
            time.sleep(.25)
    raise RuntimeError('调试端口没起来')


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

    def ev(self, expr, timeout=20):
        r = self.send('Runtime.evaluate', expression=expr, awaitPromise=True,
                      returnByValue=True, timeout=timeout * 1000)
        if 'exceptionDetails' in r:
            d = r['exceptionDetails']
            raise RuntimeError(f"eval 异常: {d.get('text')} {d.get('exception', {}).get('description', '')}")
        return r.get('result', {}).get('value')


def main():
    text = sys.argv[1] if len(sys.argv) > 1 else '把顶灯关掉'
    port = sys.argv[2] if len(sys.argv) > 2 else '8765'
    url = f'http://127.0.0.1:{port}/预览-66.html'

    profile = tempfile.mkdtemp(prefix='cdp-')
    # 不开 swiftshader：软件光栅下 VRM 的贴图上传慢到一分钟都出不来人，
    # 于是她的动作全 fallback 成"屋子不会这个"，看起来像"发了没反应"。
    # 那个"偶发不触发"有一半是这么来的（另一半是等错了就绪信号，见下）。
    gpu = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] if os.environ.get('SW') else []
    proc = subprocess.Popen([EDGE, '--headless=new', *gpu,
                             '--hide-scrollbars', '--mute-audio', '--no-first-run',
                             '--no-default-browser-check',
                             f'--remote-debugging-port={PORT}', f'--user-data-dir={profile}',
                             'about:blank'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_port()
        page = [t for t in http('/json') if t['type'] == 'page'][0]
        ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=90,
                                        suppress_origin=True)
        c = CDP(ws)
        c.send('Runtime.enable')
        c.send('Page.enable')

        print(f'打开 {url}')
        c.send('Page.navigate', url=url)

        # 等页面自己说装完了。
        # 上一版等的是 __LOOP——它在 2787 行就有值，而表单监听在 3020 之后，
        # 中间那段时间提交表单会真的把页面导航掉。这就是"偶发不触发"的另一半。
        t0 = time.time()
        ready = False
        while time.time() - t0 < 60:
            try:
                r = c.ev('window.__READY ? JSON.stringify({ok:__READY.ok,m:__READY.missing,n:__READY.note}) : null')
                if r and json.loads(r).get('ok'):
                    ready = True
                    break
                if r:
                    bad = json.loads(r)
                    # 缺块不一定是坏事（VRM 还没到就等），但每 10 秒说一句
                    if int(time.time() - t0) % 10 == 0:
                        print(f'  等：缺 {bad.get("m")} {bad.get("n") or ""}')
            except Exception:
                pass
            time.sleep(.5)
        if not ready:
            print('页面没就绪，console（最后 20 条）：')
            for l in c.logs[-20:]:
                print(' ', l)
            return 2
        print(f'页面就绪（{time.time() - t0:.1f}s）')

        # ① 浏览器里跑的 loop.mjs 是不是改过的那一份
        fresh = c.ev("""fetch('/js/brain/loop.mjs',{cache:'no-store'}).then(r=>r.text())
            .then(t=>({replayOf:t.includes('replayOf'), partial:t.includes('partial'),
                       bytes:t.length, reason:t.includes('replayOf')?'含 replayOf':'不含 replayOf'}))""")
        print('模块版本：', fresh)

        print('初始 stats：', c.ev('JSON.stringify(window.__LOOP.stats())'))

        # ② 走真实入口：填输入框 → 提交表单（和按回车同一条路）
        c.ev(f"document.getElementById('saybox').value = {json.dumps(text)}; "
             f"document.getElementById('sayform').requestSubmit(); 'sent'")
        print(f'已发送：{text}')

        # ②.5 三秒内必须进入一轮。进不去就当场说清楚，不要后面等 90 秒再猜。
        t0 = time.time()
        while time.time() - t0 < 3:
            u = json.loads(c.ev('JSON.stringify(window.__UI())') or 'null') or {}
            if u.get('up'):
                break
            time.sleep(.2)
        else:
            print('发出去 3 秒没进入一轮：表单这条路没接上。console：')
            for l in c.logs[-10:]:
                print(' ', l)
            return 3

        # ③ 等这一轮跑完
        t0 = time.time()
        while time.time() - t0 < 90:
            st = c.ev("""(()=>{const s=window.__LOOP.stats();
                return {turns:s.turns, actions:s.actions, ok:s.ok, failed:s.failed,
                        jsonRetries:s.jsonRetries, blanks:s.blanks,
                        lastText:window.__MEM?.events?.().filter(e=>e.kind==='did').slice(-1)[0]?.text||null,
                        lastSay:(window.__MEM?.events?.().filter(e=>e.kind==='said'&&e.who==='fish').slice(-1)[0]?.text)||null}})()""")
            if st and st.get('turns', 0) >= 1:
                break
            time.sleep(1)
        print('跑完：', json.dumps(st, ensure_ascii=False))

        print('动作回执：', c.ev("""JSON.stringify(window.__MEM.events()
            .filter(e=>e.kind==='did').slice(-4).map(e=>e.text))"""))

        print('console（最后 12 条）：')
        for l in c.logs[-12:]:
            print('  ', l)
        return 0
    finally:
        try:
            proc.terminate()
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
