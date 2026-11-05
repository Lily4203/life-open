/* 显示后端端口：她的身体是「可换的」，说话的那个不是。
 * ------------------------------------------------------------
 * 为什么要有这一层：
 *   现在 66 是 three + VRM，67 是 Live2D，两套各写各的。
 *   换一个不是我们自己调的模型，动作就错位；想接 MMD / Spine / 立绘，
 *   得再抄一遍渲染代码。**大脑不该知道下面是哪一种格式。**
 *
 * 这一层只做三件事：
 *   ① 声明能力（caps）—— 后端能做什么，明说；不说的就是不能，不许假装能。
 *   ② 转发调用 —— 大脑说"高兴""坐下""看这边"，这里翻给当前后端。
 *   ③ 缺能力就降级，不报错、不崩、不装成功。
 *
 * 这一层**没有**什么：
 *   不知道怎么加载模型、不碰骨骼名、不碰 canvas、不发请求、不记状态。
 *
 * 一条硬规矩：**降级不许静默。**
 *   play('sit') 在只有立绘的后端上，会降级成一次表情变化，并用 via 说明它走了哪条路。
 *   调用方据此决定要不要在状态栏写一句"她只能换个表情"。
 *   静默降级的后果是——她以为坐下了，人在原地（2026-11-05 真跑抓到过同样的病）。
 */

/* 八种能力。少一种不是残缺，是这类后端本来就没有：
 *   say      有话说出来（字幕 / 声音 / 气泡），任何后端都必须有，没有就不算一个后端
 *   lipsync  口型跟着声音动（要音频）
 *   emotion  表情（VRM 的 expression / Live2D 的 expression / 立绘的差分）
 *   motion   肢体动作（坐下、挥手、躺下）。立绘没有。
 *   lookAt   头/眼跟着某个方向转（不一定有骨骼，2D 可以是层位移）
 *   blink    自己眨眼（VRM/Live2D 自带；MMD 靠 morph；立绘靠差分）
 *   outfit   换装
 *   gesture  说话时的小手势（强调 / 指 / 摆手 / 耸肩）。比 motion 轻，是"陪衬"不是"动作"
 */
export const CAPS = ['say', 'lipsync', 'emotion', 'motion', 'lookAt', 'blink', 'outfit', 'gesture'];

/* 七种能力里只有五种是要大脑去调的，另外两种是**声明**：
 *   lipsync / blink 是后端自己在内部做的（跟着音频动嘴、按节奏眨眼），
 *   大脑不需要、也不应该去指挥它们——指挥了反而会跟渲染循环抢。
 * 所以注册时只校验 CALLABLE 那几个有没有实现。
 *
 * gesture 在 CALLABLE 里（声明了就得给实现，不许"声明了其实没有"），
 * 但**它不该由大脑点名**：大脑只说"我现在有点得意"（mood），或者"看向台灯"，
 * 怎么把手抬起来是身体的事。真让它点名"做个 shrug"，等于让写剧本的人替演员决定每块肌肉
 * ——那是木偶，不是人。所以动作表里没有 gesture。 */
export const CALLABLE = ['say', 'motion', 'emotion', 'lookAt', 'outfit', 'gesture'];

/* 后端能演的手势。这一张表是**身体的词汇**，不是大脑的选项：
 * 提示词里不会出现它们，只有表现层（页面）在挑。
 * 名字用动词原形，和 motion 一样；不在表里的一律 unsupported，不猜。 */
export const GESTURES = ['emphasize', 'point', 'wave', 'shrug', 'nod', 'tilt', 'shift', 'tidy', 'glance'];

/* 情绪 → 手势的默认搭配。她换了个表情，身体顺手带一下；不做也不影响表情本身。
 * 只放"这个情绪确实会带这个动作"的组合，凑不出来就不放（不硬凑）。 */
export const EMOTION_TO_GESTURE = {
  happy: 'nod', surprised: 'tilt', angry: 'shrug', sad: 'tilt', relaxed: 'shift',
};

/* 五种后端的"典型能力"。这不是我们的实现，是给接的人一张对照表：
 * 他要接自己的模型，照这张表声明 caps；表里没有的多声明也可以。 */
export const BACKEND_TABLE = {
  vrm:     ['say', 'lipsync', 'emotion', 'motion', 'lookAt', 'blink', 'outfit', 'gesture'],
  live2d:  ['say', 'lipsync', 'emotion', 'motion', 'lookAt', 'blink', 'outfit', 'gesture'],
  mmd:     ['say', 'emotion', 'motion', 'lookAt', 'blink', 'gesture'],
  spine:   ['say', 'emotion', 'motion', 'lookAt', 'gesture'],
  tachie:  ['say', 'emotion'],                       // 立绘：只会换表情和说话
};

/* 动作 → 表情。后端不会动的时候，用它把"坐下"降成一次能看见的反应。
 * 只放"动作能表达出情绪"的那几件；放不进去的就不降级（不硬凑）。 */
