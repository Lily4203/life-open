/* 结构化输出（P9）：让模型按 JSON 回，而不是"回完再要一次"
 *
 * 这一组盯的不是"参数传没传"，是那一件真会出事的事：
 * DeepSeek 的 json_object 在"输出不能被识别成 JSON"时，**会把正文整段替换成空格**，
 * 而 finish_reason 仍然是 stop。所以开了 json 之后拿到空白是**正常现象**，
 * 必须当成一种可诊断的失败去重试——不能当成"她今天不想说话"。
 *
 * 还有一条同样重要：重发那遍必须**关掉** json 模式。
 * 开着还失败，说明这条路在这个模型上不稳，硬要来第二次只会再拿一个空白；
 * 关掉之后最坏也只是退回"散文 + 重发"的老行为——保底不能比原来更差。
 */

import { createLoop } from '../../js/brain/loop.mjs';
import { createMemory } from '../../js/brain/memory.mjs';
import { createRegistry } from '../../js/brain/actions.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIFE = path.resolve(HERE, '../..');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    read: n => m.get(n) ?? '',
    write: (n, t) => { m.set(n, t); },
    append: (n, t) => { m.set(n, (m.get(n) || '') + t); },
  };
}
/* loop 不把 memory 露出来（那是对的：外面不该翻她的记忆）。
 * 测试要看"有没有留痕"，所以自己留一份引用。 */
let lastMem = null;
const newLoop = chat => {
  lastMem = createMemory({ store: memStore(), charId: 'fish' });
  return createLoop({ memory: lastMem, registry: createRegistry(), chat });
};

/* ================= A. 一次就成 ================= */
console.log('\nA. 正常这条路');

{
  const calls = [];
  const chat = async o => { calls.push(o); return { content: '{"say":"嗯，在。","do":[]}' }; };
  const loop = newLoop(chat);
  const r = await loop.turn({ text: '在吗' });

  ok(r.ok, 'A1 这一轮走完了');
  eq(r.say, '嗯，在。', 'A2 话是她给的，一个字没改');
  eq(calls.length, 1, 'A3 一次就成，没有重发');
  eq(calls[0].json, true, 'A4 第一遍就要求 JSON 对象（结构化输出）');
  eq(loop.stats().jsonRetries, 0, 'A5 jsonRetries 是 0');
  eq(loop.stats().jsonAsked, 1, 'A6 分母记了（合规率要算得出来）');
  eq(r.retried, false, 'A7 返回里 retried 是 false');
}

/* ================= B. 空白：上游把话吃了 ================= */
console.log('\nB. 空白（JSON 模式下"输出不是 JSON"会被替换成空格）');

{
  const calls = [];
  const chat = async o => {
    calls.push(o);
    if (calls.length === 1) return { content: '   \n  ', finish: 'stop' };   // 官方文档写死的行为
    return { content: '{"say":"刚才走神了一下。","do":[]}' };
  };
  const loop = newLoop(chat);
  const r = await loop.turn({ text: '在吗' });

  ok(r.ok, 'B1 空白之后重发，这一轮还是走完了');
  eq(r.say, '刚才走神了一下。', 'B2 话是重发那次给的');
  eq(loop.stats().blanks, 1, 'B3 空白单独记一笔（不是"格式差一点"）');
  eq(loop.stats().jsonRetries, 1, 'B4 空白算一次失败，重发了一次');
  eq(calls[1].json, false, 'B5 重发**关掉** JSON 模式（开着只会再拿一个空白）');
  ok(!calls[1].messages.some(m => m.role === 'assistant' && !String(m.content).trim()),
    'B6 不把那条空白当"她上一条说的话"喂回去');
  ok(/空/.test(calls[1].messages.at(-1).content), 'B7 重发说的是"你上一条是空的"，不是"不是 JSON"');
  ok(!/不是 JSON/.test(calls[1].messages.at(-1).content), 'B8 空白时不许说"不是 JSON"——她看到的上一条真的是空的');
}

/* ================= C. 空白 + 重发也不成 ================= */
console.log('\nC. 两次都空白：不能静默');

