# -*- coding: utf-8 -*-
"""声音这一层到底通不通：真的合成、真的解码、真的有波形。
================================================================
为什么要有它
------------
"她说起话来像机器人"这件事，改完之后必须在能听见的地方验一次。
node 断言只能证明"参数算对了"，证明不了：

  · 服务端回来的字节，浏览器**能不能解**（mp3 还是 wav、头对不对）
  · 解出来是**多长**（太短=被截断，太长=合成串了）
  · 波形有**能量**（全是 0 就是"她张嘴没出声"，这个用肉眼看不出）
  · 语速/音高是不是真的按 mood 变（改了参数但没生效，是最常见的"以为改好了"）

跑过一次真踩的坑：edge 回的是 mp3，被当成裸 PCM 套了 wav 头。
RIFF 头是对的、字节数是对的、所有校验都过——播出来全是噪声。
所以这里不看文件头，**只在真浏览器里 decode 一遍**。

用法
----
    python tools/voice-probe.py               验服务端 ::1 的 8765
    python tools/voice-probe.py --port 8802
    python tools/voice-probe.py --keep-log    失败时打完整 console

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
CDP_PORT = 9338

HOOK = r"""
window.__err = [];
addEventListener('error', e => window.__err.push('ERR ' + (e.message || e.type)));
addEventListener('unhandledrejection', e => window.__err.push('REJ ' + (e.reason && (e.reason.message || e.reason))));
"""

# 一句话，三个心情。同一句才能比出"语气真的变了"。
SENTENCE = '你回来啦，我等你好久了。'
CASES = [('平常', None), ('高兴', 'happy'), ('难过', 'sad')]
# 中文正常语速大约每秒 4-6 个字。超出这个范围说明合成串了或者被截了。
CPS_MIN, CPS_MAX = 2.0, 9.0


def http(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with op.open(f'http://127.0.0.1:{CDP_PORT}{path}', timeout=5) as r:
        return json.loads(r.read().decode('utf-8'))


def js(c, expr, timeout=60):
    r = c.send('Runtime.evaluate', expression=expr, awaitPromise=True,
               returnByValue=True, timeout=timeout * 1000)
    if 'exceptionDetails' in r:
        d = r['exceptionDetails']
        raise RuntimeError(d.get('text', '') + ' ' + str(d.get('exception', {}).get('description', ''))[:300])
    return r['result'].get('value')


PROBE = r"""
(async () => {
  const out = { cases: [], errors: [] };
  const post = async (text, mood) => {
    const t0 = performance.now();
    const r = await fetch('/api/tts', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ text, mood })
    });
    const meta = {
      status: r.status, type: r.headers.get('content-type'),
      engine: r.headers.get('x-tts-engine'), voice: r.headers.get('x-tts-voice'),
      rate: decodeURIComponent(r.headers.get('x-tts-rate') || ''),
      pitch: decodeURIComponent(r.headers.get('x-tts-pitch') || ''),
      pause: Number(r.headers.get('x-tts-pause') || 0),
    };
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).message || ''; } catch (e) {}
      return { ...meta, ok: false, message: msg, ms: Math.round(performance.now() - t0) };
    }
    const ab = await r.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    let buf = null;
    try { buf = await ac.decodeAudioData(ab.slice(0)); }
    catch (e) { return { ...meta, ok: false, bytes: ab.byteLength, decodeError: String(e.message || e) }; }
    const ch = buf.getChannelData(0);
    // 每 7 个采样看一个：够密，又不用扫 60 万个点
    let peak = 0, sum = 0, n = 0, quiet = 0;
    for (let i = 0; i < ch.length; i += 7) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
      sum += v * v; n += 1;
      if (v < 0.01) quiet += 1;
    }
    return {
      ...meta, ok: true, bytes: ab.byteLength,
      duration: +buf.duration.toFixed(2),
      rate_hz: buf.sampleRate,
      peak: +peak.toFixed(3),
      rms: +Math.sqrt(sum / n).toFixed(4),
      quiet: +(quiet / n).toFixed(2),          // 静音占比：真人说话有气口，但不是一半静音
      ms: Math.round(performance.now() - t0),
      chars: text.replace(/[，。！？、；：]/g, '').length,
    };
  };

  for (const [name, mood] of [['平常', null], ['高兴', 'happy'], ['难过', 'sad']]) {
    try { out.cases.push({ name, ...(await post(%SENTENCE%, mood)) }); }
    catch (e) { out.errors.push(name + ': ' + (e.message || e)); }
  }
  // 服务端说自己是哪个引擎、什么音色——和 header 对得上才算真的换了
  try {
    const h = await (await fetch('/api/tts/health')).json();
    out.health = { engines: (h.engines || []).map(e => e.engine + (e.ready ? '' : '(没用)')), persona: h.persona, daemon: h.daemon };
  } catch (e) { out.errors.push('health: ' + (e.message || e)); }

  // 再验一次"页面自己的声音端口"：不是直接 fetch，而是走 voice.speak 这条真路
  try {
    if (window.__SPEAKER) {
      window.__SPEAKER.unlock();
      const r = await window.__SPEAKER.speak('嗯，我在呢。', { mood: 'happy' });
      out.voice = { ok: !!r.ok, duration: r.duration ? +r.duration.toFixed(2) : null, meta: window.__SPEAKER.meta() };
      window.__SPEAKER.stop();
    } else out.voice = { ok: false, why: '页面上没有 __SPEAKER' };
  } catch (e) { out.errors.push('voice: ' + (e.message || e)); }

  out.pageErrors = (window.__err || []).slice(0, 5);
  return JSON.stringify(out);
})()
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', default='8765')
    ap.add_argument('--timeout', type=float, default=90)
    ap.add_argument('--keep-log', action='store_true')
    args = ap.parse_args()

    url = f'http://127.0.0.1:{args.port}/预览-66.html'
    profile = tempfile.mkdtemp(prefix='voice-')
    proc = subprocess.Popen([EDGE, '--headless=new', '--hide-scrollbars', '--no-first-run',
                             '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
                             f'--remote-debugging-port={CDP_PORT}', f'--user-data-dir={profile}',
                             'about:blank'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    errors = []
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
        c = _cdp(ws)
        c.send('Runtime.enable')
        c.send('Page.enable')
        c.send('Page.addScriptToEvaluateOnNewDocument', source=HOOK)
        c.send('Page.navigate', url=url)

        # 等页面自己说装完（不等固定秒数）
        t0 = time.time()
        while time.time() - t0 < args.timeout:
            try:
                if js(c, 'window.__READY && window.__READY.ok ? 1 : 0') == 1:
                    break
            except Exception:
                pass
            time.sleep(0.3)

        raw = js(c, PROBE.replace('%SENTENCE%', json.dumps(SENTENCE, ensure_ascii=False)), timeout=120)
        data = json.loads(raw)
    except Exception as e:
        print('跑不起来：%s' % (e,))
        if args.keep_log:
            import traceback
            traceback.print_exc()
        return 2
    finally:
        try:
            proc.terminate()
        except Exception:
            pass

    npass, nfail = 0, 0

    def ok(cond, name, extra=''):
        nonlocal npass, nfail
        if cond:
            npass += 1
            print('  ✓ %s' % name)
        else:
            nfail += 1
            print('  ✗ %s%s' % (name, ('  → ' + str(extra)) if extra else ''))

    print('\nA. 服务端说自己是哪个引擎')
    h = data.get('health') or {}
    ok((h.get('engines') or [])[:1] == ['edge'], 'A1 第一个引擎是 edge（不是本机拼接音）',
       str(h.get('engines')))
    ok((h.get('persona') or {}).get('voice', '').endswith('Neural'), 'A2 音色是神经音色',
       str((h.get('persona') or {}).get('voice')))
    ok((h.get('daemon') or {}).get('ready') is True, 'A3 常驻进程活着（否则每句慢两秒）',
       str(h.get('daemon')))

    print('\nB. 浏览器真的能解出声音')
    cases = data.get('cases') or []
    ok(len(cases) == 3, 'B1 三句都回来了', len(cases))
    for one in cases:
        name = one.get('name')
        tag = '%s(%s)' % (name, one.get('engine'))
        ok(one.get('ok'), 'B2 %s 解码成功' % tag, one.get('decodeError') or one.get('message'))
        if not one.get('ok'):
            continue
        ok(one.get('type') == 'audio/mpeg', 'B3 %s Content-Type 对得上' % tag, one.get('type'))
        ok(0.6 <= one.get('duration', 0) <= 20, 'B4 %s 时长合理 %ss' % (tag, one.get('duration')))
        cps = one.get('chars', 0) / max(0.1, one.get('duration', 0.1))
        ok(CPS_MIN <= cps <= CPS_MAX, 'B5 %s 语速 %0.1f 字/秒（不像被截断/串了）' % (tag, cps))
        ok(one.get('peak', 0) > 0.05, 'B6 %s 有波形（峰值 %s）' % (tag, one.get('peak')))
        ok(one.get('rms', 0) > 0.005, 'B7 %s 有能量（RMS %s，不是一段静音）' % (tag, one.get('rms')))
        ok(0.0 <= one.get('quiet', 1) <= 0.85, 'B8 %s 静音占比 %s（一半静音就是没说话）' % (tag, one.get('quiet')))

    print('\nC. 心情真的换了口气')
    by = {c.get('name'): c for c in cases}
    plain, happy, sad = by.get('平常') or {}, by.get('高兴') or {}, by.get('难过') or {}
    if plain.get('ok') and happy.get('ok') and sad.get('ok'):
        ok(happy.get('rate') != plain.get('rate'), 'C1 高兴和平时语速不一样',
           '%s vs %s' % (happy.get('rate'), plain.get('rate')))
        ok(sad.get('rate') != plain.get('rate'), 'C2 难过和平时语速不一样',
           '%s vs %s' % (sad.get('rate'), plain.get('rate')))
        ok(happy.get('pitch') != sad.get('pitch'), 'C3 高兴比难过亮',
           '%s vs %s' % (happy.get('pitch'), sad.get('pitch')))
        ok(plain.get('pause', 0) > 0, 'C4 句尾停顿报给前端了', plain.get('pause'))
    else:
        ok(False, 'C1-C4 三句都成功才比得出语气', '有一句没成功')

    print('\nD. 页面自己的声音端口')
    v = data.get('voice') or {}
    ok(v.get('ok'), 'D1 __SPEAKER.speak 出声成功', v.get('why') or v.get('meta'))
    if v.get('ok'):
        ok((v.get('meta') or {}).get('engine') == 'edge', 'D2 走的是 edge（不是退回 sapi）',
           str((v.get('meta') or {}).get('engine')))
        ok((v.get('meta') or {}).get('voice', '').endswith('Neural'), 'D3 音色是神经音色',
           str((v.get('meta') or {}).get('voice')))
        ok(v.get('duration', 0) > 0.5, 'D4 拿到了时长 %ss' % v.get('duration'))

    print('\nE. 页面没崩')
    ok(not data.get('pageErrors'), 'E1 没有页面异常', str(data.get('pageErrors')))
    ok(not data.get('errors'), 'E2 探针自己没出错', str(data.get('errors')))

    print('\n全过：%d 过，%d 不过\n' % (npass, nfail))
    return 0 if nfail == 0 else 1


def _cdp(ws):
    """最小的 CDP 客户端（只用到 send）。和 smoke.py 里那个一样，不共享是为了让两个文件各自能跑。"""
    class C:
        def __init__(self, sock):
            self.ws = sock
            self.id = 0

        def send(self, method, **params):
            self.id += 1
            mid = self.id
            self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params}))
            while True:
                msg = json.loads(self.ws.recv())
                if msg.get('id') == mid:
                    if 'error' in msg:
                        raise RuntimeError(msg['error'].get('message', 'CDP 出错'))
                    return msg.get('result', {})
    return C(ws)


if __name__ == '__main__':
    sys.exit(main())
