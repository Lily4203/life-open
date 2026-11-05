/* 主干：一句话进来，走完"记 → 装上下文 → 问模型 →（查记忆）→ 执行 → 回写"
 * ------------------------------------------------------------
 * 这个文件是之前缺的那条线。在它之前：
 *   memory / context / initiative 三个模块各自能过测试，但页面里只有 actions 被接着，
 *   于是"能想"和"能看"是两拨东西，中间没有一条路。
 *
 * 一次 turn 固定五步，顺序不能换：
 *   ① 先记他的话（落盘在调模型之前：模型挂了，这件事也已经发生过）
 *   ② boot() 装上下文（身份、现在、议程、记忆索引、最近、关系）
 *   ③ 调模型，拿到 {say, read, remember, forget, do}
 *   ③.5 她要看记忆正文 → 取出来，**再问一次**（只给一次机会，不递归）
 *   ④ 执行 do（几何全在屋子那侧，这里只递 id）
 *   ⑤ 回写她说的和做成的（做成与没成都要记，没成不许自己圆）
 *
 * wake() 是另一条路：没人说话时，只处理"手上那件事要不要动一下"。
 * 没有议题就直接返回、不调模型——所以一百次唤醒里绝大多数是 0 成本。
 *
 * 2026-11-05 补的两条（都是"他怎么把话递进来"的事，不是"她怎么想"的事）：
 *   hear()      话先落盘，哪怕她这轮还没跑完。她下一眼就能读到，这就是"听见"。
 *   interrupt() 只在"她正在想"的时候掐掉这一次请求；"她正在做"的时候不掐——
 *               要不要放下手上的事，是她的判断，不是这一层的。
 * 这一层只负责"话到了没有""这一次要不要停"，一个字都不替她想。
 */

import { buildSystem, buildWakeSystem, buildReadSystem, parseOut } from './prompt.mjs';
import { createStyle, brief } from './style.mjs';
import { createExecutor } from './executor.mjs';

/* 他只写"几点"不够：跨天之后模型做日期减法是会错的。
 * 照 AIRI 的做法给用户消息加绝对戳（assistant 不加：加了它会把这个前缀学进自己的话里）。
 * 这里加在历史消息上，是为了让"上次说这话是昨天"这件事在上下文里能算出来。 */
