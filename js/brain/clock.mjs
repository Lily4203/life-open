/* 时钟端口：什么时候算"一个时刻"
 * ============================================================
 * 这是**接口**，不是"自主已经做出来了"。
 *
 * 起因两句用户原话（2026-11-05）：
 *   ① "这个动力来源是什么？谁来写？如果是我们做的算法驱动大模型去做，那就没意义"
 *   ② "让模型自己会动这个部分要是做不出来可以先往后放，留下的做一个和别的一样
 *       所有人都可以替换的接口就好了"
 *
 * ① 作废了 drives.mjs：渴/累/闷四个数随时间涨，越线投一条"你有点渴了"。
 *   每个数字都是我们写的——渴得多快、做完一件事松多少、多久算闷。
 *   那不是她的欲望，是我们的欲望借她的嘴说出来。
 *
 * ② 是这一份：既然"一个人待着也会动"这件事我们还没证明，就不要装作做出来了。
 *   把它收成一个端口，和身体端口（avatar 五扇门）、换装（wardrobe）、
 *   游戏（game-bridge）、世界内容（world-content）一样：
 *   **留位置、给默认、谁都能换。**
 *
 * ------------------------------------------------------------
 * 一个钟只回答一件事：**现在要不要给一个时刻。**
 *
 *   它可以决定"什么时候问一句"（节奏）；
 *   它不能决定"她此刻是什么感觉"（主张）；
 *   它一个字都不许往提示词里塞。
 *
 * 框架自己管住三件事，换钟也换不掉（这是底线，不是策略）：
 *   1. 有事优先：世界真变了（pending）→ 先处理事实；她自己写下还没做的（ownPlan）→ 递给她自己的话
 *   2. 不打断对话：他刚说完话的 afterHumanMs 里，不许塞一个自说自话的时刻
 *   3. 一拍不叠：上一次没跑完，这一拍直接跳过，不排队、不补发
 *
 * 钟只管第 4 件：以上都不成立的时候，隔多久算"过了一段"。
 *
 * ------------------------------------------------------------
 * 内置三个钟（都在这张表里，想加自己的用 registerClock）：
 *
 *   beat    默认。安静地过一段就给一个空时刻（idleMs，默认 12 分钟）。
 *   quiet   永不主动。她只在有事、有人说话的时候动。想省钱的、想先看别的用这个。
 *   manual  只由外面调（按键 / 脚本 / 别的程序）。给"我自己决定她什么时候醒"的人。
 *
 * 页面怎么换：`?clock=quiet`。代码怎么加：registerClock({...})，见文件末尾。
 */

/** 一拍多久看一次（只读内存里的几个数，不调模型，很便宜）。 */
export const TICK_MS = 60e3;
/** 空时刻的默认间隔。 */
export const IDLE_MS = 12 * 60e3;
/** 他刚说完话的这段里不要插空时刻——那是打断，不是陪。 */
export const AFTER_HUMAN_MS = 120e3;

/* ---------------- 内置的三个钟 ---------------- */

const beatClock = ({ idleMs = IDLE_MS } = {}) => ({
  id: 'beat',
  zh: '过一段给一个时刻',
  caps: ['timing'],
  describe: () => `一个人待着的时候，大约每 ${Math.round(idleMs / 60e3)} 分钟给自己一个时刻（不替她想任何事）。`,
  decide: ctx => ctx.sinceIdleMs >= idleMs,
});

const quietClock = () => ({
  id: 'quiet',
  zh: '永不主动',
  caps: [],
  describe: () => '只在有事、有人说话的时候动；没人碰的时候不自己醒。',
  decide: () => false,
});

const manualClock = () => ({
  id: 'manual',
  zh: '只由外面叫',
  caps: ['external'],
  describe: () => '不会自己醒；要她动，得有人按键、脚本或别的程序来叫。',
  decide: ctx => ctx.force === true,
});

export const BUILTIN_CLOCKS = { beat: beatClock, quiet: quietClock, manual: manualClock };

/* ---------------- 注册门：谁都能加一个 ---------------- */

const registry = new Map(Object.entries(BUILTIN_CLOCKS));

/**
 * 加一个钟。要的东西很少：
 *   { id, zh, caps?, describe?(), decide(ctx) -> boolean }
 *
 * ctx 里有：{ at, sinceIdleMs, sinceHumanMs, pending, ownPlan, force }
 * 返回 true = 现在递一个时刻；返回别的 = 这一拍不动。
 *
 * **decide 里不许返回"她应该有什么感觉"**——它只回答要不要，没资格回答为什么。
 * 想在 decide 里写"她该渴了"，先回去读这个文件顶上那两句原话。
 */
