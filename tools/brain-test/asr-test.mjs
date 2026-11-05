/* 听：麦克风里的声音怎么变成"一句话"
 * ------------------------------------------------------------
 * 这一组守的是 P3 的三条线（和 hearing.mjs 开头那三条一一对应）：
 *   A  只交整句：半句只给人看；"他说完了"由引擎断句，不由时间断句
 *   B  开关与状态：关掉就一条都不进；权限被拒不许自己重试（那等于拿弹窗逼他同意）
 *   C  自己续听：引擎会自己断（continuous 其实是假的），断了要接回来，但接回来不能是死循环
 *   D  一路走到 chat-in 和记忆：source:'voice' 真的落盘，而且只落一条
 *   E  源码契约：音频进不来；能把半句定稿的计时器一个都不许有
 *
 * 全组不碰真麦克风：引擎是假的，时间是假的，只有被测的那层是真的。
 * 真耳朵（Edge 那个）唯一能在无头里验到的是失败路径——那一条在冒烟测试里（点了按钮要说出原因）。
 *
 * 跑：node tools/brain-test/asr-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHearing, STATES } from '../../js/brain/hearing.mjs';
import { createChatIn } from '../../js/brain/chat-in.mjs';
import { createMemory } from '../../js/brain/memory.mjs';

const LIFE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name,
  `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

/* 假引擎 + 假时间。
 * 时间必须能捏在手里：这一层唯一和"过了多久"有关的是"重开间隔"，
 * 用真 setTimeout 测它就得 sleep，而 sleep 会让这类测试变慢、变飘（CI 上一慢就红）。 */
