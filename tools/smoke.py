# -*- coding: utf-8 -*-
"""页面冒烟测试：66 到底还是不是那个能用的页面。

为什么要有这个文件
------------------
3100 行的单文件，改一行 3D、改一行大脑接线都可能白屏，而 1039 条 node 断言
一条都不碰页面骨架：它们跑的是 loop.mjs / executor.mjs 这些"被页面 import 的东西"，
页面自己（顺序、作用域、DOM id、绑定时机）从来没被验过。
上一版的症状就是这里来的——"填了表单没反应"，而且偶发。

它验什么（分四层，不是"打开看看"）
----------------------------------
  A 骨架：页面能开、无异常、页面自己说十块都装好了、场景里真有东西
  B 契约：动作空间 13 个且名单没变、身体能力 8 种、内容三份（规则/衣柜/活动）
  C 界面：输入四件齐、HUD 有字、canvas 有尺寸
  D 活着：帧在推进、发一句话真的跑完一轮、跑完不留错误

D 里那条"发一句话"是这个文件存在的主要理由。
跳它（--no-turn）就只剩"页面能开"，那种测试绿着也可以什么都没接上。

用法
----
    python tools/smoke.py                 全跑（含真发一句，会花一次模型钱）
    python tools/smoke.py --no-turn       只验骨架（run-all 用这个，快、不花钱）
    python tools/smoke.py --port 8765 --keep-log   失败时把 console 全打出来

输出两种收尾都能被 run-all 认：`全过：N 过，M 不过`。
退出码：全过 0，有不过 1，起不来 2。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket

EDGE = os.environ.get('EDGE_PATH') or r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9337

HOOK = r"""
window.__err = [];
addEventListener('error', e => window.__err.push('ERR ' + (e.message || e.type) + ' @' + (e.filename || '') + ':' + (e.lineno || '')));
addEventListener('unhandledrejection', e => window.__err.push('REJ ' + (e.reason && (e.reason.stack || e.reason.message || e.reason))));
"""


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

    def ev(self, expr, timeout=30):
        r = self.send('Runtime.evaluate', expression=expr, awaitPromise=True,
                      returnByValue=True, timeout=timeout * 1000)
        if 'exceptionDetails' in r:
            d = r['exceptionDetails']
            raise RuntimeError(f"eval 异常: {d.get('text')} {d.get('exception', {}).get('description', '')}")
        return r.get('result', {}).get('value')


# ---------------------------------------------------------------- 断言表
# 每条是 (名字, 页面表达式)；表达式返回 {ok, detail}——判断写在 JS 里，
# 因为它能同时看到好几个全局，比在 python 里拼字符串可靠。
JS_CHECKS = [
    ('页面没有异常', """({
        ok: (window.__err || []).length === 0 && document.readyState === 'complete',
        detail: document.readyState + (window.__err && window.__err.length ? ' | ' + window.__err.join(' ; ') : '')
    })"""),

    ('十块都装好了', """(() => {
        const r = window.__READY || {};
        return { ok: !!r.ok && (r.missing || []).length === 0,
                 detail: r.summary ? r.summary() : '没有 __READY（页面连就绪信号都没报）' };
    })()"""),

    ('场景里有东西', """(() => {
        const b = (window.__READY || {}).blocks || {};
        const s = b.scene;
        return { ok: !!s && s.objects > 50 && (window.__state ? true : false),
                 detail: s ? ('scene.children=' + s.objects + ' fov=' + s.fov) : '没打勾' };
    })()"""),

    ('房间四件家具', """(() => {
        const b = (window.__READY || {}).blocks || {};
        const n = Array.isArray(window.__FURN) ? window.__FURN.length : -1;
        const items = Array.isArray(window.__INTS) ? window.__INTS.length : -1;
        return { ok: b.room && b.room.furn === 4 && n === 4 && items === 4,
                 detail: `furn=${n} interactables=${items} ref=${b.room ? b.room.ref : '?'}` };
    })()"""),

    ('动作空间 13 个', """(() => {
        const n = window.__REGISTRY && window.__REGISTRY.names();
        return { ok: !!n && n.length === 13, detail: n ? n.join(',') : '没有注册表' };
    })()"""),

    ('动作名单没变', """(() => {
        const want = ['go_to','use_furniture','toggle','stand_up','look_at','idle_pose',
                      'set_emotion','change_clothes','take_off','drink_tea','look_outside','stretch',
                      'look_screen'];
        const got = (window.__REGISTRY && window.__REGISTRY.names()) || [];
        const missing = want.filter(x => !got.includes(x));
        const extra = got.filter(x => !want.includes(x));
        return { ok: !missing.length && !extra.length,
                 detail: missing.length || extra.length ? ('缺 ' + missing + ' 多 ' + extra) : '十三个一字不差' };
    })()"""),

    ('身体八种能力', """(() => {
        const b = (window.__READY || {}).blocks || {};
        const caps = b.brain && b.brain.caps;
        return { ok: caps === 8, detail: 'caps=' + caps + ' actions=' + (b.brain && b.brain.actions) };
    })()"""),

    ('内容三份都在', """(() => {
        const b = (window.__READY || {}).blocks || {};
        const c = b.content || {};
        return { ok: c.rules > 0 && c.activities >= 3,
                 detail: `规则 ${c.rules} 活动 ${c.activities} 衣柜 ${c.wardrobe}` };
    })()"""),

    ('输入四件齐', """(() => {
        const f = document.getElementById('sayform'), b = document.getElementById('saybox');
        const s = document.getElementById('saybtn'), p = document.getElementById('playbtn');
        const ui = (window.__READY || {}).blocks || {};
        return { ok: !!(f && b && s && p) && !b.disabled && !!ui.ui,
                 detail: `form=${!!f} box=${!!b}${b && b.disabled ? '(禁用)' : ''} btn=${!!s} play=${!!p}` };
    })()"""),

    ('HUD 有字', """(() => {
        const t = (document.getElementById('bstat') || {}).textContent || '';
        return { ok: t.length > 0 && !t.includes('正在装记忆'),
                 detail: t.slice(0, 90) };
    })()"""),

    ('画布有尺寸', """(() => {
        const c = document.querySelector('canvas');
        return { ok: !!c && c.width > 100 && c.height > 100,
                 detail: c ? (c.width + 'x' + c.height) : '没有 canvas' };
    })()"""),

    ('时钟活着', """(() => {
        const c = window.__CLOCK;
        const n = (window.__CLOCKS || []).length;
        /* 端口上叫 id，不叫 kind（kind 在 config() 里）。 */
        return { ok: !!c && !!c.id && n >= 1, detail: c ? ('id=' + c.id + ' clocks=' + n) : '没有钟' };
    })()"""),

    # 语音这条路：无头里没有麦克风，所以"听见"验不了——但失败路径必须验，
    # 而且它恰好是最容易坏的那一段（按钮没接上、状态没翻译成人话、点了什么都不发生）。
    # 判据只有一条：要么真在听，要么用一句人话说清为什么不行。静默什么都不发生 = 红。
    ('麦克风接上了', """(() => {
        const b = document.getElementById('micbtn');
        const h = window.__HEAR;
        const ui = ((window.__READY || {}).blocks || {}).ui || {};
        return { ok: !!b && !!h && typeof h.describe === 'function' && ui.mic === 'off',
                 detail: `btn=${!!b} hear=${!!h} ui.mic=${ui.mic}` };
    })()"""),

    # 更新检查：它接坏了不该影响她活着（所以不在就绪清单里），
    # 但"接没接上"必须能看。更要紧的是第二条——
    # **任何状态都要有理由**。查不了却说"已是最新"是这个功能唯一致命的错法：
    # 用户会一直以为自己用的是最新版，而实际上一次都没查成功过。
    ('更新检查接上了', """(() => {
        const u = window.__UPDATES;
        return { ok: !!u && typeof u.state === 'function' && typeof u.check === 'function',
                 detail: u ? 'status=' + (u.state() || {}).status : '没有 __UPDATES' };
    })()"""),

    ('更新状态有结论、也有理由', """(() => {
        const u = window.__UPDATES;
        if (!u) return { ok: false, detail: '没有 __UPDATES' };
        const s = u.state() || {};
        const okStatus = ['unknown', 'current', 'newer', 'ahead'].includes(s.status);
        const why = String(s.reason || '');
        /* unknown 尤其不能空着——空着就等于"我知道个结果但不想说"。 */
        return { ok: okStatus && why.length >= 4,
                 detail: s.status + '：' + (why || '（没说理由）') };
    })()"""),

    ('点麦克风：在听，或者说清为什么不行', """(() => new Promise(res => {
        const b = document.getElementById('micbtn');
        if (!b || !window.__HEAR) return res({ ok: false, detail: '没有按钮或没有 __HEAR' });
        b.click();
        const t0 = performance.now();
        /* 只认"落定"的状态。asking / waiting 是过程，不是结论——
         * 拿它们算过，等于把"还没起来"当成"已经在听"，那正是这个测试要防的假绿。 */
        const tick = () => {
            const s = window.__HEAR.status();
            if (s.state === 'listening') {
                b.click();                      // 关掉，别影响后面的检查
                return res({ ok: true, detail: '在听' });
            }
            if (s.state === 'denied' || s.state === 'unsupported' || s.state === 'error') {
                const why = s.reason || '';
                return res({ ok: why.length >= 4, detail: s.state + '：' + (why || '（没说原因）') });
            }
            if (performance.now() - t0 > 6000)
                return res({ ok: false, detail: '6 秒了还停在 ' + s.state + '（按钮可能亮着，其实没在听）' });
            setTimeout(tick, 100);
        };
        tick();
    }))()"""),

    # 眼睛这条路：无头浏览器里没有桌面壳（window.desktop 是 preload 才有的），
    # 所以"看见"验不了。但**失败路径必须验**，而且它是最容易坏的一段：
    # 按钮没接上、没壳时静默返回、动作没注册进动作表——三种都会表现为"点了没反应"。
    ('眼睛接上了', """(() => {
        const b = document.getElementById('eyebtn');
        const e = window.__EYES;
        const n = (window.__REGISTRY && window.__REGISTRY.names()) || [];
        const av = e && typeof e.available === 'function' ? e.available() : null;
        return { ok: !!b && !!e && typeof e.look === 'function' && !!av
                     && n.includes('look_screen') && av.shell === false,
                 detail: `btn=${!!b} eyes=${!!e} shell=${av && av.shell} look_screen=${n.includes('look_screen')}` };
    })()"""),

    # 判据不是"能不能看"，而是"看不了的时候有没有说清楚"。
    # 无头里没有壳 → 必须是 no_shell + 一句人话；静默返回 ok:false 不给原因 = 红。
    ('没桌面壳时：说清看不了', """(() => new Promise(res => {
        if (!window.__LOOK) return res({ ok: false, detail: '没有 __LOOK' });
        window.__LOOK('冒烟测试').then(r => res({
            ok: !!r && r.ok === false && r.reason === 'no_shell' && String(r.message || '').length >= 4,
            detail: JSON.stringify(r).slice(0, 160),
        })).catch(e => res({ ok: false, detail: '抛了：' + e.message }));
    }))()"""),
]


def check_frame_advance(c):
    """帧在推进：隔 400ms 采两次 state.t。
    不用 rAF 计数——headless 里 rAF 会被降频，数出来是 3 帧/秒，
    看着像"卡住"，其实只是没开 GPU。t 递增就说明 animate 还在跑。"""
    a = c.ev('window.__state ? window.__state.t : -1')
    time.sleep(0.4)
    b = c.ev('window.__state ? window.__state.t : -1')
    ok = isinstance(a, (int, float)) and isinstance(b, (int, float)) and b > a
    return ('帧在推进', {'ok': ok, 'detail': f't {a} → {b}'})


def check_turn(c):
    """发一句话，真的跑完一轮。这是整个冒烟测试的靶心。

    为什么不用 __SEND：那是调试口，绕过表单就绕过了"输入这条路通不通"。
    为什么要先等 ready：上一版等的是 __LOOP，那条判据在半装好的页面上也是 true。
    """
    st0 = c.ev('JSON.stringify(window.__LOOP.stats())') or '{}'
    n0 = json.loads(st0).get('turns', 0)
    c.ev("""(() => {
        const box = document.getElementById('saybox');
        box.value = '把顶灯关掉';
        document.getElementById('sayform').requestSubmit();
        return 'sent';
    })()""")

    # ① 3 秒内必须进入"她在想"：进不去说明这条路根本没接上
    t0 = time.time()
    started = False
    while time.time() - t0 < 3:
        ui = c.ev('JSON.stringify(window.__UI ? window.__UI() : null)') or 'null'
        u = json.loads(ui) or {}
        if u.get('up'):
            started = True
            break
        time.sleep(0.2)
    if not started:
        return ('发一句话跑完一轮', {'ok': False, 'detail': '3 秒内没进入一轮（表单没触发？）'})

    # ② 60 秒内走完，且 turns 真的 +1
    t0 = time.time()
    while time.time() - t0 < 60:
        ui = json.loads(c.ev('JSON.stringify(window.__UI ? window.__UI() : null)') or 'null') or {}
        st = json.loads(c.ev('JSON.stringify(window.__LOOP.stats())') or '{}')
        if not ui.get('up'):
            dt = st.get('turns', 0) - n0
            last = c.ev("window.__LASTERR || ''") or ''
            # 光 turns+1 不够：她可能一句话都没说出去（字幕空）。那正是"页面看起来在转、
            # 其实话没接上"的样子，所以把字幕长度也算进去。动作数**不算**——
            # 做不做动作是她的决定，模型这一轮不想动是合法的，拿它当断言会随机变红。
            line = c.ev("(document.getElementById('herline')||{}).textContent||''") or ''
            ok = dt >= 1 and not last and len(line) >= 2
            return ('发一句话跑完一轮', {'ok': ok,
                                    'detail': f'turns {n0}→{st.get("turns")} 回话 {len(line)} 字 '
                                              f'动作 {st.get("actions")} 打断 {st.get("interrupts")}'
                                              + (f' 错误 {last}' if last else '')
                                              + ('' if line else ' | 字幕是空的')})
        time.sleep(0.5)
    return ('发一句话跑完一轮', {'ok': False, 'detail': '60 秒还没走完（卡住了）'})


def check_no_new_errors(c):
    errs = c.ev('(window.__err || []).join(" ; ")') or ''
    last = c.ev("window.__LASTERR || ''") or ''
    return ('跑完不留错误', {'ok': not errs and not last, 'detail': (errs or last or '干净')})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', default='8765')
    ap.add_argument('--url', default='')
    ap.add_argument('--timeout', type=float, default=90)
    ap.add_argument('--no-turn', action='store_true', help='只验骨架，不真发那句话')
    ap.add_argument('--keep-log', action='store_true', help='失败时把整段 console 打出来')
    ap.add_argument('--json', action='store_true', help='只输出一行 JSON')
    ap.add_argument('--sw', action='store_true', help='用 swiftshader（无 GPU 时才能开，很慢）')
    args = ap.parse_args()

    url = args.url or f'http://127.0.0.1:{args.port}/预览-66.html'
    profile = tempfile.mkdtemp(prefix='smoke-')
    # 默认**不开** swiftshader：软件光栅下 VRM 的 193 个材质贴图上传会慢到
    # 一分钟都出不来人，而"人没出来"在这套测试里看起来像"char 块没装好"——
    # 那是测法造成的假红。真要测无 GPU 环境再开 --sw。
    gpu = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] if args.sw else []
    proc = subprocess.Popen([EDGE, '--headless=new', *gpu,
                             '--hide-scrollbars', '--mute-audio', '--no-first-run',
                             '--no-default-browser-check',
                             f'--remote-debugging-port={PORT}', f'--user-data-dir={profile}',
                             'about:blank'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    results = []
    try:
        t0 = time.time()
        while True:
            try:
                http('/json/version')
                break
            except Exception:
                if time.time() - t0 > 15:
                    print('调试端口没起来（Edge 路径不对？设 EDGE_PATH）')
                    return 2
                time.sleep(0.25)

        page = [t for t in http('/json') if t['type'] == 'page'][0]
        ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=args.timeout + 30,
                                        suppress_origin=True)
        c = CDP(ws)
        c.send('Runtime.enable')
        c.send('Page.enable')
        c.send('Page.addScriptToEvaluateOnNewDocument', source=HOOK)
        c.send('Page.navigate', url=url)

        # 等页面自己说装完了。不猜 __LOOP，不等固定秒数。
        t0 = time.time()
        ready = False
        while time.time() - t0 < args.timeout:
            try:
                r = c.ev('window.__READY ? JSON.stringify({ok:__READY.ok,at:__READY.at}) : null')
                if r and json.loads(r).get('ok'):
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(0.25)

        # A/B/C：读着就能判的
        for name, expr in JS_CHECKS:
            try:
                v = c.ev(expr)
                if isinstance(v, str):
                    v = json.loads(v)
                results.append((name, {'ok': bool(v.get('ok')), 'detail': str(v.get('detail', ''))}))
            except Exception as e:
                results.append((name, {'ok': False, 'detail': f'求值失败：{e}'}))

        results.append(check_frame_advance(c))

        # D：真发一句
        if not args.no_turn:
            results.append(check_turn(c))
            results.append(check_no_new_errors(c))

        ready_note = ''
        try:
            ready_note = c.ev("window.__READY ? __READY.summary() : ''") or ''
        except Exception:
            pass
        ws.close()
    finally:
        try:
            proc.terminate()
        except Exception:
            pass

    passed = sum(1 for _, v in results if v['ok'])
    failed = len(results) - passed

    if args.json:
        print(json.dumps({'pass': passed, 'fail': failed,
                          'items': [{'name': n, **v} for n, v in results]}, ensure_ascii=False))
    else:
        for name, v in results:
            mark = '✓' if v['ok'] else '✗'
            print(f'  {mark} {name:<14} {v["detail"]}')
        if ready_note:
            print(f'  就绪报告：{ready_note}')
        if failed:
            print('')
            for name, v in results:
                if not v['ok']:
                    print(f'  ✗ {name}：{v["detail"]}')
            if args.keep_log:
                print('')
                print('---- console（最后 40 条）----')
                for l in c.logs[-40:]:
                    print('  ', l)
        print('')
        print(f'全过：{passed} 过，{failed} 不过')

    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
