/* 说话的样子：她这几轮听起来是什么样
 * ============================================================
 * 这个文件解决一个用提示词解决不掉的问题：**她会重复自己**。
 *
 * 证据（2026-11-05，303 句真台词）：
 *   · 19% 的句子以「好」开头，「好，」这一个开头占 18%；
 *   · 13% 是原话重复——「好，灯关了」说了 8 遍，「好关了，这下真黑了」5 遍；
 *   · 24% 的句子在最近三句里出现过同样的开头两个字。
 *
 * 为什么会这样，不是"人设没写好"：她**看得见**自己的历史（recentMessages 里有 assistant
 * 消息），但历史是隐式示范——模型对上下文的行为是"跟着像"，不是"注意避开"。
 * 你给她六句"好，X"，第七句最自然的续写就是"好，Y"。
 * 所以要在**同一个上下文里**把这件事挑明：你最近这么说话，具体是哪几个字，几遍。
 *
 * 三条边界，写死在代码里而不是靠自觉：
 *   ① **只陈述事实，不给判决**。"你最近四句里三句以「好，」开头"是事实；
 *      "你说话太单调了"是判决。判决会让她开始演，事实才会让她改。
 *   ② **不替她改字**。这里一个字都不重写她的话，只把统计和原话递过去。
 *   ③ **没毛病就一个字都不说**。多一块"注意风格"的常驻提示词，等于给她派了个活，
 *      她每轮都要为它花注意力——最后说话的还是那个被指标驱动的客服。
 *
 * 短句豁免：长度 < 4 的句子不参与"重复"判定。"在。"「好。」这种应答重复是正常的，
 * 真人被叫十次也应十次"在"。八股感来自**长句**一字不差地重来，不是短应答。
 */

/* 她在 say 里可以插的标记。这些字不是她说的话，统计和查重前要先摘掉。
 * 语法只有一种：中文方括号包一个词。
 * 为什么不用 <|...|>：那是 AIRI 的写法，她的模型是中文的，中文方括号更不容易写错、
 * 也不容易被 JSON 转义吃掉。
 *
 * 只有【停】一个。AIRI 那边有 ACT（表情）、DELAY（停顿）、CALL（调用），
 * 我们这边表情走 mood、调用走 do，所以真正缺的只有"话说一半停一下"。
 * 【笑】【叹气】看着更好，但 TTS 做不出来——edge 那个免费接口只认 rate/pitch/volume，
 * 没有音素级拼接。做一个念不出来的标记，等于让她在字幕上表演，比不做更假。 */
export const MARKS = ['停'];

/** 每个标记换成多长的静默（毫秒）。600 是"想了一下"的长度；
 *  比这短听不出来，比这长像断线。 */
export const MARK_PAUSE = { 停: 600 };

const MARK_RE = new RegExp(`【(${MARKS.join('|')})】`, 'g');

/** 摘掉标记。留着的唯一理由是要给播放端看，不是给统计看。 */
export const stripMarks = s => String(s ?? '').replace(MARK_RE, '');

/** 查重和统计用的归一化：去标记、去空白、去标点。
 *  只留字。标点差异（"好，灯关了" vs "好 灯关了。"）在听感上就是同一句。 */
