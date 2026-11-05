# -*- coding: utf-8 -*-
"""
真页面验"走路被叫停"：让她走起来，半路叫住，看脚是不是真停了。

为什么非得在页面里验：unit test 用的是假屋子，`walking` 是测试自己清的；
真屋子的 `walking` 由动画循环清。这两件事只有浏览器能对上。

两条经验写在参数里：
  · 不走"填输入框"，直接调 window.__SEND —— 表单提交看不见返回值，
    她没回话时你分不清是"没跑到"还是"跑了没成"。
  · 不等 VRM。走路状态是逻辑层的（walkTo 设 walking=true），跟身体渲不渲染无关；
    而 headless 里 VRM 要 100 秒，等它只会等出别的毛病。tick 不跑反而更好：
    walking 不会自己清掉，"走到一半"这个状态稳定地摆在那儿等着被打断。

    python tools/stop-probe.py "走到床边躺下" 700 "等一下"
"""
import json, subprocess, sys, tempfile, time, urllib.request
import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9339

SNAP = """(()=>{const s=window.__state, l=window.__LOOP;
  return {walking:s.walking, pose:s.poseName, pending:!!s.pending,
          pos:[+s.pos.x.toFixed(2),+s.pos.z.toFixed(2)],
          want:[+s.want.x.toFixed(2),+s.want.z.toFixed(2)],
          ui:window.__UI(), stats:{turns:l.stats().turns, actions:l.stats().actions,
            stops:l.stats().stops, interrupts:l.stats().interrupts, fails:l.stats().actionFails},
          dids:window.__MEM.events().filter(e=>e.kind==='did').slice(-3).map(e=>e.text),
          says:window.__MEM.events().filter(e=>e.kind==='said'&&e.who==='fish').slice(-2).map(e=>e.text)}})()"""


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

    def fire(self, expr):
        """发了就不等的 eval：用来启动一轮对话，随后自己去轮询状态。"""
        return self.ev(expr, await_promise=False)

    def snap(self):
        return self.ev(SNAP)


