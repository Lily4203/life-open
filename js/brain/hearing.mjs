/* 听：把"他在说话"变成"一句话"
 * ============================================================
 * P3 要的是"她能听见"，不是"我们能转写"。区别全在边界上：
 *
 *   麦克风 →〔引擎〕→ 一句话 → chat-in(source:'voice') → 记忆 → 她下一轮读到
 *
 * 这一层只做中间那个方括号，而且只交**文本**。三条界线，改之前先读：
 *
 *   ① **音频不进大脑**。转写在浏览器里就做完了（Edge 自带的那个），
 *      所以这一层永不碰 MediaRecorder / AudioContext / getUserMedia，
 *      也永不往外递 ArrayBuffer。出去的东西只有 { text, source:'voice' } 两个键——
 *      是白名单重建，不是"顺手把音频删掉再传"。
 *   ② **"他说完了"由引擎断句（isFinal），不许用沉默计时器猜**。
 *      这不是"早一点晚一点"的问题：拿时间宣布"这句话完了"是替世界下一个它没下过的结论。
 *      半句被当成整句送进去，她会对着半句回话，而且事后永远查不出为什么。
 *      所以这个文件里只有一个 setTimeout（引擎自己收尾之后的重开间隔），
 *      没有任何一个计时器会把半句定稿。测试里锁死这一条。
 *   ③ **关掉就一条都不进**。stop() 之后还在路上的结果直接丢——
 *      麦克风关着还往里写，那就是她偷听。
 *
 * 为什么是 Edge 的（webkitSpeechRecognition）而不是本地 whisper：
 *   零依赖、零模型、不用自己搭一条上传音频的服务。代价两条，都写在 reason 里给人看：
 *   断网就哑；识别是在微软那边做的（不是本机）。要换本地引擎时，换的是 make 这一个参数，
 *   上面三条界线一条都不用动。
 *
 * 引擎只要能提供这个子集（浏览器那个对象就是）：
 *   { start(), abort(), lang, continuous, interimResults,
 *     onstart, onresult, onerror, onend, onnomatch }
 */

/* 状态就这七个，每个都要能翻译成一句人话（describe 里那张表就是它）。
 * off 是他关的；unsupported 是这浏览器没有；denied 是他没给权限；
 * waiting 是引擎自己收尾了、我们正在把它接回来——这个状态最容易被当成"在听"，
 * 所以单独列出来：那几百毫秒里她其实听不见。 */
export const STATES = ['off', 'asking', 'listening', 'waiting', 'denied', 'unsupported', 'error'];

/* 这些错的名字是浏览器的，原因得说人话。
 * 没列的走兜底（把原始 code 端上来），不许编一句看起来对的话。 */
const ZH = {
  'not-allowed': '麦克风没给权限——点地址栏左边那个图标可以改',
  'service-not-allowed': '这个页面不许用语音识别（要 https 或 127.0.0.1 打开，不能是 file://）',
  'audio-capture': '找不到麦克风（系统里没有可用的输入设备）',
  network: '连不上语音识别服务——要联网；Edge 还要在系统设置里打开「在线语音识别」',
  'language-not-supported': '它不认识这个语言',
  'bad-grammar': '语音服务不接受这个语法（Edge 一般不会出现）',
};

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/* 只有标点、没有字的"结果"不是一句话。
 * 引擎在纯噪音上会给回 "。" 这种——送进记忆，她下一轮就得对着一个句号说话。 */
const hasWords = (s) => /[\p{L}\p{N}]/u.test(s);

function defaultMake() {
  const R = typeof window !== 'undefined'
    ? (window.SpeechRecognition || window.webkitSpeechRecognition)
    : null;
  return R ? new R() : null;
}