export const MOTION_TO_EMOTION = {
  sit: 'relaxed', lie: 'relaxed', stand: 'relaxed',
  greet: 'happy', wave: 'happy', nod: 'happy',
  surprise: 'surprised', flinch: 'surprised',
  angry: 'angry', refuse: 'angry',
  sad: 'sad', cry: 'sad',
};

/* 后端自己说"我不会这个"时，用这个抛：`throw unsupported('这个身体不会挥手')`。
 * 和真的崩（骨骼名找不到、空指针）要分开——前者是能力边界，后者是 bug，
 * 两个混成一个 reason，排错时永远分不清。 */
export function unsupported(message) {
  const e = new Error(message || '这个身体不会');
  e.code = 'unsupported';
  return e;
}

/* 后端抛上来的异常，一律变成回执。code==='unsupported' 是能力边界，其余是 bug。 */
function asFail(cap, via, e) {
  return {
    ok: false, cap, via, degraded: false,
    reason: e && e.code === 'unsupported' ? 'unsupported' : 'threw',
    message: String((e && e.message) || e),
  };
}

function normCaps(list) {
  const out = new Set();
  for (const c of (Array.isArray(list) ? list : [])) {
    if (!CAPS.includes(c)) throw new Error(`未知的能力名：${c}（只允许 ${CAPS.join('/')}）`);
    out.add(c);
  }
  return out;
}