{
  const chat = async () => ({ content: '  ' });
  const loop = newLoop(chat);
  const r = await loop.turn({ text: '在吗' });

  ok(r.ok, 'C1 还是"跑完了"（不是崩溃）');
  eq(r.say, '', 'C2 这一轮她一个字都没说');
  eq(r.stillBad, true, 'C3 但要说清"格式还是不对"，不许假装正常');
  eq(loop.stats().blanks, 2, 'C4 两次空白都数上了');

  const evs = lastMem.events().filter(e => e.who === 'system' && /空白/.test(e.text));
  ok(evs.length >= 1, 'C5 留了痕（不然事后只看到"她那天话少"，查不出原因）', JSON.stringify(evs.map(e => e.text)));
}

/* ================= D. 散文：不是空白，是"格式差一点" ================= */
console.log('\nD. 散文（没有 json 模式时最常见的那种）');

{
  const calls = [];
  const chat = async o => {
    calls.push(o);
    if (calls.length === 1) return { content: '我去翻翻原文。', finish: 'stop' };
    return { content: '{"say":"原文找到了。","do":[]}' };
  };
  const loop = newLoop(chat);
  const r = await loop.turn({ text: '去翻翻' });

  eq(r.say, '原文找到了。', 'D1 重发那次给了 JSON');
  eq(calls[1].json, false, 'D2 重发同样关掉 JSON 模式（一律，不看是哪一种失败）');
  ok(calls[1].messages.some(m => m.role === 'assistant' && m.content === '我去翻翻原文。'),
    'D3 散文要当"她上一条"喂回去（她才知道该改什么）');
  ok(/不是 JSON/.test(calls[1].messages.at(-1).content), 'D4 这种情况下才说"不是 JSON"');
  eq(loop.stats().blanks, 0, 'D5 有字的失败不算空白');
}

/* ================= E. 被截断 ================= */
console.log('\nE. 截断（finish: length）');

{
  const calls = [];
  const chat = async o => {
    calls.push(o);
    if (calls.length === 1) return { content: '{"say":"很长很长的一', finish: 'length' };
    return { content: '{"say":"短了。","do":[]}' };
  };
  const loop = newLoop(chat);
  const r = await loop.turn({ text: '说长一点' });

  eq(r.say, '短了。', 'E1 重发之后拿到了完整的');
  eq(loop.stats().truncated, 1, 'E2 截断单独记一笔');
  ok(/太长|截断/.test(calls[1].messages.at(-1).content), 'E3 重发要说"太长了"，不是"再要一次"', calls[1].messages.at(-1).content);
}

/* ================= F. 兼容：chat 直接返回字符串 ================= */
console.log('\nF. 兼容老写法');

{
  const chat = async () => '{"say":"好。","do":[]}';      // 假实现经常这么写
  const loop = newLoop(chat);
  const r = await loop.turn({ text: '在吗' });
  ok(r.ok, 'F1 返回字符串也认');
  eq(r.say, '好。', 'F2 照样解析出来');
}

/* ================= G. 合规率算得出来 ================= */
console.log('\nG. 三个数够算合规率');

{
  let n = 0;
  const chat = async () => {
    n += 1;
    // 第 1 轮：一次成；第 2 轮：散文 + 重发
    if (n === 1) return { content: '{"say":"一。","do":[]}' };
    if (n === 2) return { content: '想了想。' };
    return { content: '{"say":"二。","do":[]}' };
  };
  const loop = newLoop(chat);
  await loop.turn({ text: 'a' });
  await loop.turn({ text: 'b' });
  const s = loop.stats();
  eq(s.jsonAsked, 2, 'G1 问了几轮（分母是轮数，重发不算新的一轮）');
  eq(s.jsonRetries, 1, 'G2 其中几次要了第二遍');
  ok(Math.abs((1 - s.jsonRetries / s.jsonAsked) - 0.5) < 1e-9, 'G3 合规率 = 1 - 重发/轮数，算得出来');
}

/* ================= H. 源码断言：这几处不许退回去 ================= */
console.log('\nH. 源码断言');

