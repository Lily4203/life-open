/* 声音端口：把"她说的话"变成"听得见的话"
 * ============================================================
 * 这是直播那六条标准里的第一条（L1）。它同样是**一个口子**，不是写死的一段代码：
 *
 *   后端 'server'  —— 走本机 /api/tts（默认；离线系统语音或 edge-tts，服务端决定）
 *   后端 'none'    —— 明确不要声音（省电/录屏/调试）
 *
 * 换音色、换引擎、换云端，都只动服务端那一张引擎表（tools/tts.mjs），
 * 页面和大脑不知道声音从哪来。
 *
 * 三条纪律：
 *   1. **没有声音不许装死**：返回 {ok:false, reason, message}，页面只记一次状态，不弹红字。
 *      她照样"说"——字幕在，只是哑的。哑是事实，不是错误。
 *   2. **不替她演**：没声音时口型保持闭合，不做"假装在说话"的假动作。
 *   3. **一个人不能同时说两句话**：新的一句直接接上，前一句停掉（不做叠音）。
 *
 * 口型：不从文本猜音素，直接看**波形响度**（AnalyserNode 的 RMS）。
 * 效果不如音素对齐精细，但不需要音素词典、任何语言都能用，而且不会假。
 */

export const BACKENDS = ['server', 'none'];

/** 响度 → 张嘴幅度。0.7 以下基本闭嘴，避免底噪让嘴一直抖。 */
export function levelFromWave(bytes) {
  if (!bytes || !bytes.length) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / bytes.length);
  if (rms < 0.02) return 0;
  return Math.min(1, (rms - 0.02) * 5.5);
}

