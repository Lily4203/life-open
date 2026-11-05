/* 感官：光标、键盘、屏幕
 * ------------------------------------------------------------
 * 这三样都是"世界现在这样"，不是"现在几点"。
 * 所以它们只能进事件通道（perception.signal），不能进快照——
 * "他正在打字"如果做成布尔，就必须靠"多久没打字"变回 false，那一秒就成了定时器。
 *
 * 三条克制，写在这里是有意的：
 *   ① 光标只在**区域变了**才报，不是每动一像素报一次。位置没变就不发（照 AIRI 的 screen.ts）。
 *   ② 键盘一"串"只报一次。节流用的是**到达时间**，不是"等他不敲了"——
 *      后者是推断，前者只是传输层限速。
 *   ③ 屏幕默认关。要看，得有人明确同意；每看一次是一条记录，不是一直开着。
 *
 * 这个文件不截图、不读 DOM、不碰 canvas。它只把"发生了一件事"转成一条事件，
 * 至于要不要为这件事醒来，是规则和大脑的事。
 */

/* 九宫格。不给坐标：给了坐标，模型就会开始算"往左 300 像素"。 */
export const REGIONS = ['左上', '上', '右上', '左', '中', '右', '左下', '下', '右下'];

export function regionOf({ x, y, w, h } = {}) {
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  const cx = Math.min(2, Math.max(0, Math.floor((x / w) * 3)));
  const cy = Math.min(2, Math.max(0, Math.floor((y / h) * 3)));
  return REGIONS[cy * 3 + cx];
}

export function createSenses({ emit = null, now = () => Date.now(),
                               cursorGateMs = 800, typingGateMs = 5000,
                               enabled = {} } = {}) {
  const on = {
    pointer_region: false,   // 默认不报：鼠标一直在动，报了全是噪音
    typing: true,            // 敲键盘是"他真的在动"，但按串限速
    screen: false,           // 默认关：隐私
    ...enabled,
  };

  let lastRegion = null;
  let lastCursorAt = -Infinity;
  let lastTypingAt = -Infinity;
  let screenConsent = false;
  const counts = { cursor: 0, typing: 0, screen: 0, suppressed: 0, skipped: 0 };
  const log = [];

  function send(type, detail) {
    counts[type === 'pointer_region' ? 'cursor' : type === 'typing' ? 'typing' : 'screen'] += 1;
    log.push({ at: now(), type, detail });
    if (typeof emit !== 'function') return { ok: false, reason: 'no_sink' };
    return emit(type, detail);
  }

  function enable(name, v = true) {
    if (!(name in on)) throw new Error(`没有这种感官：${name}（有 ${Object.keys(on).join('/')}）`);
    on[name] = Boolean(v);
    return on[name];
  }

  /* 光标。只报"换了个区域"，同一区域里怎么动都不报。
   * 超过 gate 才允许再报一次，是防止手抖在边界上来回蹭出一串事件。 */
  function cursor(pos) {
    const r = regionOf(pos);
    if (!r) return { ok: false, reason: 'bad_position' };
    const changed = r !== lastRegion;
    lastRegion = r;
    if (!on.pointer_region) { counts.skipped += 1; return { ok: true, skipped: 'disabled', region: r }; }
    if (!changed) { counts.suppressed += 1; return { ok: true, skipped: 'same_region', region: r }; }
    const t = now();
    if (t - lastCursorAt < cursorGateMs) { counts.suppressed += 1; return { ok: true, skipped: 'gate', region: r }; }
    lastCursorAt = t;
    return { ok: true, region: r, sent: send('pointer_region', `他的鼠标移到了画面${r}。`) };
  }

  /* 键盘。一串只报一次：第一次到时发，后面 gate 内的都算同一串。
   * 注意这里没有"他停了"的判断——那需要等一个静默窗口，就是定时器。 */
  function key(k = '') {
    if (!on.typing) { counts.skipped += 1; return { ok: true, skipped: 'disabled' }; }
    const t = now();
    if (t - lastTypingAt < typingGateMs) { counts.suppressed += 1; return { ok: true, skipped: 'gate' }; }
    lastTypingAt = t;
    /* 不写按了什么键：那会把输入内容（密码、正在打的字）带进记忆。
     * "他在敲键盘"是事实；"他敲了 a"是内容。我们要前者。 */
    const detail = '他在键盘上敲了一下。';
    return { ok: true, sent: send('typing', detail) };
  }

  /* 屏幕。默认关；同意之后也只在你主动递一帧时才看。
   * summary 是已经看懂了的一句话（谁看的不重要），这里不接收图片、不接收坐标。 */
  function screen({ summary = '', at = null } = {}) {
    if (!on.screen) { counts.skipped += 1; return { ok: false, reason: 'disabled' }; }
    if (!screenConsent) { counts.skipped += 1; return { ok: false, reason: 'no_consent' }; }
    const text = String(summary || '').trim().slice(0, 300);
    if (!text) return { ok: false, reason: 'empty' };
    return { ok: true, sent: send('screen', `他让你看了一眼屏幕：${text}`), at };
  }

  function consent(v = true) {
    screenConsent = Boolean(v);
    /* 同意 = 同时打开这条通道；收回同意只收回许可，不擅自把通道关掉。
     * 两件事分开，用户下次再同意时不用重新 enable。 */
    if (screenConsent) on.screen = true;
    log.push({ at: now(), type: 'consent', detail: screenConsent ? 'on' : 'off' });
    return screenConsent;
  }

  return {
    cursor, key, screen, consent, enable,
    region: () => lastRegion,
    enabled: () => ({ ...on }),
    stats: () => ({ ...counts, enabled: { ...on }, consent: screenConsent }),
    log: () => log.slice(),
  };
}