function rig(opts = {}) {
  const made = [];
  const timers = [];
  const said = [], partials = [], states = [];
  let seq = 0, clock = 1000;

  const make = () => {
    const e = {
      lang: '', continuous: false, interimResults: false, maxAlternatives: 0,
      starts: 0, aborts: 0, start() { this.starts += 1; }, abort() { this.aborts += 1; },
    };
    made.push(e);
    return e;
  };

  const hearing = createHearing({
    make: opts.make === undefined ? make : opts.make,
    now: () => clock,
    schedule: (fn, ms) => { const id = ++seq; timers.push({ id, ms, fn }); return id; },
    cancel: (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    onSaid: m => { said.push(m); opts.onSaid?.(m); },
    onPartial: p => { partials.push(p); opts.onPartial?.(p); },
    onState: s => { states.push(s.state); opts.onState?.(s); },
    ...(opts.extra || {}),
  });

  return {
    hearing, made, timers, said, partials, states,
    get clock() { return clock; },
    tick(ms) { clock += ms; },
    runTimers() { for (const t of timers.splice(0)) t.fn(); },
    get eng() { return made[made.length - 1]; },
    onstart() { this.eng.onstart?.(); return this; },
    /* 引擎给一批结果。list = [[文本, 是不是整句], …]，index = resultIndex。
     * 真 API 里 results 是**全部**结果、resultIndex 是"这一批从第几条开始变"，
     * 所以 A4 要能明确地给出 index——从 0 开始遍历的实现会在这里露馅。 */
    results(list, index = 0) {
      const rs = list.map(([t, fin]) => Object.assign([{ transcript: t, confidence: 1 }], { isFinal: !!fin }));
      this.eng.onresult?.({ resultIndex: index, results: rs });
      return this;
    },
    end() { this.eng.onend?.(); return this; },
    error(code) { this.eng.onerror?.({ error: code, message: '' }); return this; },
  };
}

const keys = o => Object.keys(o).sort();

/* ============================================================
   A. 只交整句
   ============================================================ */
console.log('\nA. 只交整句（半句给人看，整句才进门）');

{
  const r = rig();
  r.hearing.start();
  eq(r.made.length, 1, 'A1 start() 造一个引擎');
  const e = r.eng;
  ok(e.lang === 'zh-CN' && e.continuous === true && e.interimResults === true && e.maxAlternatives === 1,
    'A2 引擎参数：中文、continuous、要半句、只要一个候选',
    `lang=${e.lang} cont=${e.continuous} interim=${e.interimResults} n=${e.maxAlternatives}`);
  ok(r.hearing.status().state === 'asking', 'A3 还没 onstart 之前是 asking（不是"在听"）');

  r.onstart();
  ok(r.hearing.status().state === 'listening', 'A4 onstart 之后才是 listening');

  r.results([['把顶灯', false]]);
  eq(r.said.length, 0, 'A5 半句不出门');
  ok(r.partials.at(-1) === '把顶灯', 'A6 半句只给他看（"在听…"），不进记忆');

  r.results([['把顶灯关掉', true]]);
  eq(r.said.length, 1, 'A7 整句出一次');
  eq(r.said[0], { text: '把顶灯关掉', source: 'voice' }, 'A8 形状就是 { text, source:\'voice\' }，没有第三个键');
  eq(keys(r.said[0]), ['source', 'text'], 'A9 键是白名单重建的，不是"顺手删掉音频"');
}

{
  const r = rig(); r.hearing.start(); r.onstart();
  /* 引擎攒着一起给：他连着说了两句，中间没停。这是两句，不是一句。 */
  r.results([['把灯关掉', true], ['然后过来', true]]);
  eq(r.said.map(s => s.text), ['把灯关掉', '然后过来'], 'A10 一个事件里两句整句 = 两条，不合并');
}

{
  const r = rig(); r.hearing.start(); r.onstart();
  /* resultIndex=1 表示"前一条没变"。从 0 开始遍历的实现会把第一句再说一遍，
   * 表现是她以为你把同一句话说了三遍。 */
  r.results([['把灯关掉', true], ['把灯关掉', true], ['把灯打开', true]], 2);
  eq(r.said.map(s => s.text), ['把灯打开'], 'A11 只处理 resultIndex 之后的那几条');
}

{
  const r = rig(); r.hearing.start(); r.onstart();
  r.results([['', true]]);
  r.results([['。', true]]);
  r.results([['   ', true]]);
  eq(r.said.length, 0, 'A12 空串、纯标点、纯空白都不是一句话');
  /* 空串在"读结果"那一层就被跳过了（transcript 为空不构成一条结果），
   * 所以进到 emit 的只有"纯标点"和"纯空白"两种；两种都要记下来，不许静默丢。 */
  eq(r.hearing.stats().empty, 2, 'A13 挡下来的记在 empty 里（不是静默丢掉）');
}

{
  const r = rig(); r.hearing.start(); r.onstart();
  /* 引擎的事件里带着音频（有的实现带 confidences / 有的带原始数据）。
   * 白名单的意义就在这里：它带什么进来都不重要，出去的只有两个键。 */
  r.eng.onresult?.({
    resultIndex: 0,
    audio: new Uint8Array([1, 2, 3]),
    results: [Object.assign([{ transcript: '关灯' }], { isFinal: true })],
  });
  eq(keys(r.said[0]), ['source', 'text'], 'A14 事件里带音频也传不出去');
}

{
  const r = rig(); r.hearing.start(); r.onstart();
  r.results([['把灯关掉', true]]);
  r.tick(30000);
  r.runTimers();
  eq(r.said.length, 1, 'A15 过了 30 秒也不会凭空多出一句（没有"沉默定稿"这回事）');
}

{
  const r = rig(); r.hearing.start(); r.onstart();
  r.error('no-speech');
  eq(r.said.length, 0, 'A16 no-speech 不出句子');
  eq(r.hearing.status().state, 'listening', 'A17 no-speech 不算断线：还接着听');
  eq(r.hearing.stats().errors, 0, 'A18 它也不算错（算错的话，她安静坐着的时候就会一直弹红字）');
}

/* ============================================================
   B. 开关与状态
   ============================================================ */
console.log('\nB. 开关与状态');

{
  const r = rig();
  eq(r.hearing.status().state, 'off', 'B1 一开始是 off');
  ok(r.hearing.describe() === '没在听', 'B2 describe 说人话', r.hearing.describe());
  r.hearing.start();
  r.hearing.start();
  eq(r.made.length, 1, 'B3 连按两次只造一个引擎（不会两个实例抢一个麦克风）');
  ok(r.hearing.start().already === true, 'B4 第二次 start 明确说"已经开着"');
}

{
  const r = rig(); r.hearing.start(); r.onstart();
  r.hearing.stop();
  eq(r.eng.aborts, 1, 'B5 stop 用 abort 而不是 stop（关麦克风的意思是"现在起一个字都别进来"）');
  eq(r.hearing.status().state, 'off', 'B6 stop 之后是 off');
  r.results([['关掉了吗', true]]);
  eq(r.said.length, 0, 'B7 关掉之后还在路上的结果一条都不进（不然就是偷听）');
  r.end();
  eq(r.timers.length, 0, 'B8 关掉之后不会偷偷把引擎接回来');
}

{
  const r = rig(); r.hearing.start();
  r.error('not-allowed');
  eq(r.hearing.status().state, 'denied', 'B9 权限被拒是 denied');
  eq(r.hearing.status().want, false, 'B10 权限被拒就停了，不自己重试');
  ok(/权限/.test(r.hearing.status().reason), 'B11 原因说人话（不是 not-allowed 四个字母）',
    r.hearing.status().reason);
  r.end();
  eq(r.timers.length, 0, 'B12 被拒之后连"重开"都不排——每秒弹一次权限框等于逼他点同意');
  eq(r.hearing.start().ok !== false, true, 'B13 他自己再点一次，还是可以再试（决定权在他）');
}

{
  const r = rig({ extra: { maxFails: 3 } });
  r.hearing.start();
  r.error('audio-capture'); r.error('audio-capture'); r.error('audio-capture');
  eq(r.hearing.status().state, 'error', 'B14 连着错到上限就自己关掉');
  eq(r.hearing.status().want, false, 'B15 关掉就是关掉（不是"亮着但没在听"）');
  ok(/试了 3 次/.test(r.hearing.status().reason), 'B16 并且说出来试过几次（静默重试看起来像"在听"）',
    r.hearing.status().reason);
}

{
  const r = rig({ make: null });
  const res = r.hearing.start();
  eq(res.ok, false, 'B17 没有这个 API 时 start 返回 ok:false（不装样子）');
  eq(r.hearing.status().state, 'unsupported', 'B18 状态是 unsupported');
  ok(/浏览器/.test(r.hearing.status().reason), 'B19 原因是"这个浏览器听不了"，不是空白', r.hearing.status().reason);
  eq(r.hearing.start().ok, false, 'B20 再点还是 false（不会偷偷去装一个）');
}

{
  /* 七个状态都要能翻译成人话：界面上给用户看的只有这个字符串。 */
  const r = rig();
  const seen = new Set();
  r.hearing.start(); seen.add(r.hearing.status().state);
  r.onstart(); seen.add(r.hearing.status().state);
  r.end(); seen.add(r.hearing.status().state);
  r.hearing.stop(); seen.add(r.hearing.status().state);
  const d = [r.hearing.describe()];
  const r2 = rig({ make: null }); r2.hearing.start(); d.push(r2.hearing.describe());
  const r3 = rig(); r3.hearing.start(); r3.error('not-allowed'); d.push(r3.hearing.describe());
  ok(d.every(s => typeof s === 'string' && s.length >= 3), 'B21 每种状态的 describe 都不是空话', d.join(' / '));
  ok(STATES.includes('waiting') && STATES.length === 7, 'B22 状态表是七个，含 waiting（那几百毫秒她其实听不见）');
}

/* ============================================================
   C. 自己续听
   ============================================================ */
console.log('\nC. 引擎会自己断，断了要接回来');

{
  const r = rig(); r.hearing.start(); r.onstart();
  r.tick(5000);                       // 听了一会儿，引擎自己收尾（Edge 的 continuous 到点就断）
  r.end();
  eq(r.timers.length, 1, 'C1 引擎自己 end 之后排了一次重开');
  eq(r.hearing.status().state, 'waiting', 'C2 这个空档叫 waiting，不叫 listening（那会儿真听不见）');
  ok(r.timers[0].ms === 400, 'C3 正常收尾按 400 毫秒接回来', String(r.timers[0].ms));
  r.runTimers();
  eq(r.made.length, 2, 'C4 接回来了（新实例）');
}

{
  const r = rig(); r.hearing.start(); r.onstart();
  r.tick(100);                        // 刚起步 100 毫秒就结束 = 引擎在空转
  r.end();
  /* 第一次"刚起步就结束"就已经退了一级：间隔 = 400 × 2^连续快速结束次数。
   * 从 400 起步其实也一样——第一次排 400，跑起来又秒断，下一次才翻倍，
   * 这里按"排的时候就已经算过这一级"写，省一个状态位。 */
  const d1 = r.timers[0].ms;
  r.runTimers(); r.onstart(); r.tick(100); r.end();
  const d2 = r.timers[0].ms;
  r.runTimers(); r.onstart(); r.tick(100); r.end();
  const d3 = r.timers[0].ms;
  ok(d1 === 800 && d2 === 1600 && d3 === 3200, 'C5 连着"刚起步就结束"时间隔翻倍（800→1600→3200）',
    `${d1}/${d2}/${d3}`);
  for (let i = 0; i < 6; i++) { r.runTimers(); r.onstart(); r.tick(50); r.end(); }
  ok(r.timers.at(-1).ms === 4000, 'C6 翻倍到 4 秒为止（不然半夜能烧一整夜 CPU）', String(r.timers.at(-1).ms));
}

{
  const r = rig(); r.hearing.start(); r.onstart();
  r.results([['把灯关掉', true]]);     // 有内容回来了
  r.tick(5000); r.end();
  ok(r.timers.at(-1).ms === 400, 'C7 听见过东西之后退避清零（下一次正常 400）', String(r.timers.at(-1).ms));
}

{
  const r = rig(); r.hearing.start(); r.onstart();
  r.tick(100); r.end();                // 排了一次重开
  r.hearing.stop();                    // 他这时候决定不听了
  eq(r.timers.length, 0, 'C8 关掉会撤掉挂着的重开');
  r.runTimers();
  eq(r.made.length, 1, 'C9 撤掉的就不会再执行（关掉之后麦克风不许自己亮起来）');
}

/* ============================================================
   D. 一路走到 chat-in 和记忆
   ============================================================ */
console.log('\nD. 一路走到 chat-in 和记忆');

{
  const heard = [], batches = [];
  const loop = { hear: o => { heard.push(o); return { ok: true, heard: true }; } };
  const chatIn = createChatIn({ loop, policy: 'every', onBatch: b => batches.push(b) });

  /* 页面里就是这么接的：引擎给一句 → 直接进 chat-in 的 voice 来源。
   * 中间没有"要不要回"的判断——那是她的事。 */
  const r = rig({ onSaid: m => chatIn.receive({ ...m, from: 'him', name: '你' }) });
  r.hearing.start(); r.onstart();
  r.results([['把顶灯关掉', true]]);

  eq(heard.length, 1, 'D1 一句话进 chat-in 一次');
  eq(heard[0], { text: '把顶灯关掉', from: 'him', name: '你', source: 'voice' },
    'D2 记忆里拿到的是原文 + 来源 voice（不是"音频"、不是"识别结果对象"）');
  eq(chatIn.stats().got, 1, 'D3 chat-in 记账：收到 1 条');
  eq(chatIn.stats().batches, 1, 'D4 policy=every 时立刻给她看一眼（语音是整句，不用攒批）');

  r.results([['把顶灯关掉', true]]);
  eq(heard.length, 1, 'D5 同一句再说一遍还是只记一条（去重是 chat-in 的事，不是 ASR 的事）');
  eq(chatIn.stats().merged, 1, 'D6 但次数记下来了（"这话他说了两遍"本身是事实）');
}

{
  /* 真 memory：source 必须真的落到 events.jsonl 那一行里。 */
  const mem = new Map();
  const store = {
    read: n => mem.get(n) ?? '',
    write: (n, t) => { mem.set(n, t); },
    append: (n, t) => { mem.set(n, (mem.get(n) || '') + t); },
  };
  const m = createMemory({ store, now: () => 1700000000000 });
  const e1 = m.record({ who: 'him', kind: 'said', text: '把灯关掉', source: 'voice' });
  const e2 = m.record({ who: 'him', kind: 'said', text: '把灯关掉' });
  eq(e1.source, 'voice', 'D7 带 source 的事件有这个字段');
  ok(!('source' in e2), 'D8 不带 source 的事件没有这个键（旧记录的形状不变）');
  const disk = mem.get('events.jsonl');
  ok(disk.includes('"source":"voice"'), 'D9 落盘那一行里真的有 source（不是只在内存对象上）');
  ok(!disk.split('\n')[1].includes('source'), 'D10 第二行（没带的）一个 source 都不该有');
}

/* ============================================================
   E. 源码契约
   ============================================================ */
console.log('\nE. 源码契约（这几条防的是"以后有人图省事"）');

/* 只看代码，不看注释：注释里写"我们不碰 MediaRecorder"这件事本身是对的，
 * 但不该把检查弄成"提都不能提"。 */
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

{
  const src = fs.readFileSync(path.join(LIFE, 'js/brain/hearing.mjs'), 'utf8');
  const code = stripComments(src);
  ok(/webkitSpeechRecognition/.test(code) && /SpeechRecognition/.test(code),
    'E1 耳朵就是浏览器的那个（Edge/Chrome 自带）');
  ok(/lang = 'zh-CN'/.test(code), 'E2 默认听中文');
  ok(/continuous = true/.test(code) && /interimResults = true/.test(code),
    'E3 continuous + interim 都开了（关了就变成"说一句就断，还得重新点一下"）');
  ok(!/MediaRecorder|AudioContext|getUserMedia|MediaStream|ArrayBuffer/.test(code),
    'E4 代码里没有一件音频 API：音频在浏览器里就变成字了，这一层不碰它');
  /* 这一条是本组的核心：能把半句定稿的计时器，一个都不许有。 */
  const timeouts = (code.match(/setTimeout/g) || []).length;
  ok(timeouts === 1, 'E5 全文只有一个 setTimeout（重开间隔），没有第二个能拿时间断句的地方',
    `找到 ${timeouts} 个`);
  ok(!/setInterval|requestAnimationFrame/.test(code), 'E6 也没有别的时间循环');
}

{
  const page = fs.readFileSync(path.join(LIFE, '预览-66.html'), 'utf8')
    + '\n' + fs.readFileSync(path.join(LIFE, 'js/room/world.mjs'), 'utf8');
  ok(/createHearing/.test(page), 'E7 页面用的是这个模块（不是自己写一份）');
  ok(!/new\s+(webkit)?SpeechRecognition/.test(page), 'E8 页面里没有第二处自己 new 引擎');
  ok(/source:\s*'voice'/.test(page), 'E9 语音进 chat-in 时带着 source:voice（不然事后分不清是不是听错了）');
  ok(/chatIn\.receive\(\{[^}]*source:\s*'voice'/.test(page), 'E10 走的是 chat-in 这个入口，不是直接 send()');
  const heard = page.slice(page.indexOf('function heardFromMic'), page.indexOf('function micPaint'));
  ok(/stopSpeak\(\)/.test(heard) && /live\.abort\(\)/.test(heard),
    'E11 她在说话时他开口：先停嘴、再作废流里的半句（反射，不是她的决定）');
  ok(/recorded:\s*true/.test(heard), 'E12 打断时不重复记这句话（chat-in 已经记过了）');
  ok(/chatIn\.flush\(\)/.test(heard), 'E13 整句不等 1.2 秒的攒批窗口（那是给弹幕刷屏用的）');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
