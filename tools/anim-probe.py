# -*- coding: utf-8 -*-
"""
真页面验动作：走路的时候腿到底动没动。

为什么非得在浏览器里验：node 那侧（anim-test.mjs，31 条）验的是"写进去的角度对不对"，
假骨头当然对。真骨头会问三个问题：名字能不能取到、正负方向对不对、
走完会不会回到原位。这三件只有真 VRM 答得出来。

量三样：
  ① 走的时候大腿角度在**摆**（范围够大，不是一动不动也不是乱抖）
  ② 左右反相（一个在前一个在后）
  ③ 停下来之后回到原位（回不去 = 记账没减干净，越走越歪）

    python tools/anim-probe.py [端口]
"""
import json, math, subprocess, sys, tempfile, time, urllib.request
import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9343
_ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
PAGE_PORT = int(_ARGS[0]) if _ARGS else 8765

SNAP = """(()=>{
  const g = n => window.__vrm?.humanoid?.getNormalizedBoneNode?.(n);
  const b = n => { const x = g(n); return x ? +x.rotation.x.toFixed(4) : null; };
  return {
    vrm: !!window.__vrm,
    anim: window.__ANIM ? window.__ANIM() : null,
    anims: window.__ANIMS ? window.__ANIMS() : null,
    l: b('leftUpperLeg'), r: b('rightUpperLeg'),
    knee: b('leftLowerLeg'),
    arm: b('leftUpperArm'),
    y: +window.__holder?.position.y.toFixed(4),
    pos: window.__state ? [+window.__state.pos.x.toFixed(2), +window.__state.pos.z.toFixed(2)] : null,
    pose: window.__state?.poseName,
    walking: !!window.__state?.walking,
    tt: window.__state ? +window.__state.t.toFixed(2) : null,
    err: (window.__err || []).slice(-3),
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
                continue
            if m.get('method') == 'Runtime.exceptionThrown':
                d = m['params']['exceptionDetails']
                self.logs.append('[throw] ' + (d.get('text') or '') + ' ' + str(d.get('exception', {}).get('description', '')))
                continue
            if m.get('id') == self.id:
                return m

    def js(self, expr):
        r = self.send('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=True)
        if 'error' in r:
            raise RuntimeError(r['error'])
        return r.get('result', {}).get('result', {}).get('value')


def main():
    url = f'http://127.0.0.1:{PAGE_PORT}/预览-66.html'
    prof = tempfile.mkdtemp(prefix='edge-anim-')
    ps = subprocess.Popen([
        EDGE, '--headless=new',
        '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
        '--hide-scrollbars', '--mute-audio', '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        f'--remote-debugging-port={PORT}', f'--user-data-dir={prof}',
        'about:blank',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        # 等浏览器把调试端口开起来（不看返回内容，能连上就算）
        t0 = time.time()
        while time.time() - t0 < 20:
            try:
                http('/json/version')
                break
            except Exception:
                time.sleep(0.25)
        page = [t for t in http('/json') if t['type'] == 'page'][0]
        ws_url = page['webSocketDebuggerUrl']

        ws = websocket.create_connection(ws_url, timeout=200, suppress_origin=True)
        c = CDP(ws)
        c.send('Runtime.enable')
        c.send('Page.enable')
        c.send('Page.navigate', url=url)

        # 等模型：34 MB 的 VRM 在 headless + swiftshader 里要一两分钟
        got = None
        for i in range(600):
            time.sleep(0.5)
            if i % 20 == 0:
                print(f'等模型… {i//2}s', flush=True)
            try:
                s = c.js(SNAP) or {}
            except Exception:
                s = {}          # 导航把执行上下文换掉了，下一轮再说
            if s.get('vrm'):
                got = s
                break
        if not got:
            print('模型没进来'); print('\n'.join(c.logs[-20:])); return 2

        anim = got.get('anim')
        print('动作版本：', anim)
        print('注册了：', got.get('anims'))

        # 走：走到房间另一头，路上采样
        # ⚠ headless + swiftshader 只有 1–3 帧/秒，所以**按模拟时间采样，不按墙钟**：
        #   墙钟走 3 秒可能只推进了 3 帧，看起来像"腿一动不动"，其实是没帧。
        c.js('window.__walk && window.__walk(1.2, -1.4)')

        # 截图用的侧面机位：默认镜头跟在她身后，头发把腿全挡住，只能看见"她在飘"。
        # 锁住镜头，摆到走路方向的侧面，才能看清腿有没有迈。
        SIDE = """(() => {
          const c = window.__camera, s = window.__state;
          if (!c || !s) return 'no cam';
          window.__camLock = true;
          const tx = 1.2, tz = -1.4;
          let dx = tx - s.pos.x, dz = tz - s.pos.z;
          const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
          const px = -dz, pz = dx;      // 走路方向的垂直方向
          c.position.set(s.pos.x + px * 2.0 - dx * 0.4, 0.80, s.pos.z + pz * 2.0 - dz * 0.4);
          c.lookAt(s.pos.x, 0.58, s.pos.z);
          return 'ok';
        })()"""
        if '--shot' in sys.argv:
            print('镜头：', c.js(SIDE), flush=True)
        samples = []
        t_start = c.js('window.__state && window.__state.t') or 0
        deadline = time.time() + 150
        while time.time() < deadline:
            s = c.js(SNAP) or {}
            if s.get('l') is not None:
                samples.append(s)
                # 走路中途截：数字都对但姿势怪（腿反折、穿模）只有图能看出来。
                # 取第 4、9 帧——第 12 帧已经快走到头、腿正在收，看不出迈步。
                if len(samples) in (4, 9) and '--shot' in sys.argv:
                    try:
                        c.js(SIDE)          # 她往前走了，机位要跟着挪，不然会拍空
                        shot = c.send('Page.captureScreenshot', format='png')
                        import base64, os
                        d = shot.get('result', {}).get('data')
                        if d:
                            p = os.path.join('_tmp', f'anim-walk-{len(samples)}.png')
                            os.makedirs('_tmp', exist_ok=True)
                            with open(p, 'wb') as f:
                                f.write(base64.b64decode(d))
                            print(f'第 {len(samples)} 帧截图：{p}'
                                  f'（左腿 {s.get("l")} 右腿 {s.get("r")} 膝 {s.get("knee")}）', flush=True)
                    except Exception as e:
                        print('截图失败：' + str(e), flush=True)
            if s.get('tt') is not None and s['tt'] - t_start > 3.0:
                break
            time.sleep(0.15)
        span_t = (samples[-1]['tt'] - t_start) if samples and samples[-1].get('tt') else 0
        print(f'走路采样 {len(samples)} 帧（模拟时间 {span_t:.1f}s）', flush=True)

        legs = [x['l'] for x in samples if x.get('l') is not None]
        legs_r = [x['r'] for x in samples if x.get('r') is not None]
        span = (max(legs) - min(legs)) if legs else 0
        anti = sum(1 for x in samples if x.get('l') is not None and x.get('r') is not None and x['l'] * x['r'] < -1e-6)
        ys = [x['y'] for x in samples if x.get('y') is not None]
        yspan = (max(ys) - min(ys)) if ys else 0
        moved = 0.0
        if samples and samples[0].get('pos') and samples[-1].get('pos'):
            p0, p1 = samples[0]['pos'], samples[-1]['pos']
            moved = ((p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2) ** 0.5

        # 站着不动，等模拟时间过 1.6 秒，看回不回原位
        c.js('window.__apply && window.__apply("stand")')
        t_rest = c.js('window.__state && window.__state.t') or 0
        phase_at_rest = c.js('(window.__ANIM && window.__ANIM().phase) || 0') or 0
        rest = {}
        deadline2 = time.time() + 120
        while time.time() < deadline2:
            rest = c.js(SNAP) or {}
            if rest.get('tt', 0) - t_rest > 1.6:
                break
            time.sleep(0.2)

        lines = []
        def chk(cond, name, extra=''):
            lines.append(('  ✓ ' if cond else '  ✗ ') + name + (('  → ' + str(extra)) if extra and not cond else ''))

        chk(bool(anim), 'A1 动作层起来了（window.__ANIM 有值）', anim)
        chk(span > 0.15, 'A2 走路时大腿在摆（范围够大，不是平移）', f'span={span:.3f}')
        chk(span < 1.6, 'A3 但没甩飞（幅度在人的范围里）', f'span={span:.3f}')
        chk(anti > len(samples) * 0.5, 'A4 左右反相', f'{anti}/{len(samples)} 帧反号')
        chk(moved > 0.5, 'A5 人是真走过去的（位置变了）', f'{moved:.2f} m')
        chk(yspan > 0.003, 'A6 落脚时整个人有下沉', f'y 幅度={yspan:.4f}')
        chk(abs(rest.get('l') or 0) < 0.06, 'A7 停下两秒后大腿回正', rest.get('l'))
        chk(abs(rest.get('knee') or 0) < 0.06, 'A8 膝盖也回正', rest.get('knee'))
        chk(not rest.get('err'), 'A9 页面没有报错', rest.get('err'))
        # A10 别数帧数：headless + swiftshader 一秒只出一两帧，帧数是机器快慢，不是代码对错。
        # 要看的是**相位在往前走**（跟距离挂钩），以及停下之后相位**不再走**。
        phases = [x.get('anim', {}).get('phase') for x in samples if x.get('anim')]
        tot = 0.0
        for a, b in zip(phases, phases[1:]):
            tot += (b - a) % (2 * math.pi)
        chk(tot > 1.5, 'A10 步态相位跟着距离往前走', f'{tot:.2f} rad / {len(samples)} 帧')
        chk(abs((rest.get('anim') or {}).get('phase', 0) - phase_at_rest) < 0.4,
            'A11 站住之后相位不再前进（不是按时间空转）',
            f'{(rest.get("anim") or {}).get("phase")} vs {phase_at_rest}')

        print()
        print('\n'.join(lines))
        bad = sum(1 for x in lines if x.startswith('  ✗'))
        print(f'\n全过：{len(lines)-bad} 过，{bad} 不过')
        if bad:
            print('\n--- 相关日志 ---')
            for l in c.logs:
                if 'anim' in l.lower() or 'error' in l.lower():
                    print(l)
        return 0 if bad == 0 else 1
    finally:
        ps.terminate()


if __name__ == '__main__':
    sys.exit(main())