def main():
    first = sys.argv[1] if len(sys.argv) > 1 else '走到床边躺下'
    delay = int(sys.argv[2]) if len(sys.argv) > 2 else 700
    second = sys.argv[3] if len(sys.argv) > 3 else '等一下'
    port = sys.argv[4] if len(sys.argv) > 4 else '8765'
    url = f'http://127.0.0.1:{port}/预览-66.html'

    profile = tempfile.mkdtemp(prefix='cdp-')
    proc = subprocess.Popen([EDGE, '--headless=new',
                             '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
                             '--hide-scrollbars', '--mute-audio', '--no-first-run',
                             '--no-default-browser-check',
                             # 这三条是 headless 的老坑：页面看不见就当后台，定时器和动画循环被降频，
                             # 于是 fetch 的流读不动、requestAnimationFrame 一帧几秒。
                             # 表现出来就是"她一直卡在 thinking"——看着像代码坏了。
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
        ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=150, suppress_origin=True)
        c = CDP(ws)
        c.send('Runtime.enable')
        c.send('Page.enable')
        c.send('Page.navigate', url=url)

        t0 = time.time()
        while time.time() - t0 < 40:
            if c.ev('Boolean(window.__UI && window.__SEND)'):
                break
            time.sleep(.3)
        print(f'就绪 {time.time()-t0:.1f}s，开始：{first}')

        # 先把她挪到屋子另一头：房间只有 3 米宽，从默认位置走一步就到，
        # 根本来不及在"半路"叫住。这和鼠标点家具走的是同一条路（pos 就是那个人在哪）。
        c.ev("""(()=>{const s=window.__state; s.pos.set(-1.9,0,-1.9); s.want.copy(s.pos);
                 s.walking=false; return [s.pos.x,s.pos.z];})()""")
        print('  挪到屋角：', c.ev('JSON.stringify([+window.__state.pos.x.toFixed(2),+window.__state.pos.z.toFixed(2)])'))

        direct = len(sys.argv) > 5 and sys.argv[5] == 'direct'
        if direct:
            # 不经过模型，直接驱动屋子那一层：验的是"真屋子的 tick 会不会把她拽回去"，
            # 这一条假屋子验不了（假屋子没有 tick）。模型给不给 go_to 是她的事，不该卡住验证。
            c.fire("""(()=>{window.__C=new AbortController();
              window.__P=window.__BRAIN.call('go_to',{target:'wardrobe:1'},{signal:window.__C.signal})
                .then(r=>{window.__R=r;}).catch(e=>{window.__R={err:String(e&&e.code||e)};});
              return 'fired';})()""")
        else:
            # 不等返回：她走路时这一轮要挂好几秒，await 就把自己堵死了。
            # 但仍然挂一个 then，把返回值和异常留在页面上——她没动的时候要能立刻看出是哪一种。
            c.fire(f"""window.__LASTERR=null;
              window.__SEND({json.dumps(first)})
                .then(r=>{{window.__R2=r;}}).catch(e=>{{window.__R2={{err:String(e&&e.message||e)}};}});""")

        walking, snap = False, None
        t0 = time.time()
        while time.time() - t0 < 25:
            snap = c.snap()
            if snap and snap.get('walking'):
                walking = True
                print(f'  {time.time()-t0:.1f}s 走起来了：{snap["pos"]} → {snap["want"]}')
                break
            if snap and snap['ui']['phase'] == 'idle' and snap['stats']['turns'] >= 1:
                print('  这一轮跑完了但没动，她说的：', snap['says'], ' 回执：', snap['dids'])
                break
            time.sleep(.05)

        if not walking:
            print('没有进入"走路"，最后的快照：', json.dumps(snap, ensure_ascii=False))
            print('  这一轮返回：', c.ev('JSON.stringify(window.__R2)'))
            print('  页面报的错：', c.ev('window.__LASTERR'))
            return 2

        time.sleep(delay / 1000)
        before = c.snap()
        print(f'叫住之前：walking={before["walking"]} pos={before["pos"]} want={before["want"]}')

        if direct:
            # 在页面里量：abort 那一刻起，到 walking 变 false 用了几帧。
            # 外面轮询测出来的数是"eval 往返"的耗时，不是她停下的耗时——别拿它当指标。
            c.fire("""(()=>{const t0=performance.now();
              window.__C.abort();
              const chk=()=>{ if(!window.__state.walking){ window.__STOPMS=Math.round(performance.now()-t0); }
                              else requestAnimationFrame(chk); };
              requestAnimationFrame(chk); return 1;})()""")
        else:
            c.fire(f"window.__SEND({json.dumps(second)});")
        t_hit = time.time()
        # 停下应该在一帧内发生：连查 10 次，记录第一次 walking=false 的时刻
        stop_ms = None
        while time.time() - t_hit < 3:
            s = c.snap()
            if s and not s.get('walking'):
                stop_ms = round((time.time() - t_hit) * 1000)
                break
            time.sleep(.05)
        after = c.snap()
        print(f'叫住之后 {stop_ms}ms：walking={after["walking"]} pose={after["pose"]} '
              f'pos={after["pos"]} want={after["want"]} pending={after["pending"]}')
        print(f'  停下用了 {stop_ms}ms（目标 <1000ms）')
        if direct:
            print(f'  页面内测的停下耗时：{c.ev("window.__STOPMS")}ms（这才是真数字）')
        print(f'  目标点收回了没有：want==pos ？ {after["want"] == after["pos"]}')
        print(f'  瞬移了没有：{before["pos"]} → {after["pos"]}')
        print(f'  stops={after["stats"]["stops"]} interrupts={after["stats"]["interrupts"]}')
        print(f'  ui={after["ui"]}')

        # 等这一轮收尾（say 落地、phase 回 idle）
        t0 = time.time()
        while time.time() - t0 < 40:
            s = c.snap()
            if s['ui']['phase'] == 'idle' and not s['ui']['up']:
                break
            time.sleep(.4)
        final = c.snap()
        print('收尾：', json.dumps({k: final[k] for k in ('walking', 'pose', 'stats', 'says', 'dids')},
                                   ensure_ascii=False))
        print('  actions 计数：', final['stats']['actions'], '（走路那一步也算进去）')
        print('  失败计数：', final['stats']['fails'], '（停下不该记成失败）')
        if direct:
            print('  屋子回的：', c.ev('JSON.stringify(window.__R)'))

        print('console 最后 5 条：')
        for l in c.logs[-5:]:
            print('  ', l.strip()[:120])
        return 0
    finally:
        try:
            proc.terminate()
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
