/* 外部消息入口（chat-in）：弹幕 / 群聊 / 语音转写 / 别的程序
 * ============================================================
 * 这一层解决的不是"她怎么回"，是"外面的话怎么进来"。
 *
 * 三件事，按重要性排：
 *   ① **收下**：一句话不管从哪来，都变成 memory 里的一条事实（走 loop.hear）。
 *      收下 ≠ 要回。她看得到，回不回是她下一轮的事。
 *   ② **合并**：同一个人把同一句刷十遍，是一件事，不是十件。
 *   ③ **什么时候让她看一眼**：这是**流量**问题，不是**内容**问题。
 *      所以这里只有三种时机策略，一个字都不掺"这条值不值得回"——
 *      那正是"外部算法替大模型思考"，被否掉过一次（drives.mjs），不能再犯。
 *
 * 三种时机策略（policy）：
 *   every   来一条给一次机会。一个人聊天用这个；人多的时候会把模型调用打满。
 *   window  攒 windowMs 再看一眼（默认）。直播/群聊用这个：既不漏，也不刷屏。
 *   never   只收不发。她只在自己醒来（有人叫、钟到点）时读到。
 *           给"我只想让她知道有这些事，但不想被这些事推着动"的人。
 *
 * ⚠ 不是"规则判断要不要回"：
 *   想按 @我 / 问句 / 礼物 过滤，**在 receive 外面做**（传不进来就不收），
 *   或者**在提示词里让她自己挑**。不要在收的时候替她分类——
 *   收了却不说，和丢了没区别，而且她永远查不出自己漏了什么。
 *
 * 适配器（adapter）长什么样：
 *   { id: 'bilibili', start(emit), stop() }
 *   emit({text, from, name, source}) —— 一行调回来就是一条消息。
 *   适配器自己处理协议、重连、鉴权；这一层不知道弹幕是什么。
 */

export const SOURCES = ['local', 'danmaku', 'group', 'voice', 'script', 'game'];
export const POLICIES = ['every', 'window', 'never'];

const MAX_TEXT = 500;

/** 一条外来消息的形状统一在这里做。缺名字就叫"有人"，不编一个名字出来。 */
export function normalizeMsg({ text, from = 'guest', name = '', source = 'script', where = '', at = null } = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!t) return null;
  const who = from === 'him' ? 'him'
    : (String(from).startsWith('guest:') ? String(from) : `guest:${from || 'someone'}`);
  const nm = String(name || '').trim().slice(0, 24) || (who === 'him' ? '' : String(from || '').replace(/^guest:/, '') || '有人');
  return {
    text: t,
    from: who,
    name: nm,
    source: SOURCES.includes(source) ? source : 'script',
    /* where：这话从哪个装置来的（"手机上的 QQ"）。它不进白名单、不做映射——
     * 适配器写什么就是什么。不认识的来源可以退回 script，但"从哪来"这件事
     * 没有可退的默认值：不知道就留空，她会读成"不知道在哪说的"，而不是我们替她编一个"手机"。 */
    where: String(where || '').trim().slice(0, 24) || null,
    at: Number(at) || null,
  };
}

