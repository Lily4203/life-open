/* 记忆与重启：让"重启之后还是原来那一个"变成一个可测的启动流程
 * ------------------------------------------------------------
 * 先说清楚一件技术上无法绕过的事：
 *   **模型没有内隐记忆。** 重启之后它什么都没留下，我们能给的只有"开机时读进去的东西"。
 *   所以"回忆起之前的事"在这里不是"想起来"，是"启动时按固定顺序重建一遍"。
 *
 * 这里有一处 2026-11-05 的返工，必须先说明白：
 *   原来开机时用 tokens() 打分，替她挑出"最相关的 3 条"塞进提示词。
 *   那是**外置算法在替她决定想起什么**——和她自己想起来是两件事，而且挑错了她无法察觉
 *   （提示词里只有我们挑的那几条，她不知道还有别的）。
 *   现在的做法改成两步，照 AIRI 的 memory 那套：
 *     ① 开机只注入**索引**（id + 一句话），体积小、全都在，不替她筛
 *     ② 要正文她自己 read 那些 id；要记、要改、要忘，也由她调
 *   recall() 仍然留着，但**不再进提示词**，只给调试和兼容用。
 *
 * 这个模块只做五件事：
 *   ① 记：事件流只增（append-only），每条能指回时间、地点、人
 *   ② 存：身份 / 世界快照 / 议程 / 关系 / 记忆条目，各自一份，互不覆盖
 *   ③ 取：read(ids) 按 id 取正文；recall() 只是备用的关键词兜底
 *   ④ 读：boot() 按固定顺序装成几块，交给上下文层，预算封顶
 *   ⑤ 搬：export() / import() 是纯文本，换机器、换框架都还是她
 *
 * 没有定时器、没有向量库依赖、没有 fs 依赖（存储接口注入，浏览器换 localStorage 即可）。
 */

const CJK = /[\u4e00-\u9fa5]/;

/* 中文切词只做两件事：按非文字切开，再给中文串补 2 字滑窗。
 * 为什么不上分词：记忆检索要的是"能对上"，不是"语法正确"；
 * 两字滑窗对"椅子/坐/窗边"这种短词已经够用，且不引入词典依赖。
 * 注意：这只服务 recall() 这个备用通道，正常路径不经过它。 */
export function tokens(s) {
  const out = new Set();
  const raw = String(s || '').toLowerCase();
  for (const part of raw.split(/[^\u4e00-\u9fa5a-z0-9]+/)) {
    if (!part) continue;
    out.add(part);
    if (CJK.test(part) && part.length > 2) {
      for (let i = 0; i + 2 <= part.length; i++) out.add(part.slice(i, i + 2));
    }
  }
  return out;
}