{
  const serve = fs.readFileSync(path.join(LIFE, 'tools/serve.mjs'), 'utf8');
  const loopSrc = fs.readFileSync(path.join(LIFE, 'js/brain/loop.mjs'), 'utf8');
  const promptSrc = fs.readFileSync(path.join(LIFE, 'js/brain/prompt.mjs'), 'utf8');
  const page = fs.readFileSync(path.join(LIFE, '预览-66.html'), 'utf8');

  ok(/q\.json === true/.test(serve), 'H1 服务端只认一个布尔');
  ok(!/q\.response_format/.test(serve),
    'H2 不接受外部传 response_format（那等于让人规定她怎么输出，和"外面不许替她思考"是同一条红线）');
  const modeHits = (serve.match(/jsonMode\(q\)/g) || []).length;
  ok(modeHits >= 2, 'H3 流式和非流式两条路都接上了（漏一条就等于没做）', String(modeHits));

  /* 关键不是"出现了几次"，是"每一处直接调模型的地方都带了"。
   * 漏一处 = 那条路上没有结构化输出，而且看不出来（只是偶尔多花一次钱）。 */
  const chatCalls = (loopSrc.match(/await chat\(\{/g) || []).length;
  const declared = (loopSrc.match(/json: (true|false)/g) || []).length;
  ok(chatCalls >= 2 && declared >= chatCalls,
    'H4 每一处直接调模型的地方都**明确表态**（true 或 false），不许有一处默认',
    `调用 ${chatCalls} 处，明确写了 ${declared} 处`);
  ok(/json: false/.test(loopSrc), 'H5 重发那一处明确关掉（这是"保底不能更差"的落点）');
  ok(/stats\.blanks \+= 1/.test(loopSrc), 'H6 空白单独计数');

  ok(/json 对象/.test(promptSrc), 'H7 prompt 里有小写 json 这个词（上游的硬前提之一）');
  ok(/\{"say":"你要说的话"/.test(promptSrc), 'H8 prompt 里有字面格式示例（上游的另一个硬前提）');
  ok(/对象外面别的字一个都不要有/.test(promptSrc), 'H9 "外面不许有字"说死了（散文的来源就在这）');

  ok(/\.\.\.\(json \? \{ json: true \} : \{\}\)/.test(page), 'H10 页面只透传，不自己决定');
}

/* ================= I. 历史里的她，要按当时的格式回放 ================= */
/* 这一组是 P9 里最贵的一条教训，也是唯一一条"参数加了却更糟"的。
 *
 * 现象：开了 json_object，真页面 6 轮**全部**第一遍空白，每轮都要重发一次。
 * 对照实验（每组 8 次）：
 *   历史里 assistant 是纯文本 say   → 0/8 合规，8/8 空白
 *   历史里 assistant 是 {"say":"…"} → 8/8 合规
 *   历史为空                        → 8/8 合规
 * 原因：历史是最强的示范。我们 system 里要求"每句都是 JSON"，历史里却回放成纯文本，
 *      模型照着历史来，上游就把那段散文替换成空格。
 * 所以这里守的不是"格式好看"，是"别每轮白花一次请求"。 */
console.log('\nI. 历史里她说过的话是什么格式');

{
  const seen = [];
  const chat = async o => {
    seen.push(o.messages);
    return { content: '{"say":"第一行。\\n第二行。","do":[]}' };
  };
  const loop = newLoop(chat);
  await loop.turn({ text: '你好' });        // 这一轮她说了一句
  await loop.turn({ text: '再说一句' });     // 第二轮才看得到历史

  const msgs = seen.at(-1) || [];
  const hers = msgs.filter(m => m.role === 'assistant');

  ok(hers.length >= 1, 'I1 历史里有她说过的', String(hers.length));
  ok(hers.every(m => {
    try { const j = JSON.parse(m.content); return typeof j.say === 'string'; } catch { return false; }
  }), 'I2 她说过的那几句，回放时是合法 JSON 对象（不是纯文本）',
    JSON.stringify(hers.map(m => String(m.content).slice(0, 30))));

  const first = hers.find(m => { try { return JSON.parse(m.content).say === '第一行。\n第二行。'; } catch { return false; } });
  ok(!!first, 'I3 话本身一个字没改（换行也在）', JSON.stringify(hers.map(m => String(m.content).slice(0, 40))));

  ok(hers.every(m => !/^\s*\[/.test(String(m.content))), 'I4 她的那句仍然不带时间戳前缀（带了会被学成自己的口癖）');

  const his = msgs.filter(m => m.role === 'user');
  ok(his.length >= 1, 'I5 他说过的话也在历史里');
  ok(his.every(m => !/^\s*\{/.test(String(m.content))), 'I6 他说的话不许被包成 JSON（那会变成她在回答一个对象）');
  ok(his.some(m => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/.test(String(m.content))),
    'I7 他的话仍然带绝对时间戳（跨天算日期靠它）');
}

/* ================= I'. 历史里必须有 do 这个键 ================= */
/* 这是"真页面动作永远是 0"的根因，也是最隐蔽的一条：
 * 她一开始只是闲聊几轮，那几轮她真没动，历史里就回放成 {"say":…}——
 * **do 这个键整个不见了**。之后她照着历史写，也只剩 say；越不动，历史越没有 do。
 *
 * 五组对照（同一句"把灯关掉"，每组 5 次，真实动作表、真实系统提示词）：
 *   历史只有 say          → 2/5 有动作
 *   历史 say + do:[]      → 5/5
 *   历史七个键全在        → 5/5
 *   没有历史              → 5/5
 * 差的不是提示词，是那三个字符。所以这一组守两件事：
 *   ① 每一条 assistant 历史都带 do（哪怕空）；
 *   ② 只补键，不补动作——她那次真没动，就不能在历史里替她编一个。 */
console.log('\nI\'. 历史里那个 do 键');

{
  const seen = [];
  /* 故意让她输出的对象里**没有** do——这正是真页面前几轮的样子（闲聊，没动作）。 */
  const chat = async o => {
    seen.push(o.messages);
    return { content: '{"say":"嗯。"}' };
  };
  const loop = newLoop(chat);
  await loop.turn({ text: '在吗' });
  await loop.turn({ text: '嗯' });

  const hers = (seen.at(-1) || []).filter(m => m.role === 'assistant');
  ok(hers.length >= 1, 'I8 有历史可查', String(hers.length));
  ok(hers.every(m => {
    try { return 'do' in JSON.parse(m.content); } catch { return false; }
  }), 'I9 每一条 assistant 历史都有 do 键（少这个键，她会学成只说话）',
    JSON.stringify(hers.map(m => String(m.content).slice(0, 40))));

  /* raw 照旧存她当时的原样：历史是示范，可以补形状；raw 是证据，不能改。
   * 改了就再也查不出"她当时到底有没有写 do"。 */
  const said = lastMem.events().filter(e => e.kind === 'said' && e.who === 'fish');
  ok(said.length >= 1 && said.every(e => e.raw === '{"say":"嗯。"}'),
    'I10 存下来的 raw 仍是原样（不补键、不改写）', JSON.stringify(said.map(e => e.raw)));

  // 老数据/写坏的 raw：退回最小对象时也得带 do
  lastMem.record({ who: 'fish', kind: 'said', text: '这句没有原文。', salience: 0.5 });
  await loop.turn({ text: '再说一句' });
  const hers2 = (seen.at(-1) || []).filter(m => m.role === 'assistant');
  const noRaw = hers2.find(m => { try { return JSON.parse(m.content).say === '这句没有原文。'; } catch { return false; } });
  ok(!!noRaw && 'do' in JSON.parse(noRaw.content),
    'I11 没有 raw 时退回的对象也带 do:[]（老数据不能把格式教坏）',
    JSON.stringify(hers2.map(m => String(m.content).slice(0, 40))));
  ok(!!noRaw && JSON.parse(noRaw.content).do.length === 0,
    'I12 补的是空 do，不是替她编一个动作');
}

console.log(`\n${fail ? '✗' : '✓'} 全部通过：${pass}${fail ? `，失败 ${fail}` : ''}`);
process.exit(fail ? 1 : 0);
