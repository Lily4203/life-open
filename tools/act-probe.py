# -*- coding: utf-8 -*-
"""
真页面验「行动端口」：外面能不能请她动手。

为什么必须真页面：/api/act 本身只是一根管子，管子的另一头是页面里的注册表。
node 那侧测得了"管子通不通"，测不了"另一端有没有人接、接的人肯不肯动"。

量五样：
  ① 服务端自报：没有页面时直接拒（no_page），不排队
  ② 页面连上之后，读状态能读到（pose / near / lights）
  ③ 动作表拿得到，而且不是空的
  ④ 派一个真动作（go_to 床边），她的位置真的变了
  ⑤ 派一个不存在的动作，如实回失败——不许说成功
  ⑥ 页面关掉之后再派，回到 no_page

    python tools/act-probe.py [端口]
"""
import json, subprocess, sys, tempfile, time, urllib.parse, urllib.request, urllib.error
import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9344
_ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
PAGE_PORT = int(_ARGS[0]) if _ARGS else 8765
BASE = f'http://127.0.0.1:{PAGE_PORT}'

PASS, FAIL = [], []


def chk(cond, name, extra=''):
    if cond:
        PASS.append(name)
        print(f'  ✓ {name}', flush=True)
    else:
        FAIL.append(name)
        print(f'  ✗ {name}　{extra}', flush=True)


def post(path, body, timeout=40):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8'))
        except Exception:
            return e.code, {}


def get(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open(BASE + path, timeout=5) as r:
        return json.loads(r.read().decode('utf-8'))


def http_json(port, path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open(f'http://127.0.0.1:{port}{path}', timeout=5) as r:
        return json.loads(r.read().decode('utf-8'))


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.id = 0

    def send(self, method, **params):
        self.id += 1
        self.ws.send(json.dumps({'id': self.id, 'method': method, 'params': params or {}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('id') == self.id:
                return m.get('result', {})

    def js(self, expr):
        r = self.send('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=True)
        return r.get('result', {}).get('value')


READY = "!!(window.__ACT_ES && window.__ACT)"


def main():
    prof = tempfile.mkdtemp(prefix='act-probe-')
    ps = subprocess.Popen([
        EDGE, '--headless=new', f'--remote-debugging-port={PORT}',
        f'--user-data-dir={prof}', '--no-first-run', '--no-default-browser-check',
        '--disable-gpu', '--use-gl=swiftshader', '--window-size=1280,800',
        # URL 里的中文要编码：不编码 Edge 也能开，但 /json 里回的是 %E9…，
        # 后面按 '预览' 去匹配 tab 就永远匹配不上——看起来像"页面打不开"。
        f'{BASE}/' + urllib.parse.quote('预览-66.html'),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        ws_url = None
        for _ in range(80):
            time.sleep(0.5)
            try:
                tabs = http_json(PORT, '/json')
                t = next((x for x in tabs if x.get('type') == 'page' and '66.html' in x.get('url', '')), None)
                if t:
                    ws_url = t['webSocketDebuggerUrl']
                    break
            except Exception:
                pass
        if not ws_url:
            print('打不开页面', flush=True)
            return 2

        ws = websocket.create_connection(ws_url, timeout=60)
        c = CDP(ws)
        c.send('Runtime.enable')
        c.send('Page.enable')

        print('\nA. 等页面把行动端口接上', flush=True)
        # headless + swiftshader 加载 VRM 会把主线程占满几十秒，
        # 端口要比模型先就绪——等它，别拿"还没跑完"当"坏了"。
        deadline = time.time() + 150
        while time.time() < deadline:
            if c.js(READY):
                break
            time.sleep(1)
        chk(bool(c.js(READY)), 'A1 页面连上了行动端口')

        print('\nB. 读状态', flush=True)
        st, r = post('/api/act', {'name': '__state'})
        chk(st == 200 and r.get('ok'), 'B1 读得到状态', f'HTTP {st} {r}')
        chk(isinstance(r.get('lights'), dict) and r.get('lights'), 'B2 灯的状态带出来了', r.get('lights'))
        chk(r.get('pose'), 'B3 姿势带出来了', r.get('pose'))
        pos0 = (r.get('x'), r.get('z')) if r.get('ok') else None

        print('\nC. 动作表', flush=True)
        st, a = post('/api/act', {'name': '__actions'})
        acts = a.get('actions') or []
        names = [x.get('name') for x in acts]
        chk(st == 200 and len(acts) >= 3, 'C1 动作表不是空的', names)
        chk('go_to' in names, 'C2 走路这个动作在', names)

        print('\nD. 真派一个动作（等她加载完 VRM）', flush=True)
        got_vrm = False
        for i in range(120):
            if c.js('!!window.__vrm'):
                got_vrm = True
                break
            if i % 20 == 0:
                print(f'  等模型… {i//2}s', flush=True)
            time.sleep(0.5)
        chk(got_vrm, 'D1 模型加载完了（没有模型就没有身体，派不动）')

        if got_vrm:
            # 参数是 target（实体 id 或种类名），不是 where。种类只有一件时可以只写种类。
            st, r = post('/api/act', {'name': 'go_to', 'args': {'target': 'bed'}}, timeout=60)
            chk(st == 200, 'D2 go_to 有回话', f'HTTP {st} {r}')
            chk(r.get('ok') or r.get('reason') in ('partial',), 'D3 go_to 成功或半路停下（不是 failed）', r)
            moved = False
            for _ in range(40):
                time.sleep(0.25)
                _, s2 = post('/api/act', {'name': '__state'}, timeout=10)
                p2 = (s2.get('x'), s2.get('z'))
                if p2 != pos0 and p2[0] is not None:
                    moved = True
                    break
            _, s3 = post('/api/act', {'name': '__state'}, timeout=10)
            chk(moved and pos0 is not None, 'D4 她真的挪了位置', f'{pos0} -> {(s3.get("x"), s3.get("z"))}')

        print('\nE. 不存在的动作，不许说成功', flush=True)
        st, r = post('/api/act', {'name': 'fly_to_moon', 'args': {}})
        chk(st == 200 and not r.get('ok'), 'E1 如实回失败', r)
        chk(r.get('reason') in ('no_such_action', 'unknown', 'no_action', 'not_in_window', 'no_window'),
            'E2 说了为什么', r.get('reason'))

        print('\nF. 页面关掉之后', flush=True)
        try:
            ps.terminate()
            ps.wait(timeout=10)
        except Exception:
            pass
        # 等连接真断：进程退了不等于 TCP 立刻关，服务端还要收到 close 才把 client 摘掉。
        # 不等就断言，测的是"进程退出的速度"，不是"端口的行为"。
        for _ in range(40):
            time.sleep(0.5)
            if get('/api/health').get('act', {}).get('clients', 0) == 0:
                break
        st, r = post('/api/act', {'name': '__state'})
        chk(st == 503 and r.get('reason') == 'no_page', 'F1 回到 no_page（不排队、不假装）', f'HTTP {st} {r}')

        h = get('/api/health')
        chk(h.get('act', {}).get('noPage', 0) >= 1, 'F2 health 里数得到"没人能动手"', h.get('act'))

    finally:
        try:
            ps.kill()
        except Exception:
            pass

    print(f'\n{len(PASS)} 通过，{len(FAIL)} 失败', flush=True)
    if FAIL:
        print('失败：' + '，'.join(FAIL), flush=True)
    return 0 if not FAIL else 1


if __name__ == '__main__':
    sys.exit(main())