export function relative(deltaMs) {
  const s = Math.max(0, Math.round(deltaMs / 1000));
  if (s < 60) return '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h} 小时 ${rm} 分钟前` : `${h} 小时前`;
  const d = Math.floor(h / 24), rh = h % 24;
  if (d < 30) return rh ? `${d} 天 ${rh} 小时前` : `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

const pad = n => String(n).padStart(2, '0');
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const stamp = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/* 绝对时间必须有：她自己要知道"现在几点、周几"。
 * 不给的话，她说不出"天亮了""你今天怎么这么早"，而这两句正是"活着"的证据。
 * 相对时间也留着：跨天的时候，模型做日期减法是会算错的（"3 天前"对它比 11-02 好算）。 */
const stampLong = t => `现在是 ${stamp(t)}（周${WD[new Date(t).getDay()]}）`;

const DESC_MAX = 150, BODY_MAX = 2000, ENTRIES_MAX = 200, INDEX_MAX = 40;
/* 议程：一件事的文字上限、同时留几条。上限不是性能考虑，是**防她把它写成待办清单**：
 * 一个能装 100 条的清单，模型会开始往回填，然后这份文件就不再是"我想做什么"了。 */
const AGENDA_MAX = 12, AGENDA_TEXT_MAX = 60, AGENDA_NEXT_MAX = 40, AGENDA_ASKS_MAX = 3;

/* 记忆条目：一条只装一件事。
 * 为什么分成 desc + body 两层（照 AIRI）：索引要小到能每次开机都放进去，
 * 正文要大到值得写。合成一层的话，要么索引太大，要么正文太浅。 */
export function createMemory({ store, now = () => Date.now(), charId = 'fish', bootBudget = 1400 } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.append !== 'function')
    throw new Error('createMemory 需要一个 store：{read, write, append}');

  let identity = '', identityHash = '';
  let world = {}, agenda = [], relations = {};
  let events = [];              // 内存里只留最近一批，全量在磁盘
  let memories = [];            // 长期记忆条目（她自己写的）
  let tombs = [];               // 墓碑：忘了的 id 不许复活，也不许被当成新条目重写
  let mSeq = 0;
  let seq = 0;
  const loadedAt = now();

  /* ---- 稳定的短哈希：只为"身份有没有被改过"，不做密码用途 ---- */
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function load() {
    identity = store.read('identity.md') || '';
    identityHash = hash(identity);
    world = JSON.parse(store.read('world.json') || '{}');
    agenda = JSON.parse(store.read('agenda.json') || '[]');
    relations = JSON.parse(store.read('relations.json') || '{}');
    const mem = JSON.parse(store.read('memories.json') || '{"entries":[],"tombs":[]}');
    memories = Array.isArray(mem.entries) ? mem.entries : [];
    tombs = Array.isArray(mem.tombs) ? mem.tombs : [];
    mSeq = Number(mem.seq) || memories.reduce((m, e) => Math.max(m, Number(String(e.id).slice(1)) || 0), 0);
    const lines = (store.read('events.jsonl') || '').split('\n').filter(Boolean);
    events = [];
    for (const line of lines) { try { events.push(JSON.parse(line)); } catch { /* 坏行跳过，不整份报废 */ } }
    seq = events.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0);
    return { events: events.length, agenda: agenda.length, memories: memories.length, identityHash };
  }

  const saveMem = () => store.write('memories.json', JSON.stringify({ v: 1, seq: mSeq, entries: memories, tombs: tombs.slice(-100) }));

  /* ---- ① 记 ---- */
  /* raw：她说话时**模型输出的原文**（一个 JSON 对象），只增不常用。
   * 为什么要留：历史是最强的示范（见 jsonout-test I 组）。只留 say 的话，
   * 回放出来的历史永远是 {"say":"…"}，她会学会"只说话、不做动作"。
   * 留原文，历史里才有真实的动作，她才知道"该做的时候可以做"。
   * 它**不进提示词的索引和 recent**（那两处只看 text），只在回放历史时用。 */
  function record({ who = charId, kind = 'event', text, place = null, people = [], salience = 0.5, raw = null, source = null, where = null } = {}) {
    if (!text) throw new Error('record 需要 text');
    const at = now();
    const e = {
      id: `e${at.toString(36)}${(++seq).toString(36)}`,
      seq, at, who, kind,
      /* 这句是从哪儿来的：'voice'（麦克风）/ 'danmaku' / 'script' …
       * 只在有人给的时候写。为什么不给所有事件都补个 source:null——
       * 这一年的事件文件不该因为我们加了一个字段，就把每条旧记录的形状都改掉。
       *
       * 为什么值得单独记：语音是**会听错**的入口。她答得奇怪时，
       * 第一件事就是分清"他真这么说的"还是"麦克风听错了"；没有这个字段，
       * 这两件事在记忆里长得一模一样。 */
      ...(source ? { source: String(source).slice(0, 24) } : {}),
      /* where：这话从**哪个装置**来的（"手机上的 QQ" / "直播间" / "墙上"）。
       * 和 source 分开：source 是我们内部的分流标签（白名单里那几个词），
       * where 是她读到的那句人话。两件事混成一个字段，迟早要在一个地方写死另一个的取值。
       * 同样只在有人给的时候写——旧记录的形状不因为我们加字段就全改一遍。 */
      ...(where ? { where: String(where).slice(0, 24) } : {}),
      text,
      place, people,
      salience: Math.max(0, Math.min(1, salience)),
      told: false, recallCount: 0,
      ...(raw ? { raw: String(raw).slice(0, 600) } : {}),
    };
    events.push(e);
    store.append('events.jsonl', JSON.stringify(e) + '\n');   // 落盘在返回之前，崩了也不丢
    if (events.length > 2000) events = events.slice(-2000);
    return e;
  }

  /* ---- ② 存 ---- */
  const setWorld = w => { world = { ...world, ...w, at: now() }; store.write('world.json', JSON.stringify(world)); return world; };
  const getWorld = () => ({ ...world });
  const setAgenda = list => { agenda = list.slice(0, 12); store.write('agenda.json', JSON.stringify(agenda)); return agenda; };
  let aSeq = 0;

  /* 议程：她自己写的那几条"我想做什么"。
   * 这一块原来是空的——只有测试在调 addAgenda，页面上没有任何地方会写。
   * 也就是说"自主"当时全靠我们手动 __RAISE 点火，那还是外面在替她决定何时动。
   * 现在它是一条正式的输出：她说 plan，我们落盘；她做完了说 done，我们划掉。
   *
   * 三条规矩，都是为了让这份东西不烂掉：
   *   ① 带 id = 改旧的（"那件事我改主意了"），不带 id 且文字一样 = 同一条，不写第二遍
   *   ② 只留 12 条，满了挤掉最老的；开机的提示词最多列 3 条
   *   ③ 完成了不删，改 status=done —— 她自己能看见"这事我干过"，不用重开一条 */
  const addAgenda = (item) => {
    const t = now();
    const text = String(item?.text ?? '').trim().slice(0, AGENDA_TEXT_MAX);
    if (!text) return null;
    // id 必须唯一：同一毫秒里加两条，用时间戳会互相覆盖（M8 就是这么抓到的）
    const same = agenda.find(x => x.status === 'open'
      && (item.id ? x.id === String(item.id) : x.text === text));
    const a = {
      id: same?.id || String(item.id || `a${t.toString(36)}${(++aSeq).toString(36)}`),
      text,
      next: String(item.next ?? same?.next ?? '').trim().slice(0, AGENDA_NEXT_MAX) || null,
      status: 'open',
      at: same?.at || t,          // 最初写下的时间：开机要说"这是多久以前想的事"
      touchedAt: t,               // 最近一次改的时间
      asks: same?.asks || 0,      // 被主动问过几次（nextAgenda 的上限靠它）
      lastAskedAt: same?.lastAskedAt || null,
    };
    agenda = [...agenda.filter(x => x.id !== a.id), a].slice(-AGENDA_MAX);
    store.write('agenda.json', JSON.stringify(agenda));
    return a;
  };

  /* 她说"这件事做完了"。不删，只划掉：删了她就不知道自己干过。
   * 找不到 id 要回人话，不能静默——静默等于"她以为划掉了，其实没有"。 */
  const closeAgenda = (id) => {
    const key = String(id ?? '').trim();
    const hit = agenda.find(x => x.id === key);
    if (!hit) return { ok: false, message: `手上没有 ${key || '（空 id）'} 这件事。` };
    if (hit.status === 'done') return { ok: true, entry: hit, already: true };
    const e = { ...hit, status: 'done', doneAt: now() };
    agenda = agenda.map(x => x.id === key ? e : x);
    store.write('agenda.json', JSON.stringify(agenda));
    return { ok: true, entry: e };
  };
  const openAgenda = () => agenda.filter(x => x.status === 'open');

  /* 下一次该问她哪一条。三条规矩：
   *   ① 问得少的优先 —— 不然最老那条永远占着位置，后面的永远轮不到
   *   ② 问过 3 次还不动的，就不再自动叫醒她。她可以不做的，但**不能不决定**：
   *      一直挂着只会变成每次没人说话都问她一遍，那不是自主，是被追债
   *   ③ 问的次数要落盘。重启后重新从 0 数，等于同一件事再被追三次
   * 这个上限是防呆，不是定时器：它算的是"这条我问过几次"，不是"过了几秒"。 */
  const nextAgenda = () => {
    const cands = agenda.filter(x => x.status === 'open' && (x.asks || 0) < AGENDA_ASKS_MAX);
    cands.sort((a, b) => (a.asks || 0) - (b.asks || 0) || (a.at || 0) - (b.at || 0));
    return cands[0] || null;
  };
  const noteAsked = (id) => {
    const hit = agenda.find(x => x.id === String(id ?? ''));
    if (!hit) return null;
    const e = { ...hit, asks: (hit.asks || 0) + 1, lastAskedAt: now() };
    agenda = agenda.map(x => x.id === e.id ? e : x);
    store.write('agenda.json', JSON.stringify(agenda));
    return e;
  };
  const setRelations = r => { relations = { ...relations, ...r }; store.write('relations.json', JSON.stringify(relations)); return relations; };

  /* ---- ③ 记忆条目：她自己写、自己读、自己忘 ---- */

  /* 索引就是"她知道自己知道什么"这件事本身。
   * 只给 id + 一句话，不给正文：正文全给会吃光预算，而不给 id 她就没法去读。 */
  function indexLines() {
    const rows = memories.slice().sort((a, b) => (b.updatedAt || b.at || 0) - (a.updatedAt || a.at || 0));
    const shown = rows.slice(0, INDEX_MAX);
    const text = shown.map(m => `- ${m.id}: ${m.desc}`).join('\n');
    return { text, shown: shown.length, hidden: Math.max(0, rows.length - shown.length) };
  }

  /* 读正文。allowMissing 里要带 id，因为"没读到"和"没这条"必须能分清楚——
   * 否则模型会把"我没查"说成"我不记得"。 */
  const readMem = ids => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
    const t = now();
    const got = [], missing = [];
    for (const id of list.slice(0, 8)) {
      const m = memories.find(x => x.id === id);
      if (!m) { missing.push(id); continue; }
      m.reads = (m.reads || 0) + 1;
      got.push({ id: m.id, desc: m.desc, body: m.body, at: m.at, when: relative(t - (m.at || t)) });
    }
    if (got.length) { saveMem(); store.append('reads.log', JSON.stringify({ at: t, ids: got.map(g => g.id) }) + '\n'); }
    return { got, missing };
  };

  /* 写：id 有就改，没有就新建。改的时候必须带 id（照 AIRI），
   * 不然同一件事会被写成两三条近似的，索引越来越长、越读越乱。 */
  function writeMem(input = {}) {
    const body = String(input.body ?? '').trim().slice(0, BODY_MAX);
    if (!body) return { ok: false, reason: 'empty_body', message: '没写正文，这条没存。' };

    const desc = String(input.desc ?? '').trim().slice(0, DESC_MAX)
      || body.split('\n')[0].slice(0, 60);
    const at = now();
    const id = input.id ? String(input.id) : null;

    if (id && tombs.some(t => t.id === id)) {
      return { ok: false, reason: 'forgotten', id, message: `${id} 已经被忘掉了，不能再用这个 id 写回来。要记就新开一条。` };
    }

    if (id) {
      const m = memories.find(x => x.id === id);
      if (m) {
        m.desc = desc; m.body = body; m.updatedAt = at;
        saveMem();
        return { ok: true, entry: { ...m }, message: `改好了 ${id}。` };
      }
    }

    if (memories.length >= ENTRIES_MAX) {
      // 超上限先丢"没人读过、又最旧"的那条：那是最不像她会在意的一条
      const victim = memories.filter(x => !x.reads).sort((a, b) => (a.updatedAt || a.at) - (b.updatedAt || b.at))[0]
                  || memories.slice().sort((a, b) => (a.updatedAt || a.at) - (b.updatedAt || b.at))[0];
      memories = memories.filter(x => x !== victim);
      tombs.push({ id: victim.id, desc: victim.desc, at, why: 'overflow' });
    }

    const nid = id && !tombs.some(t => t.id === id) ? id
      : (id || `m${++mSeq}`);
    const m = { id: nid, desc, body, at, updatedAt: at, reads: 0 };
    memories = [...memories, m];
    saveMem();
    return { ok: true, entry: { ...m }, message: `存下了 ${nid}。` };
  }

  /* 忘：不是删，是立墓碑。删掉的话，同一个 id 下次会被当成新条目写回来。 */
  function forgetMem(id) {
    const m = memories.find(x => x.id === String(id));
    if (!m) return { ok: false, reason: 'no_such_memory', message: `没有 ${id} 这条。` };
    memories = memories.filter(x => x !== m);
    tombs.push({ id: m.id, desc: m.desc, at: now() });
    saveMem();
    return { ok: true, message: `忘了 ${m.id}。` };
  }

  const memoriesList = () => memories.map(m => ({ ...m }));

  /* ---- ④ 取（备用通道，不进正常提示词） ---- */
  function score(e, cueTokens, t) {
    const et = tokens(`${e.text} ${e.place || ''} ${(e.people || []).join(' ')}`);
    let hits = 0; const why = [];
    for (const q of cueTokens) if (et.has(q)) { hits += 1; why.push(q); }
    if (!hits) return null;
    const days = Math.max(0, (t - e.at) / 86400000);
    const recency = 1 / (1 + days);                 // 越近越容易被想起，但不至于想不起旧的
    const s = hits * 2 + e.salience + recency - Math.min(0.6, e.recallCount * 0.2);
    return { score: +s.toFixed(3), why };
  }

  function recall(cue, { k = 3, excludeTold = false } = {}) {
    const t = now();
    const ct = tokens(cue);
    if (!ct.size) return [];
    const out = [];
    for (const e of events) {
      if (excludeTold && e.told) continue;
      const s = score(e, ct, t);
      if (s) out.push({ id: e.id, at: e.at, text: e.text, place: e.place, when: relative(t - e.at),
                        told: e.told, ...s });
    }
    out.sort((a, b) => b.score - a.score);
    const top = out.slice(0, k);
    for (const r of top) {                       // 记"被想起过"，用得多而没人接的会自动降权
      const e = events.find(x => x.id === r.id);
      if (e) { e.recallCount += 1; store.append('recalls.log', JSON.stringify({ at: t, id: e.id, cue }) + '\n'); }
    }
    return top;
  }

  const markTold = id => { const e = events.find(x => x.id === id); if (!e) return false; e.told = true; store.write('told.json', JSON.stringify(events.filter(x => x.told).map(x => x.id))); return true; };

  /* ---- ⑤ 搬：导出 / 导入 ---- */
  /* 纯文本，人能看懂、能手改、能被别人家的项目读。
   * 这是"记忆能带走"那一半：不登录、不加密、不依赖本框架的任何运行时。 */
  function exportMarkdown({ withEvents = false } = {}) {
    const out = [`# ${charId} · 记忆`, '', `导出于 ${stamp(now())}`, ''];
    if (identity.trim()) out.push('## 设定（原样，不要手改后忘了改 hash）', '', identity.trim(), '');
    if (memories.length) {
      out.push('## 她记得的事', '');
      for (const m of memories.slice().sort((a, b) => (a.at || 0) - (b.at || 0))) {
        out.push(`### ${m.id} · ${m.desc}`, '', `记下于 ${stamp(m.at)}`, '', m.body, '');
      }
    } else out.push('## 她记得的事', '', '（还没有）', '');
    const open = openAgenda();
    if (open.length) {
      out.push('## 手上还没做完的', '');
      for (const a of open) out.push(`- ${a.text}${a.next ? `（下一步：${a.next}）` : ''}`);
      out.push('');
    }
    if (withEvents) {
      out.push('## 事件流', '');
      for (const e of events) out.push(`- ${stamp(e.at)} ${e.who} ${e.text}`);
      out.push('');
    }
    return out.join('\n');
  }

  /* 导入接受三种：本模块导出的 JSON、我们的 markdown、以及最朴素的"一段一段"。
   * 为什么这么松：要"别人家也能导进来"，就不能要求对方先改成我们的形状。 */
  function importData(data, { replace = false } = {}) {
    const added = [];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (Array.isArray(data.memories)) {
        for (const m of data.memories) {
          const r = writeMem({ id: replace ? null : undefined, desc: m.desc || m.description, body: m.body || m.text });
          if (r.ok) added.push(r.entry.id);
        }
      }
      return { added, count: added.length };
    }
    const text = String(data ?? '');
    // markdown：### <id> · <desc> 之后到下一个 ### 之间是正文
    const sec = text.split(/^### /m).slice(1);
    for (const chunk of sec) {
      const nl = chunk.indexOf('\n');
      const head = nl === -1 ? chunk : chunk.slice(0, nl);
      let body = nl === -1 ? '' : chunk.slice(nl + 1);
      body = body.replace(/^记下于[^\n]*\n?/, '').trim();
      const [headId, ...rest] = head.split('·');
      const desc = rest.join('·').trim() || body.split('\n')[0]?.slice(0, 60) || '';
      if (!body) continue;
      const r = writeMem({ id: replace ? null : (headId.trim() || undefined), desc, body });
      if (r.ok) added.push(r.entry.id);
    }
    if (!sec.length) {           // 一行一条的朴素格式：每行当一条
      for (const line of text.split('\n')) {
        const s = line.replace(/^[-*]\s*/, '').trim();
        if (!s || s.startsWith('#')) continue;
        const r = writeMem({ desc: s.slice(0, DESC_MAX), body: s });
        if (r.ok) added.push(r.entry.id);
      }
    }
    return { added, count: added.length };
  }

  /* ---- ⑥ 读：开机顺序是硬的，不能今天这样明天那样 ---- */
  function boot({ cue = '', limit = bootBudget } = {}) {
    const t = now();
    const blocks = [];
    const push = (id, authority, order, text, weight = 1) => blocks.push({ id, authority, order, text, chars: text.length });

    // 1 身份：逐字，不许压缩。hash 不对要当场说"我被改过"，不能假装没事
    push('boot.identity', 'system', 1, identity.trim(), 99);
    if (world.identityHash && world.identityHash !== identityHash) {
      push('boot.identity_changed', 'system', 2,
        `（注：你的设定文件被改过，哈希 ${world.identityHash} → ${identityHash}。）`, 98);
    }

    // 2 现在：绝对时间 + 距上次多久。少任何一半都会说错话
    const since = world.at ? relative(t - world.at) : null;
    // 姿态可能来自别的端（房间写中文、旧数据写 stand），读的时候统一，别让她念出英文
    const POSE_ZH = { stand: '站着', sit: '坐着', lie: '躺着', walking: '走着' };
    const pose = world.pose ? (POSE_ZH[world.pose] || world.pose) : null;
    const wtext = [
      stampLong(t),
      pose ? `你现在${pose}` : null,
      since ? `上次你在这里是 ${since}（${stamp(world.at)}）` : null,
    ].filter(Boolean).join('；');
    if (wtext) push('boot.now', 'context', 10, wtext, 9);

    /* 3 议程：她自己写的"正在做/想做"，最多三条。
     * 必须带 id：她要划掉一条，只能靠 id 指认；只给文字，她会回 "done":["把花挪一下"] 然后划不掉。
     * 必须带"多久以前写的"：不然她分不清"这是刚才决定的"还是"三天前随口说的"。
     *
     * 还要分两堆：问过她几次都没动的（asks 满），不能跟"正在做"混在一起。
     * 混在一起的后果是真跑抓到的——她开机看到"手上还有两件事"，而那两件已经问满三次、
     * 永远不会再派发。她记着自己有活，却永远不做，也没人告诉她这两件已经凉了。 */
    const openAll = openAgenda();
    const live = openAll.filter(a => (a.asks || 0) < AGENDA_ASKS_MAX);
    const stale = openAll.filter(a => (a.asks || 0) >= AGENDA_ASKS_MAX);
    const open = live.slice(0, 3);
    if (open.length) {
      push('boot.agenda', 'context', 20,
        '你手上还没做完的（做完了把它的 id 填进 done）：\n'
        + open.map(a => `- ${a.id}：${a.text}`
            + (a.next ? `（下一步：${a.next}）` : '')
            + `（${relative(t - (a.at || t))}写下的）`).join('\n')
        + (live.length > 3 ? `\n（还有 ${live.length - 3} 条更早的没列出来）` : ''), 8);
    }
    if (stale.length) {
      push('boot.agenda_stale', 'context', 21,
        '你记过这几件，后来一直没动：\n'
        + stale.slice(0, 3).map(a => `- ${a.id}：${a.text}`).join('\n')
        + '\n想做就做；不想做就把 id 填进 done 划掉，别让它一直挂着。', 6);
    }
    if (!open.length && !stale.length) {
      /* 空议程要明说。缺了这一块，模型看到的是"没有这条信息"，而不是"我手上没事"——
       * 前者她会去猜，后者她才会想到"那我找点事做"。也给一个合法的"不知道做什么"。 */
      push('boot.agenda_none', 'context', 20,
        '你手上没有正在做的事。想做什么，自己记一条（plan），不必等人吩咐；没有想做的不记也行。', 5);
    }

    // 4 记忆索引：全都在，只给 id + 一句话。想看正文她自己去 read
    const idx = indexLines();
    if (idx.text) {
      push('boot.memindex', 'context', 25,
        '你记得的事（这是索引；要用到哪条，再去看正文）：\n' + idx.text
        + (idx.hidden ? `\n（还有 ${idx.hidden} 条更旧的没列出来）` : ''), 7);
    } else {
      push('boot.mem_none', 'context', 25,
        '你记得的事：还没有。被问起以前的事，就说记不清，不要补细节。', 6);
    }

    // 5 最近发生：只给三条，全给会把预算吃光。
    // 她自己的话**不算"发生的事"**：真跑时她连续两次说"已经在上头了"，第三次开机把这两句
    // 当既成事实读了回来，接着又说一遍。事实进"最近"，她的话进对话历史——两处不能混。
    /* 动作回执最多占一格，且必须是最新那条。
     * 一轮里连做三步就是三条回执（走过去 / 关灯 / 坐下），三条一起进这三格，
     * "他刚才说了什么"就被挤出去了——她说"我去关灯"，做完三步，下一轮只看见自己走过、关过、坐过。
     * 丢掉旧回执不丢信息：她站哪、坐着还是躺着，world 那一块每轮都在写。
     * 但最新那条必须留：半途的回执永远排最后（走一半就 break），
     * 而"你走到一半停下来了"正是最需要被读到的一条。 */
    const RECENT = 3, DID_IN_RECENT = 1;
    const pool = events.filter(e => e.kind !== 'said' || e.who === 'him');
    const picked = [];
    let dids = 0;
    for (let i = pool.length - 1; i >= 0 && picked.length < RECENT; i -= 1) {
      if (pool[i].kind === 'did') {
        if (dids >= DID_IN_RECENT) continue;   // 旧回执让位给他的话
        dids += 1;
      }
      picked.push(pool[i]);
    }
    const recent = picked.reverse();
    if (recent.length) push('boot.recent', 'context', 30,
      '刚刚发生的：\n' + recent.map(e => `- ${e.text}（${relative(t - e.at)}）`).join('\n'), 7);

    // 6 关系：一句话，不铺开
    if (relations.summary) push('boot.relations', 'context', 50, relations.summary, 5);

    // 预算：身份块永不丢，只压"眼前"这一段；超了整块丢，不截断
    const dropped = [];
    const sys = blocks.filter(b => b.authority === 'system').sort((a, b) => a.order - b.order);
    const ctx = blocks.filter(b => b.authority !== 'system').sort((a, b) => a.order - b.order);
    let total = sys.reduce((n, b) => n + b.chars, 0);
    const kept = [...sys];
    for (const b of ctx) {
      if (total + b.chars <= limit) { kept.push(b); total += b.chars; }
      else dropped.push({ id: b.id, chars: b.chars, whole: true });
    }
    return { blocks: kept.sort((a, b) => a.order - b.order), chars: total, dropped, at: t, identityHash,
             /* 姿势单独带出来一份：提示词末尾要再核对一次（LLM 更信末尾）。
              * 这是屋子才有的问题——没有身体的框架不需要"你到底坐着还是站着"。 */
             pose: pose || null };
  }

  return {
    load, record, boot, recall, tokens,
    setWorld, getWorld, setAgenda, addAgenda, closeAgenda, openAgenda, nextAgenda, noteAsked, setRelations,
    plan: addAgenda,                 // 语义别名：loop 里写 memory.plan(...) 比 addAgenda 更清楚是谁在写
    markTold,
    /* 记忆条目 */
    indexLines, readMem, writeMem, forgetMem, memories: memoriesList,
    tombstones: () => tombs.slice(),
    exportMarkdown, importData,
    events: () => events.slice(),
    agenda: () => agenda.slice(),
    relations: () => ({ ...relations }),
    /* 谁是她自己。loop 判断"这句是谁说的"要用它，不许在别处硬写 'fish'——
     * 换角色只改 charId 一个参数，否则最近的对话会全部变成"别人说的"。 */
    get charId() { return charId; },
    get identityHash() { return identityHash; },
    get loadedAt() { return loadedAt; },
    /* 身份变了要能查：改之前记一次，改之后对比 */
    stampIdentity() { world.identityHash = identityHash; store.write('world.json', JSON.stringify(world)); return identityHash; },
  };
}
