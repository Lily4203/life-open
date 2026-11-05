/* 发起层：一个待执行意图队列（pending intents）
 * ------------------------------------------------------------
 * 先说清楚这个模块**没有**什么：
 *   没有定时器、没有轮询、没有"自主循环"、没有被比喻化的字段名。
 * 它有的是：
 *   一个数组 pendingIntents、四条例枚的触发原因、一个单槽的执行位、
 *   一个三态的结案函数、一份能落盘的快照。
 *
 * 为什么是"队列"而不是"循环"：
 *   循环的意思是"没人说话我也一直在想"。实时 3D 下它每分钟都在花钱，
 *   而且必然要写一堆"别死循环"的补丁。队列的意思是"有事才有一条记录，
 *   没记录就什么都不发生" —— 空闲成本是 0，且不会没事找事。
 *
 * 为什么不用定时器：
 *   定时派发的行为间隔是均匀的。真人不是按分钟开机的。均匀本身就是假的证据。
 *   raise() 只能由"状态真的变了"调用（同一件东西第二次被用、事件发生时没人在看…）。
 */

/* 五条原因码。原来只有四条，接上真的感知以后发现缺一条：
 * 那四条（repeat/unseen/no_response/unfinished）说的全是"这件事**为什么又提**一遍"，
 * 没有一条能说"这件事**第一次**出现"。第一次出现的记录根本没有码可用。
 * 这不是加需求，是原来那组码的来历决定的——它们是从失败模式里倒推出来的，不是从触发里。
 * 所以补 signal = 世界刚变成这样，她第一次注意到。 */
export const REASONS = ['signal', 'repeat', 'unseen', 'no_response', 'unfinished'];

/* 派发优先级：固定表，不靠调参。数字写在这儿是为了让"为什么先做这件事"可查，
 * 而不是散在条件分支里。 */
export const PRIORITY = { no_response: 3, unfinished: 2, repeat: 2, unseen: 1, signal: 1 };

