/* 心跳：只证明"这个页面还活着"，不驱动任何东西
 * ============================================================
 * 为什么它必须单独一个文件（而不是在 66 里顺手写个 setInterval）：
 *   这个项目有一条定死的规矩——**页面里不许有自己的定时器**。
 *   理由是"节奏是她的，不是页面的"：定时器一旦散在页面里，
 *   迟早会有人拿它做"每 30 秒动一下"。
 *
 *   心跳是唯一的例外，所以把它关在单独一个文件里，并且只做一件事：
 *   POST /api/alive。它不读记忆、不看世界、不叫醒谁、不改变任何状态。
 *
 * 它解决的是哪一个问题：页面卡死时自己救不了自己。
 *   服务端只记"我多久没听见这个页面了"，桌面壳看到超时才重载。
 *   所以这个文件**不许**判断"她是不是该动"——那是 clock 的事。
 *
 * 为什么不放在 clock 里：钟回答"要不要给她一个时刻"，是有主张的；
 *   心跳回答"我还活着"，没有主张。两件事混在一起，以后就分不清
 *   "她今天没动"是因为钟没走，还是因为页面死了。
 */

export const BEAT_MS = 30e3;

export function startHeartbeat({
  url = '/api/alive',
  ms = BEAT_MS,
  fetchImpl = (typeof fetch === 'function' ? (...a) => fetch(...a) : null),
  now = Date.now,
  schedule = (fn, t) => setInterval(fn, t),
  cancel = (h) => clearInterval(h),
} = {}) {
  if (!fetchImpl) throw new Error('startHeartbeat 需要 fetch');

  const stats = { beats: 0, fails: 0, lastAt: 0, lastError: null };
  let timer = null;

  async function once() {
    try {
      const r = await fetchImpl(url, { method: 'POST', cache: 'no-store' });
      if (!r || r.ok === false) throw new Error('HTTP ' + (r && r.status));
      stats.beats += 1;
      stats.lastAt = now();
      stats.lastError = null;
      return true;
    } catch (e) {
      /* 服务不在是常有的事（先开页面再起服务）。这里只记数，不重试、不弹窗：
       * 重试是浏览器/桌面壳的事，一个心跳不该有重试策略。 */
      stats.fails += 1;
      stats.lastError = String(e.message || e);
      return false;
    }
  }

  function start() {
    if (timer) return timer;
    once();                                   // 先打一次：否则开机后 30 秒内看起来像卡死
    timer = schedule(() => { once(); }, ms);
    return timer;
  }

  function stop() {
    if (timer) { cancel(timer); timer = null; }
    return true;
  }

  return { start, stop, once, stats: () => ({ ...stats, running: Boolean(timer), ms }) };
}