export function createChatIn({ loop, now = () => Date.now(),
                               policy = 'every', windowMs = 1500,
                               mergeMs = 4000, maxPending = 20,
                               onBatch = null, onRepeat = null,
                               schedule = (fn, ms) => setTimeout(fn, ms),
                               cancel = (h) => clearTimeout(h) } = {}) {
  if (!loop || typeof loop.hear !== 'function')
    throw new Error('createChatIn 需要 loop.hear（话要落盘，落盘的地方只有它）');
  if (!POLICIES.includes(policy)) throw new Error(`没有这种时机策略：${policy}（只允许 ${POLICIES.join('/')}）`);

  let pending = [];              // 收下但还没"给过她一次机会"的
  let timer = null;
  let paused = false;
  let mergedSeen = new Map();    // key -> { at, count, said }
  const adapters = new Map();
  const lastBatch = [];
  const counters = { got: 0, merged: 0, dropped: 0, batches: 0, notes: 0, heard: 0, errors: 0, adapterErrors: 0 };
  const log = [];

  const note = (op, o = {}) => log.push({ at: now(), op, ...o });

  /* ---- ① 收 ---- */
  function receive(input = {}) {
    const m = normalizeMsg({ ...input, at: input.at ?? now() });
    if (!m) { note('empty'); return { ok: false, reason: 'empty' }; }
    counters.got += 1;

    /* 合并去重：同一个人、同一句话，mergeMs 之内只算一次。
     * 为什么不是"丢了"：次数要留在合并记录里，攒够 3 次会给他一句提示（onRepeat），
     * 因为"这句话被刷了 8 遍"本身也是一件值得知道的事。 */
    const key = `${m.from}|${m.text}`;
    const hit = mergedSeen.get(key);
    if (hit && now() - hit.at < mergeMs) {
      hit.count += 1; hit.at = now();
      counters.merged += 1;
      if (hit.count === 3 && typeof onRepeat === 'function') {
        try { onRepeat({ ...m, count: hit.count }); counters.notes += 1; } catch { counters.errors += 1; }
      }
      return { ok: true, merged: true, count: hit.count };
    }
    mergedSeen.set(key, { at: now(), count: 1 });
    // 合并表不能无限长：只留最近 200 个 key
    if (mergedSeen.size > 200) mergedSeen.delete(mergedSeen.keys().next().value);

    /* 落盘走 loop.hear：这一句从"外面"变成"她记忆里的一件事"。
     * 这里不看 busy、不看 she 在干嘛——听见就是听见。 */
    let h = null;
    try {
      /* where 只在有的时候带上：没有装置来源的话（他自己说的、别的脚本），
       * 传一个 where:null 会改变 hear 的形状——旧调用方和断言不该因为我们加字段就跟着改。 */
      h = loop.hear({ text: m.text, from: m.from, name: m.name, source: m.source,
                      ...(m.where ? { where: m.where } : {}) });
      if (h?.heard) counters.heard += 1;
    } catch (e) {
      counters.errors += 1;
      note('hear_failed', { error: String(e.message || e) });
      return { ok: false, reason: 'hear_failed', message: String(e.message || e) };
    }
    if (!h?.heard) return { ok: false, reason: h?.reason || 'not_heard' };

    pending.push(m);
    if (pending.length > maxPending) {
      const drop = pending.shift();
      counters.dropped += 1;
      note('drop', { from: drop.from, text: drop.text.slice(0, 40) });
    }
    note('recv', { from: m.from, source: m.source, text: m.text.slice(0, 40) });

    /* ② 什么时候让她看一眼 */
    if (paused || policy === 'never') return { ok: true, recorded: true, woke: false, pending: pending.length };
    if (policy === 'every') { fire(); return { ok: true, recorded: true, woke: true, pending: pending.length }; }
    if (timer) cancel(timer);
    timer = schedule(() => { timer = null; fire(); }, windowMs);
    return { ok: true, recorded: true, woke: false, pending: pending.length, waiting: windowMs };
  }

  /* ---- ② 交出去：一次只给一批，之后清空 ---- */
  function fire() {
    if (timer) { cancel(timer); timer = null; }
    if (!pending.length) return null;
    const batch = pending;
    pending = [];
    lastBatch.length = 0;
    lastBatch.push(...batch);
    counters.batches += 1;
    note('batch', { n: batch.length });
    if (typeof onBatch === 'function') {
      try {
        const r = onBatch(batch);
        /* onBatch 可能返回一轮 turn 的 promise。不 await：收消息的端口不该被"她想多久"卡住。 */
        if (r && typeof r.catch === 'function') r.catch(() => { counters.errors += 1; });
      } catch { counters.errors += 1; }
    }
    return batch;
  }

  /* 手动看一眼。policy=never / paused / "她正忙，等忙完再说" 都从这里接。 */
  const flush = () => fire();

  function pause() { paused = true; note('pause'); return true; }
  function resume() { paused = false; note('resume'); return true; }

  /* ---- ③ 来源：插拔，这一层不知道协议 ---- */
  function registerAdapter(id, adapter) {
    if (!id || typeof id !== 'string') throw new Error('适配器要有 id');
    if (!adapter || typeof adapter.start !== 'function') throw new Error(`适配器 ${id} 要有 start(emit)`);
    if (adapters.has(id)) throw new Error(`适配器重名：${id}`);
    adapters.set(id, { id, adapter, started: false, error: null });
    return { ok: true, id };
  }

  function startAll() {
    const out = [];
    for (const a of adapters.values()) {
      if (a.started) { out.push({ id: a.id, started: true, already: true }); continue; }
      try {
        a.adapter.start(msg => receive({ ...msg, source: msg.source || a.id }));
        a.started = true;
        out.push({ id: a.id, started: true });
      } catch (e) {
        /* 一个适配器起不来，不许把别的拖下水——和衣柜里坏一件不拖垮其余同一条规矩。 */
        a.error = String(e.message || e);
        counters.adapterErrors += 1;
        out.push({ id: a.id, started: false, error: a.error });
      }
    }
    note('start', { n: out.length });
    return out;
  }

  function stopAll() {
    for (const a of adapters.values()) {
      if (!a.started) continue;
      try { a.adapter.stop?.(); } catch { /* 停不下来也只能算了 */ }
      a.started = false;
    }
    if (timer) { cancel(timer); timer = null; }
    note('stop');
    return true;
  }

  function close() {
    stopAll();
    pending = [];
    return true;
  }

  function describe() {
    const p = { every: '来一条看一次', window: `攒 ${Math.round(windowMs)} 毫秒看一次`, never: '只收，等她自己醒来' }[policy];
    return `外面的话：${p}；待看 ${pending.length} 条；来源 ${[...adapters.keys()].join('/') || '无'}`
      + (paused ? '（暂停中）' : '');
  }

  return {
    receive, flush, pause, resume, close,
    registerAdapter, startAll, stopAll,
    describe,
    get policy() { return policy; },
    get pending() { return pending.length; },
    get paused() { return paused; },
    lastBatch: () => lastBatch.slice(),
    adapters: () => [...adapters.values()].map(a => ({ id: a.id, started: a.started, error: a.error })),
    stats: () => ({ ...counters, policy, pending: pending.length, paused }),
    log: () => log.slice(-40),
  };
}