export const bare = s => stripMarks(s).replace(/[\s。！？!?，、,；;：:…~～·—"'"'「」『』（）()【】\[\]]/g, '');

/** 二元组集合。用 Jaccard 而不是编辑距离：
 *  她的话都很短，"好灯关了"和"好灯关了啦"编辑距离是 1（很像），
 *  而"灯是灭的"和"灯关了"编辑距离也是 3（不像）——两者在听感上的差别，
 *  Jaccard 分得比我手调一个编辑距离阈值稳。 */
function bigrams(s) {
  const out = new Set();
  if (s.length === 1) { out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 0..1。完全一样是 1。 */
export function similarity(a, b) {
  const A = bigrams(bare(a));
  const B = bigrams(bare(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

/* 重复的判据。两层：
 *   完全一样（去标点后）——这是硬重复，没有讨论余地；
 *   相似度 >= 0.8 且长度接近——"好，灯关了"和"好，灯关掉了"在她嘴里是同一句。
 * 长度差太大时不判：一句话里换个关键信息（"灯关了"→"窗帘也拉了"）本来就该是新句子。 */
const DUP_AT = 0.8;
const DUP_MIN_CHARS = 4;

export function isRepeat(a, b) {
  const x = bare(a), y = bare(b);
  if (x.length < DUP_MIN_CHARS || y.length < DUP_MIN_CHARS) return false;
  if (x === y) return true;
  const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
  return ratio >= 0.65 && similarity(x, y) >= DUP_AT;
}

/** 开头那个"词"。
 *  不能简单取前两个字：中文里"好，灯关了"的前两个字是"好灯"，那是词和内容粘在一起，
 *  统计出来的东西既不是词也不是句，谁看都没意义。
 *  做法是取第一个标点前的短语，再压到两个字——"好"「有点」「三点」「顶灯」都出得来。
 *  （实测 303 句：按这个口径 Top1 是「好」18%，和肉眼一致；按前两字是「好灯」，全是噪音。） */
function openerOf(s) {
  const m = String(s ?? '').replace(MARK_RE, '').match(/^[^，。！？、,!?；;：:\n]*/);
  const first = (m ? m[0] : '').trim();
  if (!first) return '';
  return first.length > 2 ? first.slice(0, 2) : first;
}

/**
 * 从她最近说过的话里，把"听起来重复"的地方挑出来。
 *
 * 返回 {
 *   says:   原话（含标记，按时间正序）,
 *   opener: { word, count, ratio } | null   最集中的开头词
 *   repeats:[{ text, same, score }]         和更早的某句撞了的句子
 *   avgChars, n
 * }
 *
 * 只读，不改，不判断"该不该说"。调用方拿它去做提示词或者做重问的决定。
 */
export function audit(says, { openerMin = 3, openerRatio = 0.3 } = {}) {
  const list = (says || []).map(s => String(s ?? '').trim()).filter(Boolean);
  const n = list.length;
  const out = { says: list, n, opener: null, repeats: [], avgChars: 0 };

  if (!n) return out;
  out.avgChars = Math.round(list.reduce((a, s) => a + bare(s).length, 0) / n);

  /* 开头词。跳过纯标记开头（"【停】顶灯"的真实开头是"顶灯"）。 */
  const heads = new Map();
  for (const s of list) {
    const h = openerOf(s);
    if (!h) continue;
    heads.set(h, (heads.get(h) || 0) + 1);
  }
  /* 只报**重复得离谱**的那个：出现 >= 3 次，且占了窗口的三成以上。
   * 一次都不超就别报——"你有一句以'窗'开头"对她没有任何信息量。 */
  let top = null;
  for (const [word, count] of heads) {
    if (count < openerMin) continue;
    if (count / n < openerRatio) continue;
    if (!top || count > top.count) top = { word, count, ratio: count / n };
  }
  out.opener = top;

  /* 撞车：每句和它前面的比较。同一句撞多次只报一次——提示词只有两行的位置，
   * 报一次比报五次有用，报五次只是让她觉得自己很糟。 */
  const seen = new Map();      // bare → 原话。key 用来比，值用来给她看
  const reported = new Set();  // 已经报过的 key，同样的不再占一行
  for (const s of list) {
    const key = bare(s);
    /* 短应答不参与查重，也不进池子：池子里留一堆"在""好"，
     * 后面任何一句都会和它们撞上（isRepeat 会挡，但没必要每次都试一遍）。 */
    if (key.length < DUP_MIN_CHARS) continue;
    let hit = null;
    for (const k of seen.keys()) {
      if (isRepeat(k, key)) { hit = seen.get(k); break; }
    }
    if (hit) {
      if (!reported.has(key)) {
        out.repeats.push({ text: s, same: hit, score: similarity(s, hit) });
        reported.add(key);
      }
      continue;
    }
    seen.set(key, s);
  }
  return out;
}

/**
 * 把审计结果变成一小块提示词。
 *
 * 没有毛病就返回空串——调用方据此决定加不加这一段。
 * 有毛病时最多三行：她的原话、哪几个字用滥了、撞了哪句。
 *
 * 措辞上刻意避开两种说法：
 *   · "请不要重复"——这是规则，她会开始自我检查，越说越僵；
 *   · "你说话很单调"——这是判决，她会去演一个不单调的人。
 * 只给事实和一句"这一轮换一种开口"，剩下的她自己看着办。
 */
export function brief(a, { maxSays = 4 } = {}) {
  if (!a || !a.n) return '';
  /* 两样都没有就一个字不说。
   * 只把"最近几句"列出来（没有任何毛病）看着无害，其实是常驻噪音：
   * 她每轮都要读一遍自己说过什么，读多了就开始注意措辞——那正好是我们想避免的"演"。 */
  if (!a.opener && !a.repeats.length) return '';

  const lines = [];
  const tail = a.says.slice(-maxSays);
  /* 先给原话，再给统计：只给"「好」用了 3 次"她可能记不起是哪三句；
   * 只给原话又要她自己数——数数不是她的活。两样都给，一共两行。 */
  if (tail.length) lines.push('你最近说的几句：' + tail.map(s => `「${s}」`).join(' '));
  if (a.opener) {
    lines.push(`其中「${a.opener.word}」开头用了 ${a.opener.count} 次。这一轮换个开口——不是换个词，是别再从"${a.opener.word}"起头。`);
  }
  const rep = a.repeats.slice(-2);
  for (const r of rep) {
    /* 一字不差撞的，别写成「X」这句你前面已经说过（「X」）——同一个字符串出现两遍，
     * 读起来像系统出了错，而她要的只是"这句你说过了"这一个事实。 */
    const same = bare(r.text) === bare(r.same) ? '' : `（「${r.same}」）`;
    lines.push(`「${r.text}」这句你前面已经说过${same}了。`);
  }
  return ['## 你刚才说话的样子', ...lines].join('\n');
}

/**
 * 挂在 loop 上的那一层。
 *
 * 为什么要有状态而不是每轮现算：`said` 是她这一轮说的话，重问的时候要能
 * 把"刚才那句"递回去；而 memory 里的记录要等这一轮收尾才写（写早了，
 * 重问时她会把"还没定稿的那句"当成说过）。
 */
export function createStyle({ memory, charId = null, window = 10 } = {}) {
  const me = charId || memory?.charId || 'fish';
  let tries = 0;                       // 这一轮已经因为重复重问过几次
  const stats = { audits: 0, flagged: 0, reprompts: 0 };

  /** 她从记忆里说过的话，最近 window 句（不含这一轮还没落盘的那句）。 */
  function recent() {
    let evs = [];
    try { evs = memory?.events?.() || []; } catch { evs = []; }
    return evs
      .filter(e => e && e.kind === 'said' && e.who === me && String(e.text || '').trim())
      .slice(-window)
      .map(e => String(e.text).trim());
  }

  /** 这一轮的账清零。 */
  function begin() { tries = 0; }

  /** 这一轮开始时的审计（给提示词用）。 */
  function look() {
    const a = audit(recent());
    stats.audits += 1;
    if (a.opener || a.repeats.length) stats.flagged += 1;
    return a;
  }

  /**
   * 这句话是不是刚说过。
   * 返回 { dup:true, same:'原话', score } 或 { dup:false }
   *
   * 只看 memory 里已经落盘的（recent），不看这一轮——重问时如果把她上一版算进去，
   * 重问出来的永远"和上一版重复"，那不是查重，那是死循环。
   */
  function check(say) {
    const s = String(say ?? '').trim();
    if (!s) return { dup: false };
    const pool = recent();
    for (let i = pool.length - 1; i >= 0; i -= 1) {
      if (isRepeat(pool[i], s)) return { dup: true, same: pool[i], score: similarity(pool[i], s) };
    }
    return { dup: false };
  }

  /**
   * 重问一次。返回要追加的那句提示（给上层拼消息用）。
   * 只允许一次：第二轮还重复就收下——宁可重复一句，不可因为追求不重复
   * 而把她卡在一个出不来的循环里，那一轮她会一个字都不说。
   */
  function repromptFor(say, same) {
    if (tries >= 1) return null;
    tries += 1;
    stats.reprompts += 1;
    /* 措辞上不出现"重复"这两个字：写"别提重复"等于把这两个字递到她嘴边，
     * 她下一句就会说"我是不是重复了"。只说事实和怎么办，别的都不提。 */
    return `你刚才要说的是「${String(say).trim()}」，这句你前面已经说过了（「${same}」）。`
      + '换一种说法，或者这一轮干脆不说（say 留空）。别为这件事解释，也别道歉。';
  }

  return {
    begin, look, check, repromptFor, recent,
    stats: () => ({ ...stats }),
    describe: () => {
      const r = recent();
      const a = audit(r);
      const worst = a.opener ? `「${a.opener.word}」${a.opener.count} 次` : '没有明显扎堆的开头';
      return `说话的样子：最近 ${r.length} 句，平均 ${a.avgChars} 字，${worst}`
        + (a.repeats.length ? `，${a.repeats.length} 句撞了前面的` : '');
    },
  };
}