export function createAvatar({ now = () => Date.now() } = {}) {
  const backends = new Map();
  let curName = null;

  /* 注册一个后端。caps 里没写的，调用时一律回 unsupported——**不许靠"试一下看它崩不崩"来发现**。 */
  function register(name, impl = {}) {
    if (!name) throw new Error('后端必须有名字');
    if (!impl || typeof impl !== 'object') throw new Error('后端必须是一个对象');
    const caps = normCaps(impl.caps);
    if (!caps.has('say')) throw new Error(`后端 ${name} 没有 say：话都说不出来，不算一个能用的身体`);
    for (const c of caps) {
      if (CALLABLE.includes(c) && c !== 'say' && typeof impl[c] !== 'function')
        throw new Error(`后端 ${name} 声明了 ${c}，却没给实现`);
    }
    backends.set(name, { name, caps, impl, at: now() });
    if (!curName) curName = name;
    return backends.get(name);
  }

  /* 切换后端。名字不存在是**配置错误**（会抛），不是运行时错误——
   * 和"这个后端不会做这个动作"（回 unsupported）是两回事。 */
  function use(name) {
    if (!backends.has(name)) throw new Error(`没有注册过后端：${name}（有：${[...backends.keys()].join('/') || '无'}）`);
    curName = name;
    return backends.get(name);
  }

  const cur = () => (curName ? backends.get(curName) : null);
  const caps = () => new Set(cur()?.caps || []);
  const can = c => caps().has(c);

  const miss = (cap, extra = {}) => ({
    ok: false, cap, via: null, degraded: false,
    reason: cur() ? 'unsupported' : 'no_backend',
    message: cur()
      ? `这个身体不会「${cap === 'motion' ? '做动作' : cap === 'emotion' ? '做表情' : cap === 'outfit' ? '换衣服' : cap === 'gesture' ? '做手势' : cap}」`
      : '还没有身体',
    ...extra,
  });

  /* 说话。任何后端都有，没有就不让注册。 */
  function say(text, opt = {}) {
    const b = cur();
    if (!b) return miss('say');
    try {
      const r = b.impl.say(String(text ?? ''), opt);
      return { ok: true, cap: 'say', via: b.name, degraded: false, value: r };
    } catch (e) { return asFail('say', b.name, e); }
  }

  /* 肢体动作。没有 motion 就退到 emotion；再没有就明确回失败，**不假装动过**。 */
  function play(motion, opt = {}) {
    const b = cur();
    if (!b) return miss('motion');
    if (b.caps.has('motion')) {
      try {
        return { ok: true, cap: 'motion', via: b.name, degraded: false, value: b.impl.motion(String(motion), opt) };
      } catch (e) { return asFail('motion', b.name, e); }
    }
    const emo = MOTION_TO_EMOTION[motion];
    if (emo && b.caps.has('emotion')) {
      const r = setEmotion(emo);
      if (r.ok) return { ok: true, cap: 'motion', via: 'emotion', degraded: true,
                         reason: 'no_motion', message: `这个身体不会做动作，只换了个表情（${emo}）`, value: r.value };
    }
    return miss('motion', { degraded: false });
  }

  function setEmotion(e, opt = {}) {
    const b = cur();
    if (!b) return miss('emotion');
    if (!b.caps.has('emotion')) return miss('emotion');
    try {
      return { ok: true, cap: 'emotion', via: b.name, degraded: false, value: b.impl.emotion(String(e), opt) };
    } catch (err) { return asFail('emotion', b.name, err); }
  }

  function lookAt(x, y, opt = {}) {
    const b = cur();
    if (!b) return miss('lookAt');
    if (!b.caps.has('lookAt')) return miss('lookAt');
    try {
      return { ok: true, cap: 'lookAt', via: b.name, degraded: false, value: b.impl.lookAt(x, y, opt) };
    } catch (err) { return asFail('lookAt', b.name, err); }
  }

  /* 口型：0~1 的张嘴幅度，每帧都可能来一次。
   * 它跟 emotion/outfit 不一样——那些是"做一件事"，这是"持续一个状态"。
   * 所以：后端没有这个能力时**不报错、不降级、不记 calls**，就是没反应。
   * 每一帧都回一句 no_backend 会把日志冲成垃圾，也会让"她哑了"看起来像故障。 */
  function lipsync(level, opt = {}) {
    const b = cur();
    if (!b || !b.caps.has('lipsync')) return { ok: false, cap: 'lipsync', via: b ? b.name : null, degraded: false, reason: 'unsupported', silent: true };
    try {
      const v = Math.max(0, Math.min(1, Number(level) || 0));
      return { ok: true, cap: 'lipsync', via: b.name, degraded: false, value: b.impl.lipsync(v, opt) };
    } catch (e) { return asFail('lipsync', b.name, e); }
  }

  /* 手势：比 motion 轻的陪衬动作（强调、指、摆手、耸肩）。
   * 名字必须在 GESTURES 里，不在就 unsupported——**不猜**，也不做同义替换。
   * 没有这个能力的后端**不做替代**：用表情替代会变成"她一整晚都在换表情"，
   * 那是坏掉的木偶。表现层自己会退到"只说话"，这不叫静默降级——
   * 它拿到了 ok:false，知道该收手。 */
  function gesture(kind, opt = {}) {
    const b = cur();
    if (!b) return miss('gesture');
    if (!b.caps.has('gesture')) return miss('gesture');
    const k = String(kind || '');
    if (!GESTURES.includes(k)) {
      return { ok: false, cap: 'gesture', via: b.name, degraded: false, reason: 'unknown_gesture',
               message: `这具身体没有「${k}」这个手势（有：${GESTURES.join('/')}）` };
    }
    try {
      return { ok: true, cap: 'gesture', via: b.name, degraded: false, value: b.impl.gesture(k, opt) };
    } catch (e) { return asFail('gesture', b.name, e); }
  }

  function setOutfit(name, opt = {}) {
    const b = cur();
    if (!b) return miss('outfit');
    if (!b.caps.has('outfit')) return miss('outfit');
    try {
      return { ok: true, cap: 'outfit', via: b.name, degraded: false, value: b.impl.outfit(String(name), opt) };
    } catch (err) { return asFail('outfit', b.name, err); }
  }

  /* 给提示词用的一句话。她得知道自己这具身体能干什么，
   * 否则她会答"我给你跳个舞"，而这个模型连手臂都没有。 */
  function describe() {
    const b = cur();
    if (!b) return '你现在没有可见的身体，只能说话。';
    const has = c => b.caps.has(c);
    const can = [];
    if (has('motion')) can.push('做动作');
    if (has('emotion')) can.push('做表情');
    if (has('lookAt')) can.push('转头看');
    if (has('outfit')) can.push('换衣服');
    if (has('lipsync')) can.push('对口型');
    const no = [];
    if (!has('motion')) no.push('不能做动作');
    if (!has('emotion')) no.push('不能做表情');
    if (!has('outfit')) no.push('不能换衣服');
    if (!has('lookAt')) no.push('不能转头');
    return `你现在这具身体（${b.name}）：能${can.join('、') || '说话'}`
      + (no.length ? `；${no.join('、')}` : '') + '。';
  }

  function list() {
    return [...backends.values()].map(b => ({ name: b.name, caps: [...b.caps], current: b.name === curName }));
  }

  /* 调用计数：给状态栏看"她这具身体被用了几次、几次是够不着的"。
   * 单独拎出来而不是塞进每个函数，是为了让上面那几个函数保持"纯转发"——能一眼看完。 */
  const calls = { say: 0, play: 0, setEmotion: 0, lookAt: 0, setOutfit: 0, gesture: 0, degraded: 0, unsupported: 0 };

  const count = (k, r) => {
    if (r.degraded) calls.degraded += 1;
    if (!r.ok) calls.unsupported += 1;
    return r;
  };

  /* 快照：给状态栏和排错用。不动渲染。 */
  function stats() {
    return { current: curName, caps: [...caps()], backends: list(), calls: { ...calls } };
  }

  return {
    register, use, current: () => curName, list, caps, can, describe, stats,
    say: (t, o) => { calls.say += 1; return count('say', say(t, o)); },
    play: (m, o) => { calls.play += 1; return count('play', play(m, o)); },
    setEmotion: (e, o) => { calls.setEmotion += 1; return count('setEmotion', setEmotion(e, o)); },
    lookAt: (x, y, o) => { calls.lookAt += 1; return count('lookAt', lookAt(x, y, o)); },
    setOutfit: (n, o) => { calls.setOutfit += 1; return count('setOutfit', setOutfit(n, o)); },
    gesture: (k, o) => { calls.gesture += 1; return count('gesture', gesture(k, o)); },
    /* 口型不记 calls：它一秒来 60 次，记了就什么都看不见了。 */
    lipsync: (v, o) => lipsync(v, o),
  };
}
