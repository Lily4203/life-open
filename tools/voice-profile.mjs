/* 她的声音是什么样（音色 / 语速 / 呼吸）
 * ============================================================
 * 为什么单独一个文件：以前"怎么念"这件事散在两处——引擎在 tools/tts.mjs，
 * 情绪在 loop 里，中间没人管"这句话该用什么口气"。结果是所有话一个速度、一个音高，
 * 而且用的是 Windows 那个 2009 年的拼接音（Huihui），听起来像导航播报。
 *
 * 真人不像机器，主要差在三件事上（按影响从大到小）：
 *   ① **音色本身**：神经 TTS 和拼接音不是"好一点"的差别，是两种东西。
 *   ② **不匀速**：人不可能每句一个速度。同一段话里，长句会赶、短句会慢。
 *   ③ **呼吸**：句号后面有 200 毫秒的空，问号后面更长一点。机器是一串连着的。
 * 这三条都能用纯参数做到，不用训练模型、不用花钱。
 *
 * 做不到的三件事，写在这儿是为了不假装：
 *   · 重音（要 SSML 的 emphasis，edge 的免费接口不给）
 *   · 气声/叹气（要音素级拼接）
 *   · 语气词（"嗯""啊"属于她说什么，不属于我们怎么念——那是替她编话）
 *
 * 一个关键取舍：抖动必须是**确定性**的（同一句话永远同样的处理）。
 * 用随机数会让同一句每次合成结果不同，缓存直接失效，每说一遍花一遍钱。
 */

/** 她的音色。换人只改这里。 */
export const PERSONA = {
  voice: 'zh-CN-XiaoyiNeural',   // 少女音，微软标的风格是 Cartoon + Lively
  rate: 5,                        // 比默认快一点点：真人日常说话比 TTS 默认快
  pitch: 1,                       // 只抬 1Hz。抬多了是"假甜"，一听就是配音
  volume: 0,
};

/* 备选，换口味时改 PERSONA.voice 就行：
 *   zh-CN-XiaoxiaoNeural        温暖，偏成熟，适合播报/讲故事
 *   zh-CN-liaoning-XiaobeiNeural 东北话，幽默（做方言人格时用）
 *   zh-CN-shaanxi-XiaoniNeural   陕西话，明亮
 */

/**
 * 情绪 → 语气偏移。只偏移，不覆盖：基础音色永远是 PERSONA。
 * 数字是"在 PERSONA 基础上再加多少"，不是绝对值——所以换音色时这张表不用动。
 */
export const MOODS = {
  happy:     { rate: 5,  pitch: 6, zh: '高兴（快一点、亮一点）' },
  angry:     { rate: 8,  pitch: 4, zh: '生气（更快、更硬）' },
  sad:       { rate: -8, pitch: -6, zh: '难过（慢下来、沉下去）' },
  relaxed:   { rate: -4, pitch: -2, zh: '放松（慢一点、低一点）' },
  surprised: { rate: 10, pitch: 9, zh: '惊讶（抢话、拔高）' },
};

/** 认识的情绪名。别的一律当"没有情绪"，不猜。 */
export const MOOD_NAMES = Object.keys(MOODS);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 字符串 → 稳定的 -1..1 之间的小数。同一句话永远得到同一个值。 */
export function stableUnit(s) {
  let h = 2166136261 >>> 0;
  const t = String(s ?? '');
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ((h % 2000) / 1000) - 1;      // -1 .. 1
}

/**
 * 这一句该怎么念。
 *
 * 返回 { rate:'+7%', pitch:'+2Hz', volume:'+0%', rateNum, pitchNum, mood, wobble, why }
 *   rate/pitch 已经是 edge 要的字符串格式；rateNum/pitchNum 是数字，给测试和缓存键用。
 *   why 是"为什么是这个数"，出问题能看出是哪一项加的。
 *
 * 三条起伏，加起来刚好是"人不会匀速"：
 *   · 长句赶一点（+1 到 +3），短句慢一点（-3）：人一口气不够，长句会抢。
 *   · 每句一个 -2..+2 的固定抖动：是她这一句自带的起伏，不是噪声。
 *   · 情绪在最后整体偏移一次：只加一次，不叠乘。
 */
export function prosody(text, { mood = null, persona = PERSONA } = {}) {
  const s = String(text ?? '');
  const n = s.replace(/[\s，。！？、；：,.!?;:「」『』"'（）()]/g, '').length;
  const why = [];

  let rate = persona.rate ?? 0;
  let pitch = persona.pitch ?? 0;
  const volume = persona.volume ?? 0;
  why.push(`基础 ${rate >= 0 ? '+' : ''}${rate}%/${pitch >= 0 ? '+' : ''}${pitch}Hz`);

  /* 长短句。分界不是拍脑袋：20 字以上在中文里已经是一口说不完的句子。 */
  let byLen = 0;
  if (n >= 30) byLen = 3;
  else if (n >= 20) byLen = 2;
  else if (n >= 12) byLen = 1;
  else if (n > 0 && n <= 5) byLen = -3;
  if (byLen) { rate += byLen; why.push(`句长 ${n} 字 → ${byLen >= 0 ? '+' : ''}${byLen}%`); }

  /* 每句自带的固定起伏。±2% 在听感上是"轻一点/重一点"，再大就变成音色不稳。 */
  const wobble = Math.round(stableUnit(s) * 2);
  if (wobble) { rate += wobble; why.push(`这一句的起伏 ${wobble >= 0 ? '+' : ''}${wobble}%`); }

  /* 情绪：最后加一次。没写、写错、写成我们不认识的值，都当没有。 */
  const m = mood && MOODS[mood] ? mood : null;
  if (m) {
    rate += MOODS[m].rate;
    pitch += MOODS[m].pitch;
    why.push(`${m} ${MOODS[m].rate >= 0 ? '+' : ''}${MOODS[m].rate}% / ${MOODS[m].pitch >= 0 ? '+' : ''}${MOODS[m].pitch}Hz`);
  }

  /* 夹住范围。rate 超出 ±60% 会开始吞字，pitch 超过 ±25Hz 会变成另一个人。 */
  rate = clamp(rate, -60, 60);
  pitch = clamp(pitch, -25, 25);

  return {
    rate: `${rate >= 0 ? '+' : ''}${rate}%`,
    pitch: `${pitch >= 0 ? '+' : ''}${pitch}Hz`,
    volume: `${volume >= 0 ? '+' : ''}${volume}%`,
    rateNum: rate, pitchNum: pitch,
    mood: m, wobble, why: why.join('；'),
    chars: n,
  };
}

/**
 * 这一句念完之后留多长的空。
 *
 * 为什么要在音频里补，而不是前端等：前端等多少都得靠猜，
 * 而且她和下一句之间还隔着一次合成（一秒多），加起来就是"卡住"。
 * 补在 wav 尾巴上，播放器一口气播完，听起来就是她说完这句停了一下。
 *
 * 毫秒数来自"人说话换气的习惯"，不是物理常数：
 *   问句停顿最长（在等回答）、省略号最长（在想）、叹号最短（急着往下说）。
 */
export function pauseAfter(text) {
  const s = String(text ?? '').trimEnd();
  if (!s) return 0;
  if (/[？?]$/.test(s)) return 260;
  if (/[～~]$/.test(s)) return 220;
  if (/[…]$/.test(s)) return 420;
  if (/[…]/.test(s)) return 400;
  if (/[！!]$/.test(s)) return 200;
  if (/[。.]$/.test(s)) return 210;
  return 120;      // 没句末标点的（被硬切的半句）：短一点，别听着像说完了
}
