/* 流式里"她说到哪儿了"
 * ------------------------------------------------------------
 * 这件事必须说清楚边界，不然就是又一次"我们的判断借她的嘴说出来"：
 *
 *   它只做三件**运输**上的事：
 *     1. 从还没写完的 JSON 里，把 say 那个字符串的**当前值**抠出来（引号没闭合就先给一半）；
 *     2. 在这一半里按句末标点切开，让整句先出去（半句不说，说了收不回）；
 *     3. 最终定稿时算清楚"哪一段还没说出口"，避免同一句说两遍。
 *
 *   它**不做**的事：
 *     · 不补字、不改字、不顺句。抠出来是什么就是什么，一个字都不动。
 *     · 不决定"要不要说"。要不要说是模型给的（say 为空就是不说）。
 *     · 不判断"这句话合不合适"。它没有那个能力，也不该有。
 *
 * 为什么值得单独一个文件：这三件事都有边界情况（转义、半个字、代码块里的引号、
 * 最后一句没有句号），塞在页面里就只能靠人眼看，出事也说不清是哪一步错的。
 */

/* JSON 字符串里的转义。只认标准的那几个，别的原样吐出——
 * 猜错一个转义，她会说出一个不存在的字，比慢更糟。 */
const ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/* 话里的停顿标记：【停】。词表和长度在 style.mjs，这里只管怎么用。
 *
 * 为什么不在这里定义一遍：两处各写一份，改了一处忘了另一处，
 * 结果就是"提示词让她写【停】，播放端不认"，标记被 TTS 念成一个"停"字——
 * 那比她不说这句还怪。所以 import，不复制。 */
import { MARKS, MARK_PAUSE } from './style.mjs';

const MARK_RE = new RegExp(`【(${MARKS.join('|')})】`, 'g');

/** 摘掉标记。字幕用：观众不该看见【停】这两个字。 */
export const stripScript = s => String(s ?? '').replace(MARK_RE, '');

/**
 * 把一段带标记的话切成"要连续播的几段"，每段带一个开口前要停多久。
 *
 * 返回 [{ text, pauseBefore }]
 *   text        这一段的话（标记已摘掉，首尾空白已去）
 *   pauseBefore 开口前静默多少毫秒（来自它前面的标记，连续标记会累加）
 *
 * 为什么停在前一段之后而不是"做成一段静音插进音频里"：
 * 音频要拼就得先知道格式（wav/mp3 两套），而播放在页面里，等一个 setTimeout 是一行。
 * 我们已经在句间用同一套办法（voice.mjs 的 onended + 停顿），这里保持一致。

 * 三条保守规则：
 *   1. 标记在开头 → 第一段带着这个停顿（她真打算先顿一下再说）
 *   2. 标记在结尾 → 丢掉（后面没话了，停给谁听）
 *   3. 只切不合并：标记之间的空白段直接不要，不生成只说空白的段
 */
export function splitScript(text, { pause = MARK_PAUSE } = {}) {
  const s = String(text ?? '');
  const out = [];
  let pending = 0;        // 下一段开口前要停多久
  let buf = '';
  let at = 0;

  const flush = () => {
    const t = buf.trim();
    if (t) out.push({ text: t, pauseBefore: pending });
    /* 只有真的产出一段，才把这个 pending 消费掉；
     * 空白段不该把停顿吃掉（否则"【停】。"里那半秒会凭空消失）。 */
    if (t) pending = 0;
    buf = '';
  };

  MARK_RE.lastIndex = 0;
  let m;
  while ((m = MARK_RE.exec(s))) {
    buf += s.slice(at, m.index);
    flush();
    pending += pause[m[1]] || 0;
    at = m.index + m[0].length;
  }
  buf += s.slice(at);
  flush();
  return out;
}