const pad = n => String(n).padStart(2, '0');
const prefix = at => {
  if (!at) return '';
  const d = new Date(at);
  return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}] `;
};

export function createLoop({ memory, registry, chat, initiative = null, entities = null, windowFor = null,
                             avatar = null, executor = null, extra = null,
                             now = () => Date.now(), recentTurns = 6, maxQueued = 3 } = {}) {
  if (!memory) throw new Error('createLoop 需要 memory');
  if (typeof chat !== 'function') throw new Error('createLoop 需要 chat({system,messages})');

  /* 执行层：想和动的分界线。
   * 这个文件（大脑）只产出/传递意图，**一行都不直接调 registry.call**。
   * 不传就现造一个只连屋子的执行层，老调用方不用改；
   * 传了就复用（页面要拿同一个执行层说话/换装，避免两个出口抢身体）。 */
  const exec = executor || createExecutor({ registry, avatar, record: e => memory.record(e) });

  /* 这一轮有什么话是"场景"而不是"记忆"：游戏局面、穿在身上的东西。
   * 只进提示词，不进记忆——它不是发生过的事，是现在的样子。 */
  const extraText = ctx => {
    try {
      const v = typeof extra === 'function' ? extra(ctx) : extra;
      return v ? String(v) : '';
    } catch { return ''; }
  };

  const entList = () => {
    const v = typeof entities === 'function' ? entities() : entities;
    return Array.isArray(v) ? v : null;
  };

  /* 开窗：屋子告诉这次允许哪几件。
   * 不给就不开（等于全开），所以老调用方不用改。
   * 注意必须过滤"注册表里真有的"——屋子刚重建时 windowFor 可能念到还没注册的动作，
   * openWindow 遇到未知名字会抛，一抛整轮就没了。 */
  const pickWindow = ctx => {
    if (typeof windowFor !== 'function') return null;
    try {
      const r = windowFor(ctx);
      const list = Array.isArray(r) ? r : (r && Array.isArray(r.names) ? r.names : null);
      if (!list) return null;
      const names = [...new Set(list.filter(n => registry.has(n)))];
      if (!names.length) return null;
      return { names, note: (r && typeof r === 'object' && r.note) ? String(r.note) : '' };
    } catch {
      return null;
    }
  };

  let busy = false;
  let busySince = 0;
  /* 'idle' | 'thinking' | 'acting'
   * 拆这两种忙，是因为"能不能打断"和它们不是一回事：
   *   正在想：一次网络请求，掐掉不损失什么，可以打断。
   *   正在做：已经在屋子里走了，掐掉会把她卡在半路，不打断——先听见，做完再说。
   * 要不要放下手上的事仍然是她自己的判断（下一轮提示词里她会读到他说了什么）。 */
  let phase = 'idle';
  let ctrl = null;            // 当前这一次请求的 AbortController
  /* 正在做的时候，他要停的那一次。和 ctrl 分开是因为它们是两件事：
   *   ctrl     掐一条网络请求（结果直接不要了）
   *   actCtrl  叫停一步正在走的动作（结果要留下：停在哪儿是事实）
   * 合成一个的话，"停下脚步"会连这一轮的 say 一起作废，她刚说出口的话就白说了。 */
  let actCtrl = null;
  let epoch = 0;              // 代数：打断一次 +1，旧请求回来的结果按代数作废
  let active = null;          // 现在真正占着"忙"这个位子的那一轮（锁死了可以换人）
  let owed = false;           // 有人在她忙的时候说了话，这一轮完了要接一句
  let lastHeard = null;
  /* 上一次演出来的情绪。只在**变了**的时候才演一次：
   * 每轮都重设一遍，个别后端会闪一下；而且"没变"本身就是信息——她没换心情。 */
  let lastMood = null;
  /* 她这几轮听起来是什么样（style.mjs）。每轮开头看一眼、说完查一次。
   * 为什么放在 loop 而不是提示词里写死几条规矩：重复是**跨轮**的现象，
   * 只有 loop 这个位置同时看得见"最近几句"和"这一轮"。 */
  const style = createStyle({ memory });
  const queued = [];     // 她说的时候她正在想：先存着，等这轮完了接着跑（原来是直接丢掉）
  const stats = { turns: 0, wakes: 0, wakesWithModel: 0, actions: 0, actionFails: 0,
                  chars: 0, ms: 0, reads: 0, remembers: 0, forgets: 0, plans: 0, dones: 0,
                  queuedIn: 0, jsonRetries: 0, moods: 0,
                  /* 听见与打断分开数：
                   *   heard            话到了几次
                   *   heardWhileBusy   其中几次是她正忙的时候到的（这些才需要"接一句"）
                   *   interrupts       真正掐掉的请求（只有"正在想"才掐）
                   *   interrupted      被掐掉的那几轮
                   *   staleReleases    锁卡死后自愈的次数（不是功能，是兜底；大于 0 就要查）
                   * 分开数的理由和 quiet/noOutput 一样：混成一个数，出事时查不出是哪一种。 */
                  heard: 0, heardWhileBusy: 0, interrupts: 0, interrupted: 0, staleReleases: 0,
                  /* 正在做的时候被他叫停的次数（P2）。和 interrupts 分开数：
                   *   interrupts  掐掉的请求（连结果都不要了）
                   *   stops       叫停的脚步（结果留下：她停在哪儿，下一轮要读到）
                   * 混成一个数就分不清"她被打断在想的阶段"还是"走在半路"。 */
                  stops: 0,
                  /* 醒了但选择不动、也不说话。这个数要单独记：
                   * "她判断这事不值得动" 和 "她没答上来" 是两回事，
                   * 混成一个数，调提示词时就分不清是太吵还是坏了。
                   * 照 AIRI 的 builtIn_sparkNoResponse：不回应是一条正式的路，不是失败。 */
                  quiet: 0, noOutput: 0,
                  /* 对话里选择不接的次数（听见了、看过了，但没话要说）。
                   * 和 quiet 分开数：quiet 是"没人跟她说话时她自己没动"，
                   * quietChat 是"有人说了话她没接"——一个是独处，一个是社交，
                   * 混成一个数，就分不清"她今天很安静"是哪种安静。 */
                  quietChat: 0,
                  /* 结构化输出（P9）的三个诊断数。混成一个"失败"就查不出是哪一种：
                   *   jsonAsked   问了几次模型（分母）
                   *   blanks      拿回**空白**的次数。开了 json 之后最常见（上游把非 JSON 替换成空格），
                   *               但重发那次空白也算——它同样是"这一轮没拿到字"，必须当成失败，
                   *               不能当成"她今天不想说话"
                   *   truncated   被 max_tokens 截断的次数（JSON 截断必然是 bad_json）
                   * 合规率 = 1 - jsonRetries / jsonAsked，用这三个数就能直接算。 */
                  jsonAsked: 0, blanks: 0, truncated: 0 };

  /* 锁超过这么久就自动放开。它是**兜底**，不是超时重试：
   * 正常一轮 2–8 秒，90 秒还没回来，多半是请求挂在网络上、或者 finally 没走到。
   * 不放开的话，页面从此"她在想…"，重启之前再也不会动——真跑踩过一次。 */
  const STALE_MS = 90e3;

  function releaseStale() {
    if (!busy) return false;
    if (now() - busySince < STALE_MS) return false;
    const secs = Math.round((now() - busySince) / 1000);
    if (active) active.stale = true;      // 告诉它：你回来也不算数了
    busy = false; phase = 'idle'; ctrl = null; active = null;
    /* 卡死那一轮如果正卡在走路里，也要松开它的 signal，
     * 否则她站在半路，下一轮叫不动（state.walking 还是 true）。 */
    try { actCtrl?.abort?.(); } catch { /* 没有就算了 */ }
    actCtrl = null;
    try { registry.closeWindow(); } catch { /* 没开窗就算了 */ }
    stats.staleReleases += 1;
    try {
      memory.record({ who: 'system', kind: 'event',
        text: `上一轮卡了 ${secs} 秒没回来，我把它放开了。`, salience: 0.6 });
    } catch { /* 记忆写不进去也不该让自愈失败 */ }
    return true;
  }

  /* 占住"忙"。谁占着谁负责把它放开；卡死的那一轮被换掉之后，
   * 它回来时发现 active 不是自己，就不再动 busy（否则会把新的一轮放跑）。 */
  function begin() {
    const me = { epoch: ++epoch };
    active = me; busy = true; busySince = now(); phase = 'thinking';
    actCtrl = null;
    return me;
  }


  /* 回执的写法在 executor.mjs 里（"你坐下了" / "你想坐下，但没成：…"）。
   * 放在那边而不是这里，是因为它属于"做成了什么"，不属于"想了什么"。 */

  function recentMessages() {
    const said = memory.events().filter(e => e.kind === 'said');
    const tail = said.slice(-recentTurns * 2);
    return tail.map(e => {
      const mine = e.who === (memory.charId || 'fish');
      /* 不是她说的，就一律是"别人说的"：他、来访的人、群里的人。
       * 原来这里写的是 who==='him' ? user : assistant——第三个人一进来，
       * 别人的话就会变成"她自己说过的"，那不是格式问题，是她会认错人。 */
      const name = mine ? '' : (e.people && e.people[0])
        || (e.who === 'him' ? '' : String(e.who || '').replace(/^guest:/, ''));
      /* 只给他的那句加时间戳：给她自己的话加，她会学着在回答前面带一个方括号。 */
      /* 名字后面带一个 · 的，是这话从哪来（"手机上的 QQ"）。
       * 为什么不是单独一行：她读历史是一条一条读的，来源必须贴在那句话上；
       * 单独写"以下几条来自手机"会让她以为整段都来自一个地方。 */
      const tag = mine ? '' : (name ? `[${name}${e.where ? '·' + e.where : ''}] ` : '');
      /* 她说过的话要按**当时的输出格式**回放：一个 JSON 对象。
       * 为什么不能只放那句纯文本——历史是最强的示范，比 system 里写十遍都管用。
       * 实测（见 jsonout-test 的 I 组）：历史是纯文本时，开 JSON 模式 8 次全部被上游替换成空格；
       * 换成 JSON 对象之后 8 次全合规。差的就是这十来个字符。
       *
       * 2026-11-05 再补一条，是这一轮"动作永远是 0"的根因：
       * **回放的对象里必须有 do 这个键**，哪怕它是空的。
       * 四组对照（同一句"把灯关掉"，每组 5 次，真实动作表）：
       *   历史只有 {"say":…}      → 2/5 有动作
       *   历史 {"say":…,"do":[]}  → 5/5
       *   历史七个键全在          → 5/5
       *   没有历史                → 5/5
       * 也就是说她不是不肯动，是历史教她"我的回答里没有 do 这一项"。
       * 而且这会自我加固：她越不动，历史里的 do 就越少，下一次越不会动。
       * 所以这里补的形状只在**回放**时加，不改她真正输出过的原文（raw 照旧存）。 */
      const raw = mine ? replayOf(e.raw) : null;
      const content = mine
        ? (raw || JSON.stringify({ say: String(e.text ?? ''), do: [] }))
        : tag + prefix(e.at) + e.text;
      return { role: mine ? 'assistant' : 'user', content };
    });
  }

  /* 记忆三件事：读、记、忘。都不依赖动作窗口——那是屋子的事，这是她自己的事。 */
  /* 情绪落款：她这一轮的脸色。
   * 它**不是动作**：不进 do、不算一步、不进回执。她是说着话顺便带着这个表情，
   * 而动作是她决定去做一件事——把脸色记成一步，等于让她为心情多花一秒钟。
   * 只在变了的时候演；后端不会表情时 exec.express 会回失败，这里吞掉——
   * 没有表情不影响她说话，也不该让一整轮变成失败。 */
  function applyMood(parsed) {
    const m = parsed?.mood || null;
    if (!m || m === lastMood) return null;
    lastMood = m;
    stats.moods += 1;
    let r = null;
    try { r = exec.express(m); } catch { r = null; }
    return r;
  }

  function applyMemory(parsed) {
    const out = { read: null, remembered: [], forgot: [], notes: [] };
    for (const m of parsed.remember || []) {
      const r = memory.writeMem(m);
      if (r.ok) { out.remembered.push(r.entry); stats.remembers += 1; } else out.notes.push(r.message || '没存上');
      memory.record({ who: 'fish', kind: 'memory', text: r.ok ? `记住了：${r.entry.desc}` : `没记住：${r.message}`, salience: 0.6 });
    }
    for (const id of parsed.forget || []) {
      const r = memory.forgetMem(id);
      if (r.ok) { out.forgot.push(id); stats.forgets += 1; } else out.notes.push(r.message || `没有 ${id}`);
      memory.record({ who: 'fish', kind: 'memory', text: r.ok ? `忘掉了 ${id}` : `没能忘掉 ${id}：${r.message}`, salience: 0.6 });
    }
    return out;
  }

  /* 议程：她自己写的那几条"我想做什么"，以及划掉。
   * 为什么在动作之前：她说了"我记一下要做这个"，这句话本身就要算数，
   * 不能因为她后面那个动作失败、或者格式重发，连带把这句也丢了。
   * 为什么写进日志、划掉也写进日志：这是她"自主"的唯一证据链——
   * 哪天要回答"她真的自己做过决定吗"，翻 events.jsonl 就有。 */
  function applyAgenda(parsed) {
    const out = { planned: [], done: [], notes: [] };
    for (const p of parsed.plan || []) {
      const a = memory.plan(p);
      if (!a) { out.notes.push('那条想做的事没写成（没有内容）'); continue; }
      out.planned.push(a);
      stats.plans += 1;
      memory.record({ who: 'fish', kind: 'plan', text: `给自己记下要做的：${a.text}`, salience: 0.6 });
    }
    for (const id of parsed.done || []) {
      const r = memory.closeAgenda(id);
      if (!r.ok) { out.notes.push(r.message); continue; }
      out.done.push(id);
      if (!r.already) {
        stats.dones += 1;
        // 划掉才是"发生了一件事"，所以只有它进最近发生；新记的那条不进（议程块里已经有了）
        memory.record({ who: 'fish', kind: 'did', text: `这件事做完了：${r.entry.text}`, salience: 0.5 });
      }
    }
    return out;
  }

  /* 问模型。格式不对时**重发一次**，不是把散文当话说出去。
   * 为什么会有这一步：真跑的时候她回过"我去翻翻原文。"——话说得对，但那句话不是 JSON，
   * 我们收不到 read，她以为查了、其实没查。这种失败必须让她补一次，而不是悄悄降级。 */
  const RETRY_NOTE = '（上一条不是 JSON，我这边没法执行。只发一个 JSON 对象，话放进 say，别的字一个都不要写。）';
  /* JSON 模式下的"空白"要用另一句话，不能用上面那句：
   * DeepSeek 的 json_object 在"输出不能被识别成 JSON"时会**把正文整段替换成空格**，
   * 所以她看到的上一条真的是空的，跟她说"上一条不是 JSON"毫无意义。
   * 这句还顺手交代了"这次不用那个格式了"——重发那遍是关掉 json 的。 */
  const BLANK_NOTE = '（上一条是空的，我这边什么都没收到。这次不用那个格式了，正常说话，但只发一个 JSON 对象，话放进 say。）';
  const LONG_NOTE = '（上一条太长了，被截断了。压到两句以内再说一次，只发 JSON。）';

  /* 取正文：chat 可能返回 {content}，也可能直接返回字符串（测试里的假实现就是字符串）。 */
  const contentOf = out => (out && typeof out === 'object' && 'content' in out)
    ? String(out.content ?? '')
    : (typeof out === 'string' ? out : '');

  /* 她说话时，把她**当时真正输出的那段 JSON** 留下来（回放历史用）。
   * 只留合法且不太长的：历史里放一段坏 JSON 比不放更糟。
   * 留不下就返回 null，历史退回 {"say":"…","do":[]}——宁可示范得少，不可示范成假的。 */
  function rawFor(text) {
    const t = String(text ?? '').trim();
    if (!t || t.length > 600) return null;
    try {
      const j = JSON.parse(t);
      if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
      return t;
    } catch { return null; }
  }

  /* 回放形状：原文能解析就用原文，但**do 这个键一定要在**。
   * 只补键、不补内容——她那次真没动，就回放 {"do":[]}，不替她编一个动作出来。
   * 为什么单独一个函数：raw 存的是她当时的真实输出（诊断要用原样），
   * 而历史是给模型看的示范，两者要求不一样，不能混成一个。 */
  function replayOf(raw) {
    const t = rawFor(raw);
    if (!t) return null;
    try {
      const j = JSON.parse(t);
      if (!('do' in j)) j.do = [];
      return JSON.stringify(j);
    } catch { return null; }
  }

  /* onDelta 只搬字节：loop 不知道 say 在哪儿，也不知道哪句该先说。
   * 那是页面的事（js/brain/say-stream.mjs）。这里多懂一点，就多一处可能替她判断。
   *
   * live = { tok(): 拿一个这次的流量回调, hasSpoken(): 这一轮有没有话已经出去了 }
   * 每次新的响应都要拿一个新的 tok（页面靠它认得"这是另一段"，要把取字缓冲清空）。
   * 重发这条路**只有在一个字都没说出去的时候才接流**：
   * 已经说了半句再换一段接着说，两段会拼成一句她根本没说过的话。 */
  async function ask(system, messages, signal = null, live = null) {
    /* 这一轮只要已经有过话出口，后面**任何**一次响应都不再接流：
     * 不论是格式重发，还是"取正文再来一次"——再流一遍就会和前一句拼起来。 */
    const canStream = () => Boolean(live) && !live.hasSpoken();
    const first = canStream() ? live.tok() : null;
    stats.jsonAsked += 1;
    const out = await chat({ system, messages, signal, json: true, ...(first ? { onDelta: first } : {}) });
    const text1 = contentOf(out);
    const finish1 = (out && typeof out === 'object' && out.finish) || null;
    /* 空白单独记一笔：它不是"格式差一点"，是"上游把话吃了"。
     * 两者处理不一样——空白要换一种问法（关掉 json），格式差一点只要再要一次。 */
    const blank = !text1.trim();
    if (blank) stats.blanks += 1;
    if (finish1 === 'length') stats.truncated += 1;

    let parsed = parseOut(text1, { registry });
    if (!parsed.parseError) return { out, parsed, retried: false };

    stats.jsonRetries += 1;
    /* 重发一律**关掉 json 模式**，而且这条不能反过来：
     *   ① 开了 json 还失败，说明这条路在这个模型上不稳，硬要来第二次只会再拿一个空白；
     *   ② 关掉之后最坏只是退回"散文 + 重发"的老行为——保底不能比原来更差；
     *   ③ 重发要它给 JSON，靠的是那句话，不是参数。 */
    const note = blank ? BLANK_NOTE : (finish1 === 'length' ? LONG_NOTE : RETRY_NOTE);
    /* 真跑踩到的：模型先用散文回一句（"站着，没动。灯亮着…"），我们一个字都没说，
     * 然后走重发拿到 JSON。重发那遍如果不接流，流式的收益正好被最常见的这条路吃掉。
     * 所以这里按"还没说过话"放行，而不是一律不接。 */
    const again = canStream() ? live.tok() : null;
    const out2 = await chat({
      system, signal, json: false,
      ...(again ? { onDelta: again } : {}),
      messages: [
        ...messages,
        /* 空白时不要把那条空白再喂回去：那等于让她"接着一段空白往下写"。 */
        ...(blank ? [] : [{ role: 'assistant', content: String(parsed.say || '').slice(0, 500) }]),
        { role: 'user', content: note },
      ],
    });
    const text2 = contentOf(out2);
    if (!text2.trim()) stats.blanks += 1;      // 重发也空白同样是"没拿到字"，不数就查不出来
    const p2 = parseOut(text2, { registry });
    /* 还是不行就保留第一遍：宁可少动一下，不可因为格式崩掉。
     * 但第一遍是空白时，"保留"等于她这一轮一个字都不说——所以要留痕，
     * 不然事后只会看到"她那天话少"，查不出是格式问题。 */
    if (p2.parseError) {
      if (blank) {
        try {
          memory.record({ who: 'system', kind: 'event',
            text: '这一轮模型给了空白（开了 JSON 模式、它没按格式回），重发也没成。', salience: 0.6 });
        } catch { /* 记不上也不该让这一轮崩 */ }
      }
      return { out: out2, parsed, retried: true, stillBad: true, blank };
    }
    return { out: out2, parsed: p2, retried: true };
  }

  /* 执行只经过 exec。这个函数留着的唯一理由是统计和事件流的落点：
   * 动作是什么、怎么做、失败算谁的责任，全在 executor 里；这里只数数。 */
  async function runActions(doList, place, signal = null) {
    const results = await exec.run(doList, { place, signal });
    for (const r of results) {
      stats.actions += 1;
      /* 停下不是失败：不记 actionFails，也不记 lastFail。
       * 记进去的话，下一轮排错时会看到"她老做不到"——其实是我们让她停的。 */
      if (r.partial) continue;
      if (r.ok === false) {
        stats.actionFails += 1;
        stats.lastFail = { name: r.action || r.name, args: r.args || null, reason: r.reason || null,
                           by: r.by || null, message: r.message || null, at: now() };
      }
    }
    return results;
  }

  /* ---- 听见：话先落盘 ----
   * 为什么不能等这一轮跑完再记：一轮 2–8 秒，他在这 8 秒里说的话，原来的写法是
   * 排队到下一轮才 record —— 那时候"她刚说过什么"和"他刚说过什么"的顺序已经乱了，
   * 更糟的是他会觉得她没听见。
   *
   * 记的是**事实**（谁在什么时候说了什么），不是"要他回"这个决定：
   *   回不回、什么时候回，是她下一轮读到之后的判断；
   *   这里只保证"话在了"。忙的时候置一个 owed，让页面知道该接一句。
   *
   * from：'him'（他本人）、'guest:某某'（来访的人）、'script'（别的程序）。
   *   不是她的一律当"别人说的"，见 recentMessages()。
   */
  function hear({ text, from = 'him', name = null, place = null, source = null, where = null } = {}) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!t) return { ok: false, heard: false, reason: 'empty' };
    const e = memory.record({
      who: from, kind: 'said', text: t, place, source, where,
      people: name ? [String(name)] : [], salience: 0.6,
    });
    stats.heard += 1;
    lastHeard = { id: e.id, text: t, from, name, source, at: e.at };
    if (busy) {
      owed = true;
      stats.heardWhileBusy += 1;
      return { ok: true, heard: true, busy: true, id: e.id, phase };
    }
    return { ok: true, heard: true, busy: false, id: e.id };
  }

  /* ---- 打断：分"正在想"和"正在做"两种，处理方式不一样 ----
   *
   * 正在想：一次 HTTP 请求，掐掉不损失什么。epoch+1 让回来的结果作废。
   *
   * 正在做（P2）：**不吊销 epoch**，只叫停这一步。
   *   为什么不能吊销：她这一轮的话已经说出口了（流式边说边出），
   *   epoch 一变，assertMine() 就会把这一轮的 say 判成作废——
   *   结果是她嘴上说完了、记忆里却没有这句，下一轮她会以为自己没说话。
   *   所以这里只置一个停止信号给动作，这一轮照常收尾。
   *
   * 停不停是两层，别混：
   *   ① 身体停下 —— 反射，我们做（被人从背后喊，脚步会停，那不是决定）
   *   ② 还走不走 —— 她的决定，下一轮读回执时她自己说（议程**不划掉**）
   * 待办原文写的是"由她选择要不要中止"，在"走 1.5 秒就到位"的尺度上做不到：
   * 问她一次要 1–2 秒往返，腿早到了。尊重她不等于把决定卡在动作前面。
   *
   * 返回 interrupted 说明这一次真掐了请求；stopped 说明叫停了脚步；
   * 两个都 false 也不代表没听见——话已经落盘了。
   */
  function interrupt({ text, from = 'him', name = null, place = null, source = null, recorded = false } = {}) {
    releaseStale();
    /* recorded：这句话**已经记过了**（语音走的是 chat-in，它在进这里之前就落过盘）。
     * 不加这个标记就会记两遍——她会以为自己听见他说了两遍，而两遍之间相隔 0 毫秒。
     * 记过的只借它来"停下"，不再写第二份事实。 */
    const h = recorded ? { ok: true, heard: true, id: null } : hear({ text, from, name, place, source });
    if (!h.heard) return { ...h, interrupted: false };
    if (!busy) return { ...h, interrupted: false, reason: 'idle' };
    if (phase === 'acting') {
      /* 已经在走了：叫停脚步，不动 epoch。
       * actCtrl 可能为 null（这一轮没有动作、或者已经做完），那就只是"听见了"。 */
      if (actCtrl && !actCtrl.signal.aborted) {
        try { actCtrl.abort(); } catch { /* 老浏览器没有 abort 就靠 signal.aborted 那一层 */ }
        stats.stops += 1;
        return { ...h, interrupted: false, stopped: true, reason: 'acting' };
      }
      return { ...h, interrupted: false, reason: 'acting' };
    }
    if (phase !== 'thinking') return { ...h, interrupted: false, reason: phase };
    epoch += 1;                       // 旧请求回来的结果按代数作废
    try { ctrl?.abort?.(); } catch { /* 浏览器不支持就靠 epoch 那一层 */ }
    stats.interrupts += 1;
    return { ...h, interrupted: true, reason: 'thinking' };
  }

  /* 有人在她忙的时候说了话：这一轮完了要接一句。
   * 这里不做自动接——接的那一句也要经过 executor 说出来，
   * 而"说"的唯一出口在页面那边（同一个执行层）。这一层只回答"该不该接"。 */
  const owedNow = () => owed;
  function takeOwed() { const v = owed; owed = false; return v; }

  const isAbort = e => Boolean(e && (e.name === 'AbortError' || e.code === 'aborted' || e.code === 'interrupted'));


  /* 一轮对话。heard=true 表示"他的话已经记过了"（听见那条路已经落过盘）：
   * 这时不再重复 record，也不再把空字符串当成他的新话，只借用最近那句当 cue。 */
  async function turn({ text = '', world = null, place = null, heard = false, from = 'him', name = null, onDelta = null } = {}) {
    releaseStale();
    if (busy) {
      /* 原来是 return {reason:'busy'} —— 等于他连着说两句，第二句被吞了。
       * 现在存起来，这一轮完了接着跑；上限 3 句，再多就只留最后一句（人也是这样）。
       * 注意：走 hear() 进来的话已经落盘了，这里存的是"还要再跑一轮"，不是那句话。 */
      const item = { text, world, place, heard, from, name };
      if (queued.length >= maxQueued) queued.shift();
      queued.push(item);
      stats.queuedIn += 1;
      return { ok: true, queued: true, reason: 'busy' };
    }
    const me = begin();
    const myEpoch = me.epoch;         // 打断之后就认不出这一轮了，见 assertMine()
    const abortCtrl = typeof AbortController === 'function' ? new AbortController() : null;
    ctrl = abortCtrl;
    const assertMine = () => {
      if (myEpoch !== epoch || me.stale) {
        throw Object.assign(new Error('这一轮已经不算数了'), { code: me.stale ? 'stale' : 'interrupted' });
      }
    };
    const t0 = now();
    /* 流式的交接：每次新的响应给页面一个新号（它靠号认得"这是另一段了"），
     * 并且记住"这一轮到底有没有话已经出去了"——后面能不能再接流，全看这个。 */
    let attemptNo = 0;
    let spoke = false;
    const live = onDelta ? {
      tok: () => {
        const n = (attemptNo += 1);
        return (d, full) => {
          try {
            const r = onDelta(d, full, n);
            if (r && r.said) spoke = true;
          } catch { /* 页面那边坏了不该断这一轮 */ }
        };
      },
      hasSpoken: () => spoke,
    } : null;
    /* 窗口要在调模型之前开：提示词里列什么，取决于这次放开哪几件。
     * 关闭放在 finally，异常也不能把窗口留着——留着会让下一次对话被上一次的限制卡住。 */
    const win = pickWindow({ mode: 'turn' });
    /* 开窗要判存在：假的/精简的 registry（探针、测试）没有这个方法，
     * 一抛整轮就没了——她什么都没说，日志上却看不出为什么。 */
    if (win && typeof registry.openWindow === 'function') registry.openWindow(win);
    try {
      if (world) memory.setWorld(world);

      // ① 他的话先落盘（听见那条路已经记过就不再记第二遍）
      if (!heard) {
        memory.record({ who: from, kind: 'said', text: String(text || '').trim(), place,
          people: name ? [String(name)] : [], salience: 0.6 });
      }
      const cue = heard ? (lastHeard?.text || text) : text;

      // ② 装上下文
      const boot = memory.boot({ cue });
      /* 这一轮开头先看她最近几句：开头词扎堆、有句子撞了前面的，就把**事实**递给她
       * （原话 + 用了几次），不给判决、不改她的字。没毛病时这一块是空串，一个字都不占。
       * 为什么每轮都算：重复是跟着上下文变的，上一轮干净的窗口，这一轮可能已经三句"好，"了。 */
      style.begin();
      const styleBlock = brief(style.look());
      const system = buildSystem({ boot, registry, entities: entList(), avatar,
        extra: extraText({ mode: 'turn' }), styleText: styleBlock });

      // ③ 问模型
      /* 流式的字节原样交给页面。页面的活字层只认"整句"，半句不放——说了收不回。 */
      let { out, parsed, retried, stillBad } = await ask(system, recentMessages(), abortCtrl?.signal, live);
      assertMine();

      // ③.5 她要正文：取出来再问一次。只给一次，避免"读→再读→再读"的无底洞
      let readInfo = null;
      if (parsed.read.length) {
        const { got, missing } = memory.readMem(parsed.read);
        stats.reads += 1;
        readInfo = { asked: parsed.read, got: got.map(g => g.id), missing };
        if (got.length || missing.length) {
          const system2 = buildReadSystem({ boot, registry, entities: entList(), entries: got, missing, extra: extraText({ mode: 'turn' }) });
          /* 第二遍是"取正文再来一次"，等于换了个问题：
           * 走 ask 会拿一个新号，页面据此把取字缓冲清空（已经说出口的仍算说过）。 */
          const r2 = await ask(system2, recentMessages(), abortCtrl?.signal, live);
          assertMine();
          readInfo.askedAgain = r2.parsed.read;
          // 第二遍的话和动作优先；第一遍只给了 read 的时候，say 常常是空的
          parsed = {
            ...r2.parsed,
            say: r2.parsed.say || parsed.say,
            mood: r2.parsed.mood || parsed.mood,
            remember: [...parsed.remember, ...r2.parsed.remember],
            forget: [...parsed.forget, ...r2.parsed.forget],
          };
          out = r2.out;
        }
      }

      // ③.6 这句她刚说过：换一次说法（不是替她改，是告诉她事实再问一遍）
      /* 只在**这一轮一个字都还没说出去**的时候才重问。
       * 流式边说边出的时候话已经到他耳朵里了，再换一遍等于把两句拼成她没说过的一句。
       * 只换 say，不换 do/remember：重问只针对"这句刚说过"，
       * 顺手改了她的动作，就成了我们借查重改她的决定。 */
      let reprompted = null;
      if (parsed.say && !spoke) {
        const rep = style.check(parsed.say);
        if (rep.dup) {
          const note = style.repromptFor(parsed.say, rep.same);
          if (note) {
            const r3 = await ask(system, [
              ...recentMessages(),
              { role: 'assistant', content: JSON.stringify({ say: parsed.say, do: [] }) },
              { role: 'user', content: note },
            ], abortCtrl?.signal, null);
            assertMine();
            if (r3.parsed.say && !r3.parsed.parseError) {
              reprompted = { from: parsed.say, to: r3.parsed.say, same: rep.same, score: rep.score };
              parsed = { ...parsed, say: r3.parsed.say, mood: r3.parsed.mood || parsed.mood };
              out = r3.out;
            }
          }
        }
      }

      // ③.9 记忆的写和忘、议程的记和划（都在动作之前：她说出口的这两件事要算数）
      applyMood(parsed);
      const memOut = applyMemory(parsed);
      const agendaOut = applyAgenda(parsed);

      // ④ 执行（从这里开始是"动"：正在想的请求不再掐，但脚步可以被叫停）
      phase = 'acting';
      /* 每一步都带着这个信号走：他中途开口，动作在下一次心跳里停下。
       * 单独一个 controller，不共用 ctrl——共用了，"停下脚步"会顺手把这一轮作废掉。 */
      actCtrl = typeof AbortController === 'function' ? new AbortController() : null;
      const results = await runActions(parsed.do, place, actCtrl?.signal || null);
      actCtrl = null;
      /* 动作之间可能刚好被换掉（锁超时自愈）。做了的已经进记忆（执行层记的），
       * 没做的不能再补；这一轮的 say 不许再落地，否则她会说一句"我做完了"。
       * 注意：被叫停（stopped）**不走这条**——epoch 没变，她是同一轮，话要留下。 */
      assertMine();

      // ⑤ 回写
      /* 空话也是话：say 空、do 空 = 她听见了但没接（quietChat）。
       * 和 blanks 分开——blanks 是"没拿到字"（上游把话吃了，要重发），
       * 这里是"拿到了，就是空的"。混成一个数，会把她的沉默当成故障去修。 */
      const quiet = !parsed.say && !(parsed.do || []).length;
      if (quiet) stats.quietChat += 1;

      if (parsed.say) memory.record({ who: memory.charId || 'fish', kind: 'said', text: parsed.say, place, salience: 0.5,
        raw: parsed.parseError ? null : rawFor(contentOf(out)) });

      const ms = now() - t0;
      const stopped = results.some(r => r.partial);
      stats.turns += 1; stats.ms += ms; stats.chars += boot.chars;
      return {
        ok: true, say: parsed.say, mood: parsed.mood, do: parsed.do, results, memory: memOut, agenda: agendaOut, readInfo,
        /* reprompted：这一轮她本来要说的话和前面撞了，换了说法。
         * 带原话和撞的那句——事后查"她那天为什么换口风"，答案在这里，
         * 不然只会看到两句不相干的输出。null = 没换。 */
        reprompted,
        style: style.stats(),
        /* stopped：他被叫住了，有一步停在半路。页面用它决定那句提示怎么写，
         * 但**不影响 ok**——这一轮是成立的一轮，不是失败。 */
        stopped,
        /* quiet：这一轮她选择不接（say 空、do 空）。它不是失败，页面不该弹红字，
         * 但也不能装作一轮没发生——要让他知道"她听见了，没接"。 */
        quiet,
        window: win ? win.names : null,
        boot: { chars: boot.chars, blocks: boot.blocks.map(b => b.id), dropped: boot.dropped },
        raw: out?.content ?? out, ms, usage: out?.usage ?? null,
        retried: !!retried, stillBad: !!stillBad,
        parseError: parsed.parseError || null,
      };
    } catch (e) {
      /* 被打断不是"没跑成"：请求是我们要它停的，不该记成故障，也不该让她以为出事了。
       * 只留一件事实——话说到一半被打断了。*/
      if (e.code === 'stale') {
        return { ok: false, reason: 'stale', stale: true };
      }
      if (isAbort(e)) {
        stats.interrupted += 1;
        try {
          memory.record({ who: 'system', kind: 'event', text: '话说到一半，被他打断了。', salience: 0.4 });
        } catch { /* 记不上不影响 */ }
        return { ok: false, reason: 'interrupted', interrupted: true };
      }
      memory.record({ who: 'system', kind: 'error', text: '这一轮没跑成：' + String(e.message || e), salience: 0.8 });
      return { ok: false, reason: 'exception', error: String(e.message || e) };
    } finally {
      /* 只有"还占着位子的那一轮"才放开锁。
       * 被换掉的那一轮（卡死后自愈）回来晚了，不许把新的一轮放跑。 */
      if (active === me) {
        if (win) registry.closeWindow();
        busy = false; busySince = 0; phase = 'idle'; ctrl = null; active = null;
      }
      // 有人在她想的时候又说了话：接着跑，别丢
      const next = queued.shift();
      if (next) setTimeout(() => { turn(next).catch(e => console.warn('[loop] 排队那轮没跑成：', e.message)); }, 0);
    }
  }

  /* 没人说话时的一步。先看有没有手上的事，没有就不花钱。 */
  async function wake({ world = null, place = null, beat = false, onDelta = null } = {}) {
    releaseStale();
    if (busy) return { ok: false, reason: 'busy' };
    stats.wakes += 1;
    if (world) memory.setWorld(world);

    let item = null;
    if (initiative) item = initiative.dispatch({ userPresent: false, busy: false });
    /* 外界没事，才轮到她自己的议程。
     * 原来的写法是 if/else：只要页面传了 initiative（一定传），
     * 议程就永远轮不到——她写下来的事一次都不会被执行。真跑抓到的。 */
    if (!item) {
      const a = memory.nextAgenda();
      if (a) {
        memory.noteAsked(a.id);
        item = { id: null, agendaId: a.id, detail: a.text, next: a.next, candidates: null };
      } else if (beat) {
        /* 钟递过来的是一个**空时刻**：手上没有任何事。
         * 这里绝不能塞一句"你有点闷""你该做点什么"——那正是被作废的那套，
         * 我们的主张借她的嘴说出来。item 只说明"这是你一个人的一段时间"，
         * 不说明她该有什么感觉。她回 do:[] say:"" 就是合法的沉默（记 quiet）。 */
        item = { id: null, agendaId: null, detail: null, next: null, candidates: null, beat: true };
      } else {
        return { ok: true, acted: false, reason: 'nothing_pending', cost: 0 };
      }
    }

    /* 窗口：这件事带的候选优先（只考虑这几件），没有才问屋子。
     * 以前这里是 doList.filter(...)，越界的动作会被悄悄丢掉——她说了"坐下"，什么都没发生，
     * 也不回话。现在改成开窗，越界会走 registry.call 的 not_in_window，回一句人话给她。 */
    const cand = Array.isArray(item?.candidates) ? [...new Set(item.candidates.filter(n => registry.has(n)))] : [];
    const win = cand.length
      ? { names: cand, note: '这件事只考虑这几件' }
      : pickWindow({ mode: 'wake', item });
    /* 开窗要判存在：假的/精简的 registry（探针、测试）没有这个方法，
     * 一抛整轮就没了——她什么都没说，日志上却看不出为什么。 */
    if (win && typeof registry.openWindow === 'function') registry.openWindow(win);

    const me = begin();
    stats.wakesWithModel += 1;
    try {
      const boot = memory.boot({ cue: item.detail || item.target || '' });
      /* 醒来这一轮不查重、不重问：多一次请求换一句更活的话，在"没事发生"的时刻不划算。
       * 它重复的根不在这里——在"看不见自己刚才说过什么"，那一条在下面的 messages 处理。 */
      const wakeStyle = brief(style.look());
      const system = buildWakeSystem({ boot, registry, item, entities: entList(), avatar,
        extra: extraText({ mode: 'wake', item }), styleText: wakeStyle });
      /* 醒来这一轮以前是 messages:[]——她每次睁眼都是一张白纸。
       * 后果在真日志里抓到了：连续三次自主回合都在说同一盏灯
       * （13:37:15「顶灯怎么灭了」13:37:30「顶灯怎么开着」13:38:39「灯还没关吗」），
       * 因为 system 里只有"手上的事"，没有"我刚才说过什么"。
       * 而 style 那一块"没毛病就一个字不说"（见 style.brief），救不了这种情况。
       *
       * 给 4 条（两轮）：够她知道自己上一句是什么，又不至于把整段对话搬进
       * "没事发生的时刻"——那一轮本来就不该有那么多上下文。 */
      const out = await chat({ system, messages: recentMessages().slice(-4), json: true,
        ...(onDelta ? { onDelta: (d, full) => { try { onDelta(d, full, 1); } catch { /* 页面那边坏了不该断这一轮 */ } } } : {}) });
      /* 醒来这一轮不重发：她本来就是在"没人跟她说话"的时候自己动一下，
       * 格式没给对就当没输出（noOutput 会留痕），不必为此再花一次钱。
       * 但空白要单独数——它和"格式差一点"不是一回事。 */
      stats.jsonAsked += 1;
      const wakeText = contentOf(out);
      if (!wakeText.trim()) stats.blanks += 1;
      const parsed = parseOut(wakeText, { registry });

      applyMood(parsed);
      const memOut = applyMemory(parsed);
      const agendaOut = applyAgenda(parsed);
      phase = 'acting';
      const results = await runActions(parsed.do, place);

      /* 三种"没动静"要分开，别混成一个 0：
       *   quiet     —— 她看过了，判断这事不用动（合法的沉默，不算没做成）
       *   noOutput  —— 这一轮的输出没按格式来（重发一次还是不行），我们没收到 do/read
       *   acted     —— 说了话，或做了动作
       * noOutput 与 say 不互斥：她真说了句人话，那句照样给她说出去（比不吭声好），
       * 但我们没收到她的结构化意图——这件事必须留下痕迹，否则永远查不出是她不想动还是我们没收着。 */
      const noOutput = !!parsed.parseError;
      const quiet = !parsed.say && !results.length && !noOutput;
      if (quiet) stats.quiet += 1;
      if (noOutput) stats.noOutput += 1;
      const acted = !quiet;
      if (parsed.say) memory.record({ who: memory.charId || 'fish', kind: 'said', text: parsed.say, place, salience: 0.5,
        raw: parsed.parseError ? null : rawFor(contentOf(out)) });

      if (initiative && item.id) {
        initiative.resolve(item.id, {
          outcome: acted ? 'acknowledged' : 'ignored',
          note: quiet ? 'quiet' : (noOutput ? 'no_output' : null),
        });
      }

      stats.chars += boot.chars;                  // 唤醒的上下文也算进去，否则状态栏一直是"上下文 0 字"
      return { ok: true, acted, say: parsed.say, do: parsed.do, results, item, beat: !!item.beat, memory: memOut, agenda: agendaOut,
        window: win ? win.names : null,
        boot: { chars: boot.chars }, raw: out?.content ?? out };
    } catch (e) {
      if (initiative && item.id) initiative.resolve(item.id, { outcome: 'failed' });
      return { ok: false, reason: 'exception', error: String(e.message || e) };
    } finally {
      if (active === me) {
        if (win) registry.closeWindow();
        busy = false; busySince = 0; phase = 'idle'; active = null;
      }
    }
  }

  return {
    turn, wake, hear, interrupt,
    /* 有人在她忙的时候说了话：该不该接一句。页面拿这个决定"再来一轮"，
     * 这里不自己接——接的那句也得从同一个执行层说出来。 */
    owed: owedNow, takeOwed,
    get phase() { return phase; },
    get lastHeard() { return lastHeard ? { ...lastHeard } : null; },
    /* 页面拿同一个执行层说话/换表情，别自己再造一个出口。
     * 两个出口的后果：她说了一句，字幕和身体各说一次；换装时两边各删一半。 */
    executor: exec,
    /* 她现在的脸色。声音拿它决定"这句话用什么口气"——
     * 用**当前**这个，不是"这一轮解析出来的那个"：流式说话时第一句可能在
     * mood 写出来之前就已经出口了，那时翻 JSON 找 mood 是找不到的。
     * 而"她这会儿是高兴的"本来就是个持续状态，念这一句就该带这个口气。 */
    mood: () => lastMood,
    get busy() { return busy; },
    get queued() { return queued.length; },
    // 平均上下文：对话轮 + 叫醒过模型的那些次，一起算（只按 turns 算的话，光她自己动的时候永远是 0）
    stats: () => ({ ...stats, avgChars: stats.turns + stats.wakesWithModel
      ? Math.round(stats.chars / (stats.turns + stats.wakesWithModel)) : 0 }),
    bootPreview: (cue = '') => memory.boot({ cue }),
    systemPreview: (cue = '') => buildSystem({ boot: memory.boot({ cue }), registry, entities: entList(), avatar, extra: extraText({ mode: 'turn' }) }),
  };
}
