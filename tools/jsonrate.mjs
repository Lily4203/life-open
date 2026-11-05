/* 合规率体检：连续问 N 轮，看模型**第一次**给的到底是不是 JSON。
 *
 * 为什么单独做一个工具：`jsonRetries` 只在页面里能看到，而且混在真实对话里，
 * 说不出"到底是哪一条指令没起作用"。这里用**真实的系统提示词**问同一类问题，
 * 第一遍给什么就算什么（不重发），所以它测的正是 P9 的收益。
 *
 * 用法：
 *   PORT=8805 node tools/jsonrate.mjs        # 默认 10 轮
 *   PORT=8805 node tools/jsonrate.mjs 20
 *
 * 换模型、改提示词、改 max_tokens 之后都该跑一遍。
 * 合规率不是"好看"，它直接决定她开口要多等几秒、多花一次钱。
 */

import { createRegistry } from '../js/brain/actions.mjs';
import { buildSystem, MOODS } from '../js/brain/prompt.mjs';

const PORT = process.env.PORT || '8805';
const N = Math.max(1, Math.min(200, Number(process.argv[2]) || 10));
const URL = `http://127.0.0.1:${PORT}/api/chat`;

/* 贴近真实的一段 boot：真实的系统提示词 + 真实的动作表，唯一的简化是没有屋子实体。
 * 不简化"怎么回"那一段——合规率几乎全由它决定。 */
const boot = {
  charId: 'fish',
  chars: 0,
  blocks: [
    { id: 'boot.identity', text: '你叫阿鱼，住在一间小屋子里。说话很短，一两句就够。' },
    { id: 'boot.now', text: '现在是 2026-11-05 15:00，星期四。' },
  ],
};

const QUESTIONS = [
  '在吗',
  '你在干嘛',
  '刚才那件事你还记得吗',
  '屋里灯是开着的吗',
  '你觉得今天怎么样',
  '帮我把窗帘拉上',
  '你饿不饿',
  '现在几点了',
  '刚才有人来说了什么',
  '你想坐一会儿吗',
  '桌上有几样东西',
  '你刚才是不是走神了',
  '外面天气怎么样',
  '你还记得我叫什么吗',
  '说点什么吧',
  '你困了吗',
  '要不要喝点茶',
  '你现在站在哪',
  '刚才那句话什么意思',
  '安静一会儿也行',
];

const system = buildSystem({ boot, registry: createRegistry(), entities: [], avatar: null, extra: '' });

let ok = 0, blank = 0, bad = 0, cut = 0, mood = 0, badMood = 0;
const t0 = Date.now();

console.log(`问 ${N} 轮（第一遍算数，不重发），端口 ${PORT}\n`);

for (let i = 0; i < N; i += 1) {
  const q = QUESTIONS[i % QUESTIONS.length];
  const started = Date.now();
  let line = '';
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, messages: [{ role: 'user', content: q }], json: true, max_tokens: 400 }),
    });
    const j = await r.json();
    const text = String(j.content ?? '');
    const ms = Date.now() - started;

    let verdict;
    if (!text.trim()) { blank += 1; verdict = '空白'; }
    else if (j.finish === 'length') { cut += 1; verdict = '截断'; }
    else {
      let parsed = null;
      try { parsed = JSON.parse(text.trim()); } catch { /* 下面判 */ }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.say === 'string') {
        ok += 1; verdict = '合规';
        /* 顺手统计情绪落款（P5）：写了算一个，写了词表外的算另一种。
         * 这两种必须分开数——"没写"是她不想强调，"写错"是词表没讲清楚。 */
        if (parsed.mood) { if (MOODS.includes(parsed.mood)) mood += 1; else badMood += 1; }
      } else { bad += 1; verdict = '不是 JSON'; }
    }
    const head = text.replace(/\s+/g, ' ').slice(0, 48);
    line = `${verdict.padEnd(9)} ${String(ms).padStart(5)}ms  ${String(text.length).padStart(4)} 字  ${head}`;
  } catch (e) {
    bad += 1;
    line = `出错       ${'     '}      ${e.message}`;
  }
  console.log(`${String(i + 1).padStart(2)}  ${line}`);
}

const pct = n => `${Math.round((n / N) * 1000) / 10}%`;
console.log('\n——————————————————————————————');
console.log(`合规 ${ok}/${N} = ${pct(ok)}   空白 ${blank}   非 JSON ${bad}   截断 ${cut}   共用 ${Math.round((Date.now() - t0) / 1000)} 秒`);
console.log(`情绪落款：写了 ${mood}/${N}（词表外 ${badMood}）——"没写"是正常输出，不是失败`);

/* 退出码只说一件事：有没有出现"拿不到话"（空白/非 JSON/截断）。
 * 合规率低于 100% 但都能救（重发拿到），不算失败——所以这里不看比例，看有没有硬伤。 */
process.exit(ok === N ? 0 : 1);
