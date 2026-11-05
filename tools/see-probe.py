"""看一眼这条路的探针：无头里把整条链跑通（桌面壳用假的）。

真正的 capturePage 在 Electron 里，无头浏览器没有；所以这里只替换**最外面那一层**
（window.desktop.capture 返回一张真 PNG），里面全部是真的：
缩图（canvas）→ POST /api/see → 真 HTTP → vision.mjs → senses.screen → perception → 队列。

为什么要有它：没有多模态 key 的时候，"没配 key"和"配了但坏了"看起来一样。
配上 tools/vision-mock.mjs（假的视觉服务）就能在**零额度**下证明这条链是通的。

用法（两个终端）：
    PORT=8792 node tools/vision-mock.mjs
    PORT=8799 ZHIPU_API_KEY=fake VISION_BASE=http://127.0.0.1:8792/v1 node tools/serve.mjs
    BASE=http://127.0.0.1:8799 python tools/see-probe.py

验五件：
  1 没同意时一次都不截屏
  2 同意后返回一句话，且只截一次
  3 事件真的进了感官层（stats().screen === 1）
  4 立刻再点：too_soon
  5 页面零异常
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

import websocket

EDGE = os.environ.get('EDGE_PATH') or r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9339
BASE = os.environ.get('BASE') or 'http://127.0.0.1:8799'

PNG = ('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
       'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')

INJECT = """
window.__CAP_N = 0;
window.desktop = {
  capture: async () => { window.__CAP_N++; return { ok: true, dataUrl: '%s', name: '屏幕', at: Date.now() }; },
  info: async () => ({ ok: true }),
  clickThrough: async () => ({ ok: true }),
  alwaysOnTop: async () => ({ ok: true }),
};
window.__err = [];
addEventListener('error', e => window.__err.push('ERR ' + (e.message || e.type)));
addEventListener('unhandledrejection', e => window.__err.push('REJ ' + (e.reason && (e.reason.message || e.reason))));
""" % PNG


def http(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open(f'http://127.0.0.1:{PORT}{path}', timeout=5) as r:
        return json.loads(r.read().decode('utf-8'))


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
            if m.get('id') == self.id:
                if 'error' in m:
                    raise RuntimeError(f"{method} 失败: {m['error']}")
                return m.get('result', {})

    def ev(self, expr, timeout=30):
        r = self.send('Runtime.evaluate', expression=expr, awaitPromise=True,
                      returnByValue=True, timeout=timeout * 1000)
        if 'exceptionDetails' in r:
            d = r['exceptionDetails']
            raise RuntimeError(f"eval 异常: {d.get('text')} {d.get('exception', {}).get('description', '')}")
        return r.get('result', {}).get('value')


results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), str(detail)))
    print(('  ✓ ' if cond else '  ✗ ') + name + ('  → ' + str(detail) if detail else ''))


profile = tempfile.mkdtemp(prefix='see-e2e-')
proc = subprocess.Popen([EDGE, '--headless=new', '--hide-scrollbars', '--mute-audio',
                         '--no-first-run', '--no-default-browser-check',
                         f'--remote-debugging-port={PORT}', f'--user-data-dir={profile}',
                         'about:blank'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

try:
    t0 = time.time()
    while True:
        try:
            http('/json/version')
            break
        except Exception:
            if time.time() - t0 > 15:
                print('调试端口没起来')
                sys.exit(2)
            time.sleep(0.25)

    page = [t for t in http('/json') if t['type'] == 'page'][0]
    ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=60, suppress_origin=True)
    c = CDP(ws)
    c.send('Runtime.enable')
    c.send('Page.enable')
    c.send('Page.addScriptToEvaluateOnNewDocument', source=INJECT)
    url = f"{BASE}/" + urllib.parse.quote('预览-66.html')
    c.send('Page.navigate', url=url)

    t0 = time.time()
    while time.time() - t0 < 40:
        try:
            r = c.ev('window.__READY ? __READY.ok : false')
            if r:
                break
        except Exception:
            pass
        time.sleep(0.25)

    print('\nA. 假桌面壳被认到了')
    check('眼睛认为"在壳里"', c.ev('__EYES.available().shell') is True,
          str(c.ev('JSON.stringify(__EYES.available())')))

    print('\nB. 没同意：一次都不截屏')
    r = c.ev("__LOOK('e2e 没同意').then(x => JSON.stringify(x))")
    j = json.loads(r)
    check('no_consent', j.get('reason') == 'no_consent', r)
    check('截屏次数 0', c.ev('window.__CAP_N') == 0, 'CAP_N=' + str(c.ev('window.__CAP_N')))

    print('\nC. 同意后：真走一遍')
    c.ev('__SENSES.consent(true)')
    r = c.ev("__LOOK('e2e').then(x => JSON.stringify(x))")
    j = json.loads(r)
    check('返回 ok', j.get('ok') is True, r[:220])
    check('有一句话', bool(j.get('summary')), str(j.get('summary')))
    check('实体透传', isinstance(j.get('entities'), list) and len(j['entities']) > 0, str(j.get('entities')))
    check('只截一次', c.ev('window.__CAP_N') == 1, 'CAP_N=' + str(c.ev('window.__CAP_N')))

    print('\nD. 事件进了感官层')
    st = json.loads(c.ev('JSON.stringify(__SENSES.stats())'))
    check('screen 记了 1 次', st.get('screen') == 1, json.dumps(st, ensure_ascii=False))
    log = json.loads(c.ev('JSON.stringify(__SENSES.log())'))
    kinds = [x.get('type') for x in log]
    check('日志里有 screen', 'screen' in kinds, str(kinds))
    check('日志里有 consent', 'consent' in kinds, str(kinds))

    print('\nE. 立刻再点')
    r = c.ev("__LOOK('e2e 第二次').then(x => JSON.stringify(x))")
    j2 = json.loads(r)
    check('too_soon', j2.get('reason') == 'too_soon', r)
    check('没有重截', c.ev('window.__CAP_N') == 1, 'CAP_N=' + str(c.ev('window.__CAP_N')))

    print('\nF. 页面零异常')
    err = json.loads(c.ev('JSON.stringify(window.__err || [])'))
    check('没有异常', len(err) == 0, str(err[:3]))

    print('\nG. 视觉这一眼的账')
    try:
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'logs',
                               'see-%s.jsonl' % time.strftime('%Y-%m-%d')), encoding='utf-8') as f:
            lines = [json.loads(x) for x in f if x.strip()]
        last = lines[-1] if lines else {}
        check('服务端记了这次', last.get('ok') is True, json.dumps(last, ensure_ascii=False))
        check('日志里没有图也没有摘要', 'data:image' not in json.dumps(last) and 'summary' not in last,
              '字段=' + ','.join(last.keys()))
    except Exception as e:
        check('服务端记了这次', False, '读不到日志：' + str(e))

finally:
    try:
        proc.terminate()
    except Exception:
        pass

bad = [r for r in results if not r[1]]
print('\n%s 过，%s 不过' % (len(results) - len(bad), len(bad)))
sys.exit(1 if bad else 0)