/**
 * 从（可能还没写完的）模型原文里，抠出 `"say"` 的当前值。
 * 返回 { found, text, closed, notString }
 *   found      找到了 "say" 这个键，而且值是字符串
 *   text       已经能确定的那部分（转义已还原）
 *   closed     true = 值的右引号已经到了，这段话说定了
 *   notString  "say" 存在但值不是字符串（null / 数组）——这种一律不说
 */
export function extractSay(raw) {
  const s = String(raw ?? '');
  const re = /"say"\s*:\s*/g;
  let m;
  while ((m = re.exec(s))) {
    const i = m.index + m[0].length;
    if (s[i] !== '"') {
      /* 值是 null / 数组 / 数字：不是"她还什么都没说"，是"这条格式我们没约定过"。
       * 记 notString 而不是硬当成空，出事时能看出是模型换了写法。 */
      return { found: false, text: '', closed: false, notString: true };
    }
    let out = '';
    let j = i + 1;
    let closed = false;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') {
        const n = s[j + 1];
        // 转义写了一半（流就断在这儿）：已经确定的部分照给，这个别算
        if (n === undefined) return { found: true, text: out, closed: false, notString: false };
        if (n === 'u') {
          const hex = s.slice(j + 2, j + 6);
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
            return { found: true, text: out, closed: false, notString: false };
          }
          out += String.fromCharCode(parseInt(hex, 16));
          j += 6;
          continue;
        }
        out += ESC[n] ?? n;
        j += 2;
        continue;
      }
      if (c === '"') { closed = true; j += 1; break; }
      out += c;
      j += 1;
    }
    return { found: true, text: out, closed, notString: false };
  }
  return { found: false, text: '', closed: false, notString: false };
}

/* 句末：中文句号问号叹号、英文的 ! ?、省略号、换行。
 * 为什么不认 `；`：它是句中的停顿，"我给你做了三件事；第一件…" 拆开会像三句。 */
const END = new Set(['。', '！', '？', '!', '?', '…', '\n', '～', '~']);
// 跟着句末一起走的收尾符号（引号、括号），否则会出现"他说「好」「。"这种断口
const TAIL = new Set(['」', '』', '”', '’', '"', '\'', '）', ')', '】', ']']);
// 太长又没句末时的退路：在这些地方断，比硬切强
const SOFT = new Set(['，', '、', ',', '；', ';', '：', ':']);
/* 一句话里"有内容"的判据：去掉标点和引号之后还剩字。
 * 不这么做的话，"。。"会变成一句她说的话——她会念一个句号出来。 */
const NOISE = /[。！？!?…~～，、,；;：:\s」』”’"'）)】\]]/g;

/**
 * 把一段话切成一整句一整句。
 * 返回 { ready: [{ text, used }], rest }
 *   ready  可以现在就说的整句（已去掉首尾空白，但 used 记的是原文吃掉多少）
 *   rest   还不足以成句的尾巴，留在调用方手里，等下一批字
 *
 * 三条保守规则：
 *   1. 没有句末标点就**不切**（除非超过 max，那时才在逗号处断）——半句说出去收不回。
 *   2. 切出来的只有标点/空白，不算一句（避免她说一个"。"）。
 *   3. 一次最多吃 max 字左右，避免模型不写标点时她一口气憋一段长的。
 */
export function takeSentences(text, { max = 80, min = 2 } = {}) {
  const s = String(text ?? '');
  const ready = [];
  let rest = s;
  let usedAll = 0;          // 一共吃掉多少字（**包括**被跳过的纯标点段）
  for (;;) {
    let cut = -1;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (END.has(c)) {
        let j = i + 1;
        // 连续的句末符号（"？！""……"）和收尾引号一起吃掉
        while (j < rest.length && (END.has(rest[j]) || TAIL.has(rest[j]))) j += 1;
        cut = j;
        break;
      }
    }
    if (cut > 0) {
      const one = rest.slice(0, cut);
      if (one.trim().length >= min && one.replace(NOISE, '').length > 0) ready.push({ text: one.trim(), used: cut });
      rest = rest.slice(cut);
      usedAll += cut;
      continue;
    }
    // 一个句末都没有，但已经太长了：在最近的软停处断，没有再硬断
    if (rest.length > max) {
      let k = -1;
      for (let i = Math.min(max, rest.length - 1); i > min; i -= 1) {
        if (SOFT.has(rest[i])) { k = i + 1; break; }
      }
      const cut2 = k > 0 ? k : max;
      const one = rest.slice(0, cut2);
      if (one.trim().length >= min && one.replace(NOISE, '').length > 0) ready.push({ text: one.trim(), used: cut2 });
      rest = rest.slice(cut2);
      usedAll += cut2;
      continue;
    }
    break;
  }
  return { ready, rest, usedAll };
}