export function createInitiative({ now = () => Date.now(), maxAttempts = 3, maxExecFail = 2, maxRecords = 32 } = {}) {
  let records = [];        // pendingIntents：唯一真源
  let inFlight = null;     // 单槽：同时只允许一条在跑
  let reflexLock = null;   // L0 反射占着身体时，这里不为 null
  let ignoredCount = 0;    // 发出去没人接的次数（给关系层，不参与这里的派发）
  let seq = 0;
  const history = [];

  const pending = () => records.filter(r => r.state === 'pending');
  const byTarget = target => records.find(r => r.target === target && r.state !== 'resolved') || null;

  /* ---- 生成一条记录。同 target 未结案的合并，不新开 ---- */
  /* occurrences / firstAt / lastAt 是**可选**的，由感知层给：
   * 它知道"这十分钟里同一件事第几次"，而这里只知道"这条记录还活着的时候第几次"。
   * 记录一结案就删了，所以不靠它补，灯一晚上能被说成七八次"第一次"。 */
  function raise({ reason, target, detail, candidates = [], priority, occurrences, firstAt, lastAt } = {}) {
    if (!REASONS.includes(reason)) throw new Error(`未知的触发原因：${reason}（只允许 ${REASONS.join('/')}）`);
    if (!target) throw new Error('raise 必须有 target：同一件事要能指回同一条记录');
    if (!detail) throw new Error('raise 必须有 detail：进提示词的是这句描述，不是一个分数');

    const n = Number(occurrences) > 0 ? Math.floor(Number(occurrences)) : null;
    const f = Number(firstAt) > 0 ? Number(firstAt) : null;
    const l = Number(lastAt) > 0 ? Number(lastAt) : null;

    const cur = byTarget(target);
    if (cur) {
      /* 两个来源取大的那个：感知层按窗口数，这里按"本条记录被提过几次"。
       * 取小的会把"十分钟第四次"说成"第二次"——那正是要修的那个病。 */
      cur.occurrences = Math.max(cur.occurrences + 1, n ?? 0);
      if (f) cur.createdAt = Math.min(cur.createdAt, f);
      cur.lastAt = l ?? now();
      cur.priority = Math.max(cur.priority, priority ?? PRIORITY[reason]);
      cur.candidates = [...new Set([...cur.candidates, ...candidates])].slice(0, 6);
      history.push({ at: now(), op: 'merge', target, reason, occurrences: cur.occurrences });
      return cur;
    }

    const r = {
      id: `p${++seq}`, reason, target, detail,
      candidates: candidates.slice(0, 6),
      priority: priority ?? PRIORITY[reason],
      attempts: 0, occurrences: n ?? 1,
      state: 'pending', dropReason: null,
      createdAt: f ?? now(), lastAt: l ?? now(),
    };
    records.push(r);

    if (records.length > maxRecords) {
      // 超上限先丢"已经试过、还没结果"的最旧一条：那不是忘了，是不再提了
      const victim = records.filter(x => x.state === 'pending' && x.attempts > 0)
                            .sort((a, b) => a.lastAt - b.lastAt)[0]
                 || records.slice().sort((a, b) => a.lastAt - b.lastAt)[0];
      records = records.filter(x => x !== victim);
      history.push({ at: now(), op: 'evict', target: victim.target, why: 'overflow' });
    }
    history.push({ at: now(), op: 'raise', target, reason, priority: r.priority });
    return r;
  }

  /* ---- 派发：一次只给一步，只给候选，不替大脑选 ---- */
  function dispatch({ userPresent = false, busy = false } = {}) {
    if (reflexLock) return null;      // L0 正占着身体
    if (busy) return null;            // 手上还有动作没做完
    if (inFlight) return null;        // 一条还没结案，不许开第二条

    const list = pending();
    if (!list.length) return null;

    const r = list.slice().sort((a, b) => (b.priority - a.priority) || (a.lastAt - b.lastAt))[0];
    r.attempts += 1;
    r.lastAt = now();
    r.state = 'pending';

    // 第一次派发，或没人在场：只给低代价动作（走过去、看向、坐下），不给"扑上去说话"
    const probe = r.attempts === 1 || !userPresent;

    const intent = {
      id: r.id,
      reason: r.reason,
      detail: r.detail,
      candidates: r.candidates.slice(),
      probe,
      step: 1,
      attempt: r.attempts,
      /* 同一件事被提过几次、最早和上一次各在什么时候。
       * 不把这两个数字递给她，她就只看得到一句"顶灯刚被关掉"——
       * 第四次和第一次长得一模一样，于是一次次说同一句话（真跑时就是这样：
       * 灯一开一关她说一句，说的还都是同一句）。次数是事实，不是判决：
       * 要不要为"又是这盏灯"再开口，仍然她自己定。 */
      occurrences: r.occurrences,
      firstAt: r.createdAt,
      lastAt: r.lastAt,
    };
    inFlight = intent;
    history.push({ at: now(), op: 'dispatch', target: r.target, reason: r.reason, probe, attempt: r.attempts });
    return intent;
  }

  /* ---- 结案：三种结果，各自有明确后果 ---- */
  function resolve(id, { outcome = 'acknowledged', note = null } = {}) {
    if (!['acknowledged', 'ignored', 'failed'].includes(outcome))
      throw new Error(`未知的结案结果：${outcome}`);

    const r = records.find(x => x.id === id) || null;
    const out = { id, outcome, target: r?.target ?? null, dropped: false, ignored: 0 };

    if (r) {
      if (outcome === 'acknowledged') {
        r.state = 'resolved';
        records = records.filter(x => x !== r);
      } else if (outcome === 'ignored') {
        if (r.attempts >= maxAttempts) {          // 试满次数还没人接：不再提
          r.state = 'dropped'; r.dropReason = 'gave_up';
          ignoredCount += 1; out.dropped = true; out.ignored = 1;
        }
      } else {                                    // failed：执行侧没做成
        if (r.attempts >= maxExecFail) { r.state = 'dropped'; r.dropReason = 'exec_failed'; out.dropped = true; }
      }
    }
    if (note) history.push({ at: now(), op: 'resolve', target: out.target, outcome, note });
    if (inFlight && inFlight.id === id) inFlight = null;
    return out;
  }

  /* 反馈来晚了：人过一会儿才回她。照样结案，但不算一次"没人接"。 */
  function lateFeedback(target) {
    const r = byTarget(target);
    if (!r) return { target, closed: false };
    records = records.filter(x => x !== r);
    return { target, closed: true };
  }

  /* ---- L0 反射：占住身体，L2 让路。返回 release() ---- */
  function lockReflex(kind = 'reflex') {
    reflexLock = kind;
    if (inFlight) inFlight.aborted = true;   // 半截意图作废，但不结案（它还没发生）
    return function release() { reflexLock = null; };
  }

  /* ---- 快照：队列要跨重启，路上那条不存 ---- */
  function serialize() {
    return {
      v: 2, at: now(),
      records: records.map(r => ({ ...r })),
      inFlight: null,                 // 没落地的意图不重放
      ignoredCount, seq,
    };
  }
  function restore(data) {
    if (!data || data.v !== 2) return false;
    records = (data.records || []).map(r => ({ ...r }));
    seq = data.seq || records.length;
    ignoredCount = data.ignoredCount || 0;
    inFlight = null; reflexLock = null;
    return true;
  }

  return {
    raise, dispatch, resolve, lateFeedback, lockReflex,
    list: () => pending().map(r => ({
      id: r.id, reason: r.reason, target: r.target, detail: r.detail,
      priority: r.priority, attempts: r.attempts, occurrences: r.occurrences,
    })),
    outstanding: () => pending().length,       // 未结案的条数（不是分数）
    isBusy: () => Boolean(reflexLock || inFlight),
    serialize, restore, history: () => history.slice(),
    records: () => records.map(r => ({ ...r })),
    get inFlight() { return inFlight; },
    get lock() { return reflexLock; },
    get ignoredCount() { return ignoredCount; },
  };
}
