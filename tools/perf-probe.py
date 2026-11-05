# -*- coding: utf-8 -*-
"""
真页面验表现层：手势到底有没有让骨头动，动完有没有回来。

为什么非得在浏览器里验：手势走的是骨骼旋转，node 那侧只能验"词表对不对"
（幅度、归零、白名单）。真正会不会动、会不会越演越歪、镜头有没有推近，
只有真骨架知道。

三条经验写在参数里：
  · 等 __vrm，不等"画面好看"。headless 里模型要几十秒，但只要 humanoid 在了，
    骨头就能读；预览缩略图是不是黑的无所谓。
  · 量的是**骨骼旋转**，不是"我调用了"。调用成功但骨头没动，
    正是这套东西最容易出的错（名字对、路径错）。
  · 演完要回到原值。回不去就说明偏移没有减干净——那会越演越歪，
    第五次挥手时手臂已经在背后了。

    python tools/perf-probe.py [端口]
"""
import json, subprocess, sys, tempfile, time, urllib.request
import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9341

SNAP = """(()=>{
  const P = window.__PERF, A = window.__AVATAR;
  const n = window.__vrm?.humanoid?.getNormalizedBoneNode?.('rightUpperArm');
  const h = window.__vrm?.humanoid?.getNormalizedBoneNode?.('head');
  return {
    vrm: !!window.__vrm, perf: !!P,
    rot: n ? [+n.rotation.x.toFixed(4), +n.rotation.y.toFixed(4), +n.rotation.z.toFixed(4)] : null,
    headRot: h ? [+h.rotation.x.toFixed(4), +h.rotation.z.toFixed(4)] : null,
    now: P ? P.now() : null, last: P ? P.last() : null,
    stats: P ? P.stats() : null,
    caps: A ? [...A.caps()] : null,
    done: P ? P.done() : null,
  };
})()"""


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
            elif m.get('method') == 'Runtime.exceptionThrown':
                d = m['params']['exceptionDetails']
                self.logs.append(f"[异常] {d.get('text')} {d.get('exception', {}).get('description', '')}")
            if m.get('id') == self.id:
                if 'error' in m:
                    raise RuntimeError(f"{method} 失败: {m['error']}")
                return m.get('result', {})

    def ev(self, expr, timeout=30, await_promise=True):
        r = self.send('Runtime.evaluate', expression=expr, awaitPromise=await_promise,
                      returnByValue=True, timeout=timeout * 1000)
        if 'exceptionDetails' in r:
            d = r['exceptionDetails']
            return {'ERR': d.get('text'), 'detail': d.get('exception', {}).get('description', '')}
        return r.get('result', {}).get('value')

    def snap(self):
        return self.ev(SNAP)


def main():
    port = sys.argv[1] if len(sys.argv) > 1 else '8765'
    url = f'http://127.0.0.1:{port}/预览-66.html'

    profile = tempfile.mkdtemp(prefix='cdp-')
    proc = subprocess.Popen([EDGE, '--headless=new',
                             '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
                             '--hide-scrollbars', '--mute-audio', '--no-first-run',
                             '--no-default-browser-check',
                             '--disable-background-timer-throttling',
                             '--disable-renderer-backgrounding',
                             '--disable-backgrounding-occluded-windows',
                             f'--remote-debugging-port={PORT}', f'--user-data-dir={profile}',
                             'about:blank'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        t0 = time.time()
        while time.time() - t0 < 15:
            try:
                http('/json/version')
                break
            except Exception:
                time.sleep(.25)
        page = [t for t in http('/json') if t['type'] == 'page'][0]
        ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=200, suppress_origin=True)
        c = CDP(ws)
        c.send('Runtime.enable')
        c.send('Page.enable')
        c.send('Page.navigate', url=url)

        # 等骨架：humanoid 在就能读骨头，跟画面有没有渲完无关
        t0 = time.time()
        while time.time() - t0 < 300:
            s = c.ev('Boolean(window.__vrm?.humanoid) && Boolean(window.__PERF)')
            if s is True:
                break
            time.sleep(.4)
        print(f'骨架就绪 {time.time()-t0:.1f}s')
        if c.ev('Boolean(window.__vrm?.humanoid)') is not True:
            print('  没等到骨架，页面状态：', c.ev('JSON.stringify({vrm:!!window.__vrm, state:!!window.__STATE, loop:!!window.__LOOP})'))
            print('  最后几条日志：', c.logs[-5:])

        base = c.snap()
        print('能力表：', base['caps'])
        print('基线右臂：', base['rot'])

        # ① 演一个，看骨头有没有真动
        print('\n① 挥手')
        print('  force(wave) →', c.ev("JSON.stringify(window.__PERF.force('wave'))"))
        peak, moved = None, []
        for i in range(10):
            time.sleep(.12)
            s = c.snap()
            if s['rot'] and base['rot']:
                d = max(abs(s['rot'][j] - base['rot'][j]) for j in range(3))
                moved.append(round(d, 4))
                if peak is None or d > peak[0]:
                    peak = (d, s['rot'], i)
        print('  右臂偏离基线：', moved)
        print('  峰值 ', peak[0] if peak else None, 'ms 内到峰值约', (peak[2] * 120 + 60) if peak else None)

        # ② 演完要回来（wave 1.5 秒，多给半秒）
        time.sleep(1.9)
        after = c.snap()
        print('\n② 演完之后')
        print('  右臂：', after['rot'], ' 当前手势：', after['now'])
        back = 0 if not (after['rot'] and base['rot']) else max(abs(after['rot'][j] - base['rot'][j]) for j in range(3))
        print('  离基线还剩：', round(back, 4))

        # ③ 不许连着两次同一个
        print('\n③ 连着叫两次同一个')
        a = c.ev("JSON.stringify(window.__PERF.force('nod'))")
        time.sleep(1.2)
        b = c.ev("JSON.stringify(window.__PERF.force('nod'))")
        print('  第一次 ', a)
        print('  第二次 ', b)

        # ④ 说话要推镜（只上字幕不出声，避免 headless 没有音频设备）
        print('\n④ 说话时推镜')
        c.ev("window.__AVATAR.say('测试一下镜头。', {silent:true}); 'ok'")
        time.sleep(1.2)
        s1 = c.snap()
        print('  说话中 camK =', s1['stats']['camK'], ' speaking =', s1['stats']['speaking'])
        time.sleep(5)
        s2 = c.snap()
        print('  五秒后 camK =', s2['stats']['camK'], ' speaking =', s2['stats']['speaking'])

        # ⑤ 待机：安静一会儿，看它自己找事做
        print('\n⑤ 待机 16 秒')
        before = len(s2['done'] or [])
        time.sleep(16)
        s3 = c.snap()
        print('  演过：', (s3['done'] or [])[-6:], ' 次数', before, '→', len(s3['done'] or []))
        print('  head 有没有被手势带偏（应该只受视线影响）：', s3['headRot'])

        errs = [l for l in c.logs if l.startswith('[异常]') or l.startswith('[error]')]
        print('\n页面异常：', errs[-4:] if errs else '无')
    finally:
        proc.terminate()


if __name__ == '__main__':
    main()