/* 定稿里"已经说过的那一段"到哪儿结束。
 * 为什么要一个字一个字对，而不是直接 slice(已说长度)：
 * 模型会用 "  \n" 这种东西给句子之间留空，而说出去的是去掉空白的句子。
 * 两边长度不一样，按长度切就会切在字中间——剩下的那句会变成半句。
 *
 * 返回定稿里的下标；对不上返回 -1（说明模型改了口）。 */
function prefixEnd(final, said) {
  let i = 0;
  let j = 0;
  while (j < said.length) {
    if (i >= final.length) return -1;
    const a = final[i];
    if (a === ' ' || a === '\n' || a === '\r' || a === '\t') { i += 1; continue; }
    if (a !== said[j]) return -1;
    i += 1; j += 1;
  }
  return i;
}

/**
 * 一边收字一边说。
 *
 * 模式（页面上 `?stream=` 切）：
 *   speak  一边流一边说（默认）：整句先上字幕和声音
 *   quiet  只流不说：知道她正在写、打断能立刻掐断，但一个字都不提前放出去
 *   off    不走流式（走老的整段请求），出事时一键退回
 *
 * 模式只决定"提前说不说"，**不决定说什么**——三种模式下她的话都只有模型给的那一份。
 */
export function createLiveSay({
  show = () => {},         // 上字幕（一句一句追加）
  speak = () => {},        // 出声（一句一句）：页面传进来的通常是"经执行层说"
  stop = () => {},         // 打断：把还没说的和正在出声的都停掉
  mode = 'speak',
  max = 80,
  now = () => Date.now(),
  onEvent = null,          // (kind, info) 留痕：mismatch / aborted，别静默
} = {}) {
  const stats = {
    deltas: 0, chars: 0, sentences: 0, spokenChars: 0,
    firstMs: null,          // 从开始到第一句出口的毫秒数——这就是流式换来的东西
    mismatches: 0,          // 定稿和已说的对不上（不该发生，发生要看得见）
    aborts: 0,
  };

  let raw = '';             // 模型原文（累计，这一遍）
  let sayText = '';         // 从原文里抠出来的 say（累计，这一遍）
  let consumed = 0;         // sayText 里已经说出口的字符数（这一遍）
  let said = '';            // 这一**轮**里已经说出口的全部文字（跨遍数，收不回的都在这里）
  let started = false;      // 这一轮开始的时间点
  let live = false;         // 这一轮到底有没有真的边流边说
  let dead = false;         // 被打断了：后面的字一律不处理

  /** 新一轮（他刚说了句话）。上一轮说过的话不算在这一轮里。 */
  function begin() {
    raw = ''; sayText = ''; consumed = 0; said = ''; started = now(); live = false; dead = false;
    return stats;
  }

  /** 同一轮里的下一遍（取正文 / 重发）：取字缓冲清空，但**已经说出口的照样算说过**。 */
  function nextAttempt() {
    raw = ''; sayText = ''; consumed = 0; dead = false;
    return stats;
  }

  /** 来了一批字。delta 是增量，full 是累计原文（两个都给，谁方便用谁）。 */
  function onDelta(delta, full = null) {
    if (dead) return { ok: false, reason: 'aborted' };
    if (!started) begin();
    const d = String(delta ?? '');
    stats.deltas += 1;
    stats.chars += d.length;
    raw = full != null ? String(full) : raw + d;

    if (mode !== 'speak') return { ok: true, said: 0 };

    /* 先确认它确实是个 JSON 对象。
     * 为什么较真：模型偶尔整段回散文（"我去翻翻原文。"）。散文没有 say 键，
     * 那时我们一个字都不该提前说——说了之后发现格式不对要重发，
     * 她会把那句话再说一遍，或者说了半句就改口。 */
    if (!/^\s*\{/.test(raw)) return { ok: true, said: 0, waiting: 'not-json' };

    const got = extractSay(raw);
    if (!got.found || got.notString) return { ok: true, said: 0, waiting: 'no-say' };
    if (got.text.length <= sayText.length) return { ok: true, said: 0 };
    sayText = got.text;

    const pending = sayText.slice(consumed);
    const { ready, rest, usedAll } = takeSentences(pending, { max });
    if (!ready.length) {
      /* 全是被跳过的标点/空白：也要把 consumed 推过去，
       * 否则下一批字来了会从同一处重新扫，同一句被说两遍。 */
      consumed += usedAll;
      return { ok: true, said: 0, rest: rest.length };
    }
    for (const one of ready) {
      if (dead) break;
      said += one.text;
      stats.sentences += 1;
      stats.spokenChars += one.text.length;
      if (!live) {
        live = true;
        stats.firstMs = now() - started;
      }
      try { show(one.text); } catch { /* 字幕坏了不该让说话停下来 */ }
      try { speak(one.text); } catch { /* 声音出不来，字还在 */ }
    }
    consumed += usedAll;
    return { ok: true, said: ready.length, saidText: ready.map(r => r.text).join(''), closed: got.closed };
  }

  /**
   * 定稿。返回 { rest, mismatch, spoke }：
   *   rest     最终那句里**还没说出口**的部分（页面拿去经执行层说掉）
   *   mismatch true = 模型最终的话和已经流出去的接不上（要留痕，别装没发生）
   *   spoke    这一轮到底提没提前说
   */
  function finish(finalSay = '') {
    const final = String(finalSay ?? '').trim();
    const out = { rest: final, mismatch: false, spoke: live };

    if (!live) return out;
    if (!final) return { rest: '', mismatch: false, spoke: true };

    /* 已说的和定稿必须能接上。
     * 接不上只有两种可能：模型自己改了口，或者我们抠错了——
     * 两种都要看得见，所以记一条 event，而不是悄悄把那半句补上。 */
    const end = prefixEnd(final, said.trim());
    if (end >= 0) {
      const rest = final.slice(end).replace(/^[\s，、,。]+/, '');
      return { rest, mismatch: false, spoke: true };
    }
    stats.mismatches += 1;
    try { onEvent?.('mismatch', { spoken: said.trim(), final }); } catch { /* 留痕失败不影响说话 */ }
    return { rest: final, mismatch: true, spoke: true };
  }

  /** 被打断：还没说的不说了，正在出声的停下。已说出口的收不回，也不假装收回了。 */
  function abort() {
    if (dead) return { ok: false, reason: 'already' };
    dead = true;
    stats.aborts += 1;
    try { stop(); } catch { /* 停不下来也不能把这一轮搞崩 */ }
    return { ok: true, spoken: said };
  }

  return {
    begin, nextAttempt, onDelta, finish, abort,
    get live() { return live; },
    get spoken() { return said; },
    stats: () => ({ ...stats }),
    describe: () => mode === 'off'
      ? '流式：关着（整段请求，等它全部写完）'
      : mode === 'quiet'
        ? `流式：只流不说（这一轮收了 ${stats.chars} 字，一个字都没提前放出去）`
        : `流式：边说边出（${stats.sentences} 句，首句 ${stats.firstMs ?? '—'} ms）`,
  };
}