export function createHearing({
  make = null,                 // () => 引擎实例。不传就用 Edge 的；测试里传假的
  lang = 'zh-CN',
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (h) => clearTimeout(h),
  restartDelayMs = 400,        // 引擎自己收尾之后隔多久接回来
  maxBackoffMs = 4000,         // 连着"刚起步就结束"时，间隔翻倍到这里为止
  maxFails = 6,                // 连着错这么多次就自己关掉，并说出来
  onSaid = () => {},           // 一句说完了：{ text, source:'voice' }
  onPartial = () => {},        // 正在说的半句（只给人看，绝不外发）
  onState = () => {},          // 状态变了（界面用）
} = {}) {
  const stats = {
    says: 0, partials: 0, starts: 0, restarts: 0,
    errors: 0, noSpeech: 0, empty: 0, drops: 0, emitErrors: 0,
  };

  let state = 'off';
  let reason = '';
  let want = false;            // 他要不要听（不是"引擎此刻在不在跑"）
  let inst = null;
  let timer = null;
  let startedAt = 0;
  let quickEnds = 0;           // 连着几次"刚起步就结束"
  let fails = 0;               // 连着几次错（onstart 就清零）
  let partial = '';
  let lastText = '';
  let lastAt = 0;

  const status = () => ({
    state, want, reason, partial, last: lastText, lastAt,
    says: stats.says, starts: stats.starts, restarts: stats.restarts,
    errors: stats.errors, noSpeech: stats.noSpeech,
  });

  function setState(s, why = '') {
    if (state === s && reason === why) return;
    state = s;
    reason = why;
    try { onState(status()); } catch { /* 界面坏了不许把耳朵带停 */ }
  }

  const clearTimer = () => { if (timer) { cancel(timer); timer = null; } };

  /* 定稿只有这一个出口，而且调用它的地方只有"引擎说 isFinal"。
   * 这里做两件事：挡住不是话的"结果"，以及**重建**一个只有两个键的对象。 */
  function emit(raw) {
    const text = clean(raw);
    if (!text || !hasWords(text)) { stats.empty += 1; return; }
    stats.says += 1;
    lastText = text;
    lastAt = now();
    fails = 0;
    /* 听见了东西，就说明它不是在空转：退避清零，下次引擎自己断了照常 400 毫秒接回来。 */
    quickEnds = 0;
    partial = '';
    try {
      onSaid({ text, source: 'voice' });
    } catch (e) {
      /* 下游（chat-in）坏了，这一句丢了，但耳朵不能跟着停——
       * 人说话的时候，你听不清一句不会就此聋掉。 */
      stats.emitErrors += 1;
    }
  }

  function onResult(ev) {
    if (!want || !inst) { stats.drops += 1; return; }   // 关掉之后还在路上的：丢
    const rs = (ev && ev.results) || [];
    /* 只从 resultIndex 往后看：在连续的引擎里，results 里前面是**上一批**已经处理过的，
     * 从 0 开始遍历会把同一句反复送进去（她说这是你第三次说同一句话）。 */
    const from = Number.isFinite(ev && ev.resultIndex) ? ev.resultIndex : 0;
    let acc = '';
    let sent = 0;
    for (let i = from; i < rs.length; i++) {
      const alt = rs[i] && rs[i][0];
      const t = alt && alt.transcript;
      if (!t) continue;
      if (rs[i].isFinal) { emit(t); sent += 1; }
      else acc += t;
    }
    const p = clean(acc);
    if (p) {
      if (p !== partial) {
        partial = p;
        stats.partials += 1;
        try { onPartial(p); } catch { /* 同上 */ }
      }
    } else if (sent) {
      partial = '';
    }
  }

  function onError(ev) {
    const code = String((ev && ev.error) || 'unknown');
    /* no-speech：这一段没人说话。不是错误，更不是"他说完了"——
     * 什么都不做，接着听。把它当错误，她安静坐着的时候就会一直弹红字。 */
    if (code === 'no-speech') { stats.noSpeech += 1; return; }
    /* aborted：我们自己叫停的（stop / 换实例）。不报。 */
    if (code === 'aborted') return;

    stats.errors += 1;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      /* 权限被拒是**他的决定**，不是暂时故障：不许自动重试——
       * 那样每一秒都在弹权限框，等于拿弹窗逼他同意。 */
      want = false;
      clearTimer();
      setState('denied', ZH[code]);
      return;
    }
    fails += 1;
    if (fails >= maxFails) {
      /* 试烦了就停，并且把"试过几次"说出来。静默地一直重试，
       * 表现是按钮亮着、人以为在听，其实一句也进不来。 */
      want = false;
      clearTimer();
      setState('error', (ZH[code] || ('听不了：' + code)) + `；试了 ${fails} 次，先关了`);
      return;
    }
    setState('error', ZH[code] || ('听不了：' + code));
  }

  function onEnd() {
    inst = null;
    if (!want) {
      if (state !== 'denied' && state !== 'error') setState('off');
      return;
    }
    /* 引擎自己收尾了。Edge/Chromium 的 continuous 是真的会断（静音一段、超时、换了设备），
     * 所以**必须**重开，否则就是"听一次，之后再也不听"——而这种坏法看起来像"偶尔不好使"。
     * 但重开不能是死循环：连着"刚起步就结束"就把间隔翻倍，最长 4 秒一次。 */
    const quick = startedAt && now() - startedAt < 700;
    quickEnds = quick ? quickEnds + 1 : 0;
    const wait = Math.min(maxBackoffMs, restartDelayMs * Math.pow(2, Math.min(quickEnds, 4)));
    stats.restarts += 1;
    setState('waiting');
    clearTimer();
    timer = schedule(spawn, wait);
  }

  function spawn() {
    timer = null;
    if (!want) return;

    /* 保险：上一具还没死透就先送走。真出现过——denied 之后引擎不一定发 onend，
     * 他再点一次"听"就会有两个实例抢同一个麦克风，谁收到什么都不一定。 */
    if (inst) { const o = inst; inst = null; try { o.abort(); } catch { /* 本来就停了 */ } }

    let r = null;
    try {
      r = make ? make() : defaultMake();
    } catch (e) {
      want = false;
      setState('unsupported', '这个浏览器不给语音识别：' + (e.message || e));
      return;
    }
    if (!r) {
      /* 没有这个 API 就别装出"在听"的样子。start() 返回 ok:false，界面照实说。 */
      want = false;
      setState('unsupported', '这个浏览器没有语音识别（要用 Edge 或 Chrome，并且从 127.0.0.1 / https 打开）');
      return;
    }

    inst = r;
    try {
      r.lang = lang;
      r.continuous = true;        // 不设就是"说一句就停"，那就得靠我们自己反复叫它
      r.interimResults = true;    // 半句只给人看（"在听…"），不算他的话
      r.maxAlternatives = 1;      // 多给几个候选就变成我们在挑，不是它在听
      r.onstart = () => { startedAt = now(); fails = 0; setState('listening'); };
      r.onresult = onResult;
      r.onerror = onError;
      r.onend = onEnd;
      /* 没听清（nomatch）。不是错，也不是说完了——什么都不做，接着听。 */
      r.onnomatch = () => { };
      stats.starts += 1;
      setState('asking');
      r.start();
    } catch (e) {
      /* 已经在跑的时候再 start() 会抛 InvalidStateError。那不算故障：
       * 把实例扔掉，等它自己 onend，再按正常那条路重开。 */
      inst = null;
      setState('error', '启动失败：' + (e.message || e));
    }
  }

  function start() {
    if (want) return { ok: true, already: true, state };
    if (state === 'unsupported') return { ok: false, reason: 'unsupported', message: reason };
    want = true;
    fails = 0;
    quickEnds = 0;
    setState('asking');
    spawn();
    return { ok: want, state, reason };
  }

  function stop() {
    const was = state;
    want = false;
    clearTimer();
    const o = inst;
    inst = null;
    /* abort 而不是 stop：stop 会等这一句说完，可"关掉麦克风"的意思是
     * 从这一刻起一个字都别进来。 */
    if (o) { try { o.abort(); } catch { /* 还没起来就没什么可停的 */ } }
    partial = '';
    setState('off');
    return { ok: true, was };
  }

  const toggle = () => (want ? stop() : start());

  function describe() {
    const s = {
      off: '没在听',
      asking: '在等麦克风',
      listening: '在听你说',
      waiting: '它自己停了一下，正要接回来',
      denied: '麦克风没开',
      unsupported: '这个浏览器听不了',
      error: '听不了',
    }[state] || state;
    return (reason && (state === 'denied' || state === 'unsupported' || state === 'error'))
      ? `${s}：${reason}` : s;
  }

  return {
    start, stop, toggle,
    status,
    describe,
    stats: () => ({ ...stats }),
    /** 现在开着没有（他要不要听，不是引擎此刻在不在跑）。 */
    on: () => want,
    /** 现在真的能听见吗（asking/waiting 都不算）。 */
    live: () => state === 'listening',
    lang,
  };
}