export function registerClock(clock) {
  if (!clock || typeof clock.id !== 'string' || !clock.id) throw new Error('钟要有 id');
  if (typeof clock.decide !== 'function') throw new Error(`钟 ${clock.id} 要有 decide(ctx)`);
  if (registry.has(clock.id) && !BUILTIN_CLOCKS[clock.id]) {
    /* 允许覆盖，但要说一声：覆盖内置的无所谓，覆盖别人的是事故。 */
    console.warn(`[clock] 覆盖了已有的钟：${clock.id}`);
  }
  registry.set(clock.id, () => clock);
  return clock;
}

export const listClocks = () => [...registry.keys()];
export const describeClocks = () => [...registry.entries()].map(([id, f]) => {
  try { const c = f({}); return { id, zh: c.zh, caps: c.caps || [], text: c.describe ? c.describe() : '' }; }
  catch { return { id, zh: '', caps: [], text: '' }; }
});

/* ---------------- 时钟本体 ---------------- */

export function createClock({
  kind = 'beat',
  now = Date.now,
  wake,
  state,
  afterHumanMs = AFTER_HUMAN_MS,
  ...opts
} = {}) {
  if (typeof wake !== 'function') throw new Error('createClock 要一个 wake()');
  if (typeof state !== 'function') throw new Error('createClock 要一个 state()');
  const factory = registry.get(kind);
  if (!factory) throw new Error(`没有这个钟：${kind}（有：${listClocks().join('、')}）`);

  const clock = factory({ now, ...opts });
  let lastIdleAt = now();
  let running = false;
  let inFlight = false;
  let forceNext = false;
  const log = [];
  const stats = { ticks: 0, world: 0, ownPlan: 0, beat: 0, skipped: 0, failed: 0 };

  const skip = (why) => { stats.skipped += 1; log.push({ at: now(), op: 'skip', why }); return { fired: false, why }; };

  /** 一拍。返回只说明"这一刻递出去了没有"，不解释她该干什么。 */
  function step() {
    if (!running) return { fired: false, why: 'stopped' };
    if (inFlight) return skip('busy');
    stats.ticks += 1;

    const at = now();
    const st = state() || {};
    if (st.busy) return skip('busy');

    /* 1) 有事优先 —— 换钟也换不掉 */
    let reason = null;
    if (st.pending > 0) reason = 'world';
    else if (st.ownPlan > 0) reason = 'own_plan';
    /* 2) 不打断对话 */
    else if ((st.sinceHumanMs ?? Infinity) < afterHumanMs) return skip('talking');
    else {
      /* 3) 轮到钟：只问要不要 */
      let want = false;
      try {
        want = !!clock.decide({
          at,
          sinceIdleMs: at - lastIdleAt,
          sinceHumanMs: st.sinceHumanMs ?? Infinity,
          pending: st.pending || 0,
          ownPlan: st.ownPlan || 0,
          force: forceNext,
        });
      } catch (e) {
        /* 别人写的钟炸了，不能把整条命拖下水：记一笔，这一拍当没醒。 */
        stats.failed += 1;
        log.push({ at, op: 'failed', why: String(e.message || e) });
        forceNext = false;
        return { fired: false, why: 'failed' };
      }
      forceNext = false;
      if (!want) return skip('not_yet');
      reason = 'beat';
    }

    lastIdleAt = at;
    stats[reason === 'own_plan' ? 'ownPlan' : reason] += 1;
    log.push({ at, op: reason });
    inFlight = true;

    /* 只有一份钟：一拍没跑完绝不开下一拍；跑挂了也不补发（补发就是定时叫醒）。 */
    let p;
    try { p = wake({ reason, beat: reason === 'beat' }); }
    catch (e) {
      inFlight = false; stats.failed += 1;
      log.push({ at, op: 'failed', why: String(e.message || e) });
      return { fired: false, why: 'failed' };
    }
    Promise.resolve(p)
      .catch(e => { stats.failed += 1; log.push({ at: now(), op: 'failed', why: String(e.message || e) }); })
      .finally(() => { inFlight = false; });
    return { fired: true, why: reason };
  }

  function start() { running = true; lastIdleAt = now(); return true; }
  function stop() { running = false; return true; }
  /** 他说了话：把"空时刻"的窗口推到之后，别在对话中间插一句自言自语。 */
  function spoke() { lastIdleAt = now(); return lastIdleAt; }
  /** 外面叫一次（manual 钟用）。不改变"要不要"的规矩，只是递一次请求。 */
  function poke() { forceNext = true; return step(); }

  return {
    id: clock.id,
    step, start, stop, spoke, poke,
    running: () => running,
    lastIdleAt: () => lastIdleAt,
    stats: () => ({ ...stats }),
    log: () => log.slice(-40),
    config: () => ({ kind: clock.id, afterHumanMs, ...opts }),
    describe: () => (clock.describe ? clock.describe() : clock.zh || clock.id),
  };
}

/** 给页面用：一个真的 setInterval，外面包一层，方便停。 */
export function startClock(clock, { tickMs = TICK_MS } = {}) {
  clock.start();
  return setInterval(() => { clock.step(); }, tickMs);
}
