/* 上下文分桶：replace 与 append 两条路**同时**算出来（拍定：两个都做，不预判优劣）
 * ------------------------------------------------------------
 * 之所以能"同时"，是因为**只存一份事件流，投影算两遍**：
 *   事件流：她做了什么、屋子发生了什么、谁说了什么 —— 只增，不改。
 *   投影 A（replace）：同一写者只留最后一条  → 高频状态不会把预算吃满。
 *   投影 B（append） ：同一写者按顺序全留    → 事件不会被后一条覆盖掉。
 *
 * 这两条不是"哪种更好"，是**同一条事件的两种读法**。所以不设验收标准去判，
 * 只要求：任何时刻都能把两份都打出来，字数、块数、被丢的块，一起记下来。
 *
 * 三条从 AIRI 抄来的硬规矩，落在这里：
 *   1) 写者分桶（writer 而不是一个大字符串）—— 谁的锅谁的碗。
 *   2) authority 三级：房间状态是 context，**不因为"是我们提供的"就获得指令权**。
 *   3) 超预算**整块丢**，永不截断（截断的那半句会被模型当成完整要求读）。
 */

export const MODES = ['replace', 'append'];
const AUTH_RANK = { system: 0, developer: 1, context: 2 };

const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);

export function createContext({ budget = 1400, residentBudget = 800, now = () => Date.now() } = {}) {
  const log = [];                    // 唯一真源：只增
  const writers = new Map();         // id → 描述（权威级、排序、固有模式）
  let seq = 0;

  function writer(id, opt = {}) {
    if (!id) throw new Error('writer 必须有 id');
    const w = writers.get(id) || {
      id, authority: opt.authority || 'context', order: opt.order ?? 50,
      mode: opt.mode || 'auto',     // auto=跟着投影走；'append'=永远累加（事件类）
      maxItems: opt.maxItems ?? 12, weight: opt.weight ?? 1,
      title: opt.title || id,
    };
    Object.assign(w, opt, { id });
    if (!(w.authority in AUTH_RANK)) throw new Error(`authority 只能是 ${Object.keys(AUTH_RANK).join('/')}`);
    writers.set(id, w);
    if (opt.title) w.title = opt.title;
    return handle(id);
  }

  /* ---- 入账：只有这一个入口，两个投影共用 ---- */
  function ingest(id, text, opt = {}) {
    const w = writers.get(id);
    if (!w) throw new Error(`未注册的写者：${id}（先 ctx.writer('${id}', {...})）`);
    const t = String(text ?? '').trim();
    if (!t) return null;

    const last = [...log].reverse().find(e => e.id === id);
    // 完全相同的连续状态不重复入账 —— 否则"每帧报一次位置"会被 append 放大成灾
    if (last && last.text === t && (opt.dedupe !== false)) {
      last.hits = (last.hits || 1) + 1;
      last.at = now();
      return last;
    }
    const e = { seq: ++seq, id, text: t, at: now(), hits: 1,
                kind: opt.kind || (w.mode === 'append' ? 'event' : 'state') };
    log.push(e);
    return e;
  }

  function handle(id) {
    const w = () => writers.get(id);
    return {
      id,
      set: (text, opt) => ingest(id, text, opt),
      push: (text, opt = {}) => ingest(id, text, { ...opt, kind: 'event' }),
      remove: () => { writers.delete(id); return { removed: id }; },
      setMode: m => { w().mode = m; return m; },
      maxItems: n => { w().maxItems = n; return n; },
      stats: (mode) => project(mode || 'replace').blocks.find(b => b.id === id) || { id, chars: 0, items: 0 },
    };
  }

  const removeWriter = id => writers.delete(id);

  /* ---- 投影：同一份 log，两种读法 ---- */
  function project(mode = 'replace') {
    if (!MODES.includes(mode)) throw new Error(`未知模式：${mode}`);
    const byW = new Map();
    for (const e of log) {
      const w = writers.get(e.id);
      if (!w) continue;                       // 写者被移除 → 它的历史不再进上下文
      if (!byW.has(e.id)) byW.set(e.id, []);
      byW.get(e.id).push(e);
    }
    const blocks = [];
    for (const [id, list] of byW) {
      const w = writers.get(id);
      // 固有 append 的写者，在两种投影里都累加（事件不可覆盖）
      const keep = (mode === 'replace' && w.mode !== 'append') ? list.slice(-1) : list;
      const cut = keep.length > w.maxItems ? keep.slice(-w.maxItems) : keep;
      const droppedItems = keep.length - cut.length;
      blocks.push({
        id, title: w.title, authority: w.authority, order: w.order, weight: w.weight,
        items: cut.map(e => e.text),
        text: cut.map(e => e.text).join('\n'),
        chars: cut.map(e => e.text).join('\n').length,
        itemCount: cut.length, droppedItems,
      });
    }
    blocks.sort((a, b) => (AUTH_RANK[a.authority] - AUTH_RANK[b.authority]) || (a.order - b.order));
    const total = blocks.reduce((n, b) => n + b.chars, 0);
    return { mode, blocks, chars: total, sourceEvents: log.length };
  }

  /* ---- 组装：整块丢，不截断；指令区与状态区物理分开 ---- */
  function assemble({ mode = 'replace', limit = budget } = {}) {
    const p = project(mode);
    // 指令区（system/developer）先保，状态区（context）后保 —— 反了就是"房间状态获得指令权"
    const ordered = [...p.blocks].sort((a, b) => {
      const r = AUTH_RANK[a.authority] - AUTH_RANK[b.authority];
      if (r) return r;
      return (b.weight - a.weight) || (a.order - b.order);
    });
    const kept = [], dropped = [];
    let n = 0;
    for (const b of ordered) {
      if (n + b.chars <= limit) { kept.push(b); n += b.chars; }
      else dropped.push({ id: b.id, authority: b.authority, why: 'budget', chars: b.chars, whole: true });
    }
    kept.sort((a, b) => (AUTH_RANK[a.authority] - AUTH_RANK[b.authority]) || (a.order - b.order));

    const instruction = kept.filter(b => b.authority !== 'context');
    const context = kept.filter(b => b.authority === 'context');
    return {
      mode, chars: n, budget: limit,
      instruction,
      context,
      blocks: kept,
      dropped,
      // 给调用方一个"能直接拼"的纯文本，但两段必须分开拼，别混着来
      text: [
        instruction.length ? `## 规则\n${instruction.map(b => b.text).join('\n')}` : '',
        context.length ? `## 眼前\n${context.map(b => b.text).join('\n')}` : '',
      ].filter(Boolean).join('\n\n'),
    };
  }

  /* ---- 对比：给 #3 用。不是验收，是留证据 ---- */
  function compare(opt = {}) {
    const a = assemble({ ...opt, mode: 'replace' });
    const b = assemble({ ...opt, mode: 'append' });
    return {
      at: now(),
      replace: { chars: a.chars, blocks: a.blocks.length, dropped: a.dropped },
      append: { chars: b.chars, blocks: b.blocks.length, dropped: b.dropped },
      deltaChars: b.chars - a.chars,
      onlyInAppend: b.blocks.filter(x => !a.blocks.find(y => y.id === x.id)).map(x => x.id),
      onlyInReplace: a.blocks.filter(x => !b.blocks.find(y => y.id === x.id)).map(x => x.id),
      // 同一块在两种读法下的字数差，一眼看出"谁被谁盖掉了"
      perWriter: [...new Set([...a.blocks, ...b.blocks].map(x => x.id))].map(id => ({
        id,
        r: (a.blocks.find(x => x.id === id) || { chars: 0 }).chars,
        a: (b.blocks.find(x => x.id === id) || { chars: 0 }).chars,
      })).sort((x, y) => (y.a - y.r) - (x.a - x.r)),
    };
  }

  const events = () => log.slice();
  const clear = () => { log.length = 0; seq = 0; };
  const dump = () => ({ budget, writers: [...writers.values()], log: events() });
  const load = d => {
    clear();
    budget = d.budget ?? budget;
    for (const w of d.writers || []) writers.set(w.id, w);
    for (const e of d.log || []) log.push(e);
    seq = log.reduce((m, e) => Math.max(m, e.seq), 0);
  };

  return { writer, removeWriter, ingest, project, assemble, compare, events, clear, dump, load,
           setBudget: n => (budget = n), get budget() { return budget; },
           residentBudget: () => residentBudget };
}