export function createVoice({
  base = '',
  backend = 'server',
  engine = 'auto',
  voice = '',
  fetchImpl = (typeof fetch === 'function' ? (...a) => fetch(...a) : null),
  audio = null,
  onLevel = () => {},
  raf = null,
  now = Date.now,
} = {}) {
  if (!BACKENDS.includes(backend)) throw new Error(`没有这个声音后端：${backend}（只允许 ${BACKENDS.join('/')}）`);

  let available = backend === 'none' ? false : null;   // null = 还没问过
  let lastReason = backend === 'none' ? '关掉了' : '';
  let lastMeta = { engine: '', voice: '', rate: '', pitch: '', pauseMs: 0 };
  let src = null, analyser = null, tick = null, ctx = audio, buf = null;
  let pauseTimer = null;      // 句尾停顿的计时器（停顿时被打断要清掉，否则下一句要等完）
  let level = 0;
  const stats = { asked: 0, ok: 0, failed: 0, ms: 0, chars: 0, truncated: 0 };

  const nextFrame = raf || (cb => setTimeout(() => cb(now()), 16));
  const stopFrame = (h) => { if (h && typeof clearTimeout === 'function') clearTimeout(h); };

  function emitLevel(v) {
    const nv = Math.max(0, Math.min(1, v));
    /* 平滑一下：波形每 16ms 变一次，直接给会抖成摩斯电码。 */
    const eased = level * 0.45 + nv * 0.55;
    level = eased < 0.02 ? 0 : eased;
    try { onLevel(level); } catch { /* 嘴坏了不该影响说话 */ }
  }

  /* 闭嘴：不走平滑，直接归零。走的后果是"打断"之后嘴还张着半秒，
   * 看着像她在偷偷说话。 */
  function closeMouth() {
    level = 0;
    try { onLevel(0); } catch { /* 嘴坏了不该影响说话 */ }
  }

  function hardStop() {
    try { if (src) { src.onended = null; src.stop(); } } catch { /* 已经停了 */ }
    src = null;
    stopFrame(tick); tick = null;
    /* 正在"句尾停顿"里被打断：把那一下等也取消，不然下一个说话要白等两百毫秒。 */
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
    closeMouth();
  }

  /** 问一句服务端：有没有能出声的引擎。只问一次，失败就当没有。 */
  async function probe() {
    if (backend === 'none' || !fetchImpl) { available = false; return { ok: false, engines: [] }; }
    try {
      const r = await fetchImpl(base + '/api/tts/health');
      const j = await r.json();
      available = !!j.ok;
      if (!available) lastReason = '服务端没有能出声的引擎：' + (j.engines || []).map(e => `${e.engine}:${e.why}`).join('；');
      return j;
    } catch (e) {
      available = false;
      lastReason = '连不上本地服务：' + (e.message || e);
      return { ok: false, engines: [] };
    }
  }

  /* 浏览器的自动播放策略：没有用户手势之前，AudioContext 是 suspended 的。
   * 不解开的话，声音"播了"（时间在走、ended 也会来），但**一个采样都不出来**，
   * 口型永远是 0——看起来像口型坏了，其实是根本没响。真跑抓到的。 */
  async function unlock() {
    try {
      const ac = attachCtx();
      if (ac.state === 'suspended' && typeof ac.resume === 'function') {
        /* resume() 在没有用户手势时**可能永远不 resolve**（不是 reject，是挂着）。
         * 直接 await 会把说话卡死在这里——真跑抓到过一次。所以只等 300ms，不等就往下走。 */
        await Promise.race([ac.resume().catch(() => {}), new Promise(r => setTimeout(r, 300))]);
      }
      return ac.state || 'unknown';
    } catch { return null; }
  }

  function attachCtx() {
    if (ctx) return ctx;
    const C = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!C) throw new Error('这个浏览器没有 AudioContext');
    ctx = new C();
    return ctx;
  }

  /**
   * 说一句。返回 {ok, reason?, message?, ms?, chars?, duration?, done?}
   * opt.mood 只影响"怎么念"（语速/音高），不影响"念什么"。
   * 不抛异常——声音出不来不该让"说话"这件事本身失败。
   */
  async function speak(text, opt = null) {
    const t = String(text ?? '').trim();
    if (!t) return { ok: false, reason: 'empty' };
    if (backend === 'none') return { ok: false, reason: 'off', message: '关掉了声音' };
    if (!fetchImpl) return { ok: false, reason: 'no_fetch' };
    if (available === false) return { ok: false, reason: 'no_voice', message: lastReason };
    if (available === null) await probe();
    if (available === false) return { ok: false, reason: 'no_voice', message: lastReason };

    stats.asked += 1;
    const t0 = now();
    let r, ab;
    try {
      r = await fetchImpl(base + '/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /* mood 是"她这会儿的脸色"。传下去之后，服务端会把它变成语速和音高——
         * 高兴快一点亮一点，难过慢一点沉一点。不认识的情绪服务端会自己当没有，不会瞎猜。 */
        body: JSON.stringify({ text: t, engine, voice, mood: (opt && opt.mood) || null }),
      });
      if (!r.ok) {
        let msg = `合成失败（HTTP ${r.status}）`;
        try { const j = await r.json(); msg = j.message || msg; } catch { /* 不是 JSON 就用上面那句 */ }
        available = false; lastReason = msg; stats.failed += 1;
        return { ok: false, reason: 'no_voice', message: msg };
      }
      if (r.headers?.get?.('X-Tts-Truncated') === '1') stats.truncated += 1;
      /* 哪个引擎、什么音色、语速多少：排障时"这句为什么还是机器人"要能一眼看出来，
       * 不然只能猜是没换引擎、还是换了但没生效。 */
      try {
        lastMeta = {
          engine: r.headers.get('X-Tts-Engine') || '',
          voice: r.headers.get('X-Tts-Voice') || '',
          rate: decodeURIComponent(r.headers.get('X-Tts-Rate') || ''),
          pitch: decodeURIComponent(r.headers.get('X-Tts-Pitch') || ''),
          pauseMs: Number(r.headers.get('X-Tts-Pause') || 0),
        };
      } catch { /* 头读不到不影响出声 */ }
      ab = await r.arrayBuffer();
    } catch (e) {
      stats.failed += 1;
      lastReason = '请求合成时出错：' + (e.message || e);
      return { ok: false, reason: 'threw', message: lastReason };
    }

    try {
      /* 一个人不能同时说两句：前一句停掉，新的接上。 */
      hardStop();
      const ac = attachCtx();
      await unlock();                       // 先解开自动播放限制，否则等于没播
      buf = await ac.decodeAudioData(ab);
      src = ac.createBufferSource();
      src.buffer = buf;
      analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      analyser.connect(ac.destination);
      const wave = new Uint8Array(analyser.fftSize);
      /* done 是"这一句真的播完了（含句尾那一下停顿）"的信号。
       * 逐句说话（流式）时，下一句什么时候能接上，只有 onended 知道得准；
       * 按 duration 估时，估短了掐尾、估长了空档，两种都听得出来。
       *
       * 为什么停顿放在这里而不是音频里：edge 产出的是 mp3，服务端补不了静音；
       * 而 sapi 产出 wav 能补——两种引擎的停顿就变成不一样了。
       * 统一在这儿等，mp3/wav 都适用，而且唇形是闭着的（onended 已经归零），
       * 看起来就是"她说完，停了一下"。
       * 注意：它只是**告诉别人**播完了，不改变 speak 自己的返回时机。 */
      let doneResolve = null;
      const done = new Promise(res => { doneResolve = res; });
      src.onended = () => {
        src = null; stopFrame(tick); tick = null; closeMouth();
        const fire = () => { pauseTimer = null; try { doneResolve && doneResolve(); } catch { /* 没人等也不能炸 */ } };
        const wait = Math.max(0, Math.min(1200, Number(lastMeta.pauseMs) || 0));
        if (wait) pauseTimer = setTimeout(fire, wait); else fire();
      };
      src.start();

      const pump = () => {
        if (!src) return;
        analyser.getByteTimeDomainData(wave);
        emitLevel(levelFromWave(wave));
        tick = nextFrame(pump);
      };
      pump();

      stats.ok += 1;
      stats.ms += now() - t0;
      stats.chars += t.length;
      return { ok: true, ms: now() - t0, chars: t.length, duration: buf.duration, done };
    } catch (e) {
      stats.failed += 1;
      available = false;
      lastReason = '解不出这段音频：' + (e.message || e);
      return { ok: false, reason: 'threw', message: lastReason };
    }
  }

  return {
    speak, stop: hardStop, probe, unlock,
    /** 会不会出声。空数组 = 只能看字幕。 */
    caps: () => (available ? ['lipsync'] : []),
    available: () => available,
    reason: () => lastReason,
    level: () => level,
    stats: () => ({ ...stats }),
    /** 上一句是用什么念的：引擎 / 音色 / 语速 / 音高 / 句尾停顿。排障用。 */
    meta: () => ({ ...lastMeta }),
    describe: () => (available === false
      ? `现在没有声音（${lastReason || '还没探到'}），只能看字。`
      : available === null
        ? '还没试过声音。'
        : lastMeta.engine
          ? `能出声：${lastMeta.engine}${lastMeta.voice ? ' / ' + lastMeta.voice : ''}`
            + `${lastMeta.rate ? ' · 语速 ' + lastMeta.rate : ''}${lastMeta.pitch ? ' · 音高 ' + lastMeta.pitch : ''}`
          : `能出声：${engine === 'auto' ? '服务端自己挑引擎' : engine}`),
  };
}
