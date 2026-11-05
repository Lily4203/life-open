/* 主干的回归测试：不起浏览器、不连网
 * ------------------------------------------------------------
 * 用假的 chat 和假的房间，只验"这条线"本身：
 *   记 → 装 → 问 → 做 → 回写，以及四件最容易坏的事
 *   （解析失败、动作没成、预算不够、重启之后还认不认得）。
 *
 * 跑：node tools/brain-test/loop-test.mjs
 */
import { createRegistry } from '../../js/brain/actions.mjs';
import { createMemory } from '../../js/brain/memory.mjs';
import { createLoop } from '../../js/brain/loop.mjs';
import { createInitiative } from '../../js/brain/initiative.mjs';
import { buildSystem, parseOut } from '../../js/brain/prompt.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(a === b, name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

/* ---- 内存版 store，形状和 memory.mjs 要的一致 ---- */
function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    read: n => m.get(n) ?? '',
    write: (n, t) => { m.set(n, t); },
    append: (n, t) => { m.set(n, (m.get(n) || '') + t); },
    dump: () => Object.fromEntries(m),
  };
}

/* ---- 假房间：两个动作，一个一定失败 ---- */
function room() {
  const R = createRegistry();
  const log = [];
  R.registerAll([
    {
      name: 'go_to', description: '走到某件家具旁边', intent: '走过去',
      schema: { target: { type: 'entity', kinds: ['chair', 'bed'] } },
      run: async (w, { target }) => { log.push(target); return { ok: true, effect: '到了' }; },
    },
    {
      name: 'use_furniture', description: '坐下或躺下', intent: '坐下或躺下',
      schema: { target: { type: 'entity', kinds: ['chair', 'bed'] } },
      run: async (w, { target }) => {
        if (target === 'chair:9') return { ok: false, reason: 'no_such_thing', message: '屋里没有这件东西' };
        log.push(target); return { ok: true, effect: target.startsWith('bed') ? '躺下了' : '坐下了' };
      },
    },
  ]);
  return { R, log };
}

const IDENTITY = '你叫小鱼。\n一句一行，几个字。\n他不在这个屋里。';
const baseStore = () => memStore({ 'identity.md': IDENTITY });

console.log('\nA. 一轮完整的 turn');

{
  const store = baseStore();
  const memory = createMemory({ store, charId: 'fish' });
  memory.load();
  const { R, log } = room();
  const seen = [];
  const chat = async ({ system, messages }) => {
    seen.push({ system, messages });
    return { content: '{"say":"椅子在那边。","do":[{"do":"use_furniture","to":"chair:1"}]}', usage: { total_tokens: 100 } };
  };
  const loop = createLoop({ memory, registry: R, chat });
  const r = await loop.turn({ text: '你去椅子上坐会儿', world: { pose: '站在屋子中间' } });

  ok(r.ok, 'A1 turn 成功');
  eq(r.say, '椅子在那边。', 'A2 话解析出来了');
  eq(log[0], 'chair:1', 'A3 动作真执行了（屋子收到的是 id，不是坐标）');
  eq(r.results[0].text, '你坐下了', 'A4 回执是写给她自己读的事实，不是动作码');

  const sys = seen[0].system;
  ok(sys.includes('你叫小鱼'), 'A5 身份进了系统消息');
  ok(sys.includes('go_to'), 'A6 动作表进了系统消息');
  ok(sys.includes('"do"'), 'A7 输出契约写在最后');
  ok(!sys.includes('（这间屋子暂时没给你动作'), 'A8 有动作时不显示空表');

  eq(seen[0].messages.at(-1).role, 'user', 'A9 最后一条是他的话');
  /* 时间戳是**加的**，不是改写：原话必须一字不动地留在后面。
   * 为什么要加：只给相对时间的话，翻回昨天那条就分不清是哪天说的。 */
  ok(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] 你去椅子上坐会儿$/.test(seen[0].messages.at(-1).content),
    'A10 原话没被改写（只许前面加时间戳）');

  const kinds = memory.events().map(e => `${e.who}/${e.kind}`);
  eq(kinds.join(','), 'him/said,fish/did,fish/said', 'A11 落盘顺序：他说 → 她做 → 她说');
  ok(store.dump()['events.jsonl'].split('\n').filter(Boolean).length === 3, 'A12 三条都在文件里（不只是内存）');
}

console.log('\nB. 模型不听话的三种回法');

{
  const parseCases = [
    ['```json\n{"say":"好","do":[]}\n```', 'B1 代码围栏能剥'],
    ['我坐下了。', 'B2 纯文本不崩'],
    ['{"say":"嗯","do":[{"name":"go_to","args":{"target":"bed:1"}}]}', 'B3 长写法也认'],
  ];
  const { R } = room();
  const r1 = parseOut(parseCases[0][0], { registry: R });
  eq(r1.say, '好', parseCases[0][1]);
  const r2 = parseOut(parseCases[1][0], { registry: R });
  eq(r2.say, '我坐下了。', parseCases[1][1]);
  eq(r2.do.length, 0, 'B2b 没有 do 就不动');
  const r3 = parseOut(parseCases[2][0], { registry: R });
  eq(r3.do[0].args.target, 'bed:1', parseCases[2][1]);
  const r4 = parseOut('{"say":"我先看看","do":[{"do":"go_to","to":"chair:2"},{"do":"use_furniture","to":"bed:3"}]}', { registry: R });
  eq(r4.do.length, 2, 'B4 两个动作都留下');
  const r5 = parseOut('{"say":"走","do":[{"do":"go_to","to":"chair:2"},{"do":"x","to":"1"},{"do":"y"}]}', { registry: R });
  eq(r5.do.length, 2, 'B5 超过两个就截断');
  // 同时有 to 和目标状态时，to 仍要落到 target 上（这条曾经因为"其它参数非空"被跳过）
  const r6 = parseOut('{"say":"开","do":[{"do":"use_furniture","to":"bed:1","x":"y"}]}', { registry: R });
  eq(r6.do[0].args.target, 'bed:1', 'B6 to 和其它参数同时出现，target 不丢');
}

console.log('\nC. 动作没成的时候');

{
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const { R, log } = room();
  const chat = async () => ({ content: '{"say":"我坐这儿。","do":[{"do":"use_furniture","to":"chair:9"},{"do":"go_to","to":"bed:1"}]}' });
  const loop = createLoop({ memory, registry: R, chat });
  const r = await loop.turn({ text: '坐吧' });

  eq(r.results.length, 1, 'C1 第一步没成就不再走第二步（不许连坐）');
  eq(r.results[0].ok, false, 'C2 失败被记下来');
  eq(log.length, 0, 'C3 屋子一次都没真动');
  ok(memory.events().some(e => e.kind === 'did' && e.text.includes('没成')), 'C4 事件流里如实写"没成"');
  /* 失败的回执必须是"你想做什么 + 为什么没成"，不是 reason 码。
   * 为什么较真这一个字：她下一轮读的就是这句话；写成 `use_furniture 没成（no_such_thing）`，
   * 她读到的是"我做了一个动作"，于是会顺着自己的旧话继续说"我已经坐下了"。 */
  ok(/^你想坐下或躺下，但没成：屋里没有这件东西$/.test(r.results[0].text),
    'C6 失败写成她读得懂的一句：想做什么、为什么没成', r.results[0].text);
  eq(r.say, '我坐这儿。', 'C5 话还是让她说了');
}

console.log('\nD. 上下文预算');

{
  const long = '这一句很长。'.repeat(300);              // 约 1800 字，超过 1400 的预算
  // 用 did 而不是 said：现在"最近发生"只装事实，不装她自己的话（否则她会把自己的话当既成事实读回来）
  const store = memStore({ 'identity.md': IDENTITY, 'events.jsonl': JSON.stringify({ id: 'e1', seq: 1, at: Date.now() - 3600e3, who: 'fish', kind: 'did', text: long, salience: 1, told: false, recallCount: 0 }) + '\n' });
  const memory = createMemory({ store });
  memory.load();
  const boot = memory.boot({ cue: '' });
  ok(boot.chars <= 1400, 'D1 不超预算', 'chars=' + boot.chars);
  ok(boot.blocks.some(b => b.id === 'boot.identity'), 'D2 身份块永远在');
  ok(boot.dropped.length > 0, 'D3 超了要如实报丢了哪块');
  const { R } = room();
  const sys = buildSystem({ boot, registry: R });
  ok(sys.length > 0 && sys.length < 3000, 'D4 系统消息没有膨胀', 'len=' + sys.length);
}

console.log('\nE. 重启之后');

{
  const store = baseStore();
  const m1 = createMemory({ store });
  m1.load();
  const { R } = room();
  const chat = async () => ({ content: '{"say":"记住椅子了。","do":[{"do":"use_furniture","to":"chair:1"}]}' });
  const loop1 = createLoop({ memory: m1, registry: R, chat });
  await loop1.turn({ text: '记住这把椅子', world: { pose: '坐' } });

  // 换一个进程相当于新建 memory，但 store 是同一份（这里是同一份文件）
  const m2 = createMemory({ store });
  const load = m2.load();
  ok(load.events === 3, 'E1 重启后事件还在', 'events=' + load.events);
  const hits = m2.recall('椅子', { k: 3 });
  ok(hits.length > 0, 'E2 按"椅子"能检索回来');
  ok(hits[0].why.includes('椅子'), 'E3 检索结果带命中词', JSON.stringify(hits[0]?.why));
  const boot = m2.boot({ cue: '椅子' });
  const text = boot.blocks.map(b => b.text).join('\n');
  ok(text.includes('椅子'), 'E4 开机上下文里真有那条');
  ok(boot.blocks.some(b => b.id === 'boot.now'), 'E5 有"上次你在这里是…"（时间由系统注入）');
}

console.log('\nF. 唤醒：没有事就不花钱');

{
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const { R } = room();
  let calls = 0;
  const chat = async () => { calls++; return { content: '{"say":"我把灯关了","do":[{"do":"go_to","to":"chair:1"}]}' }; };
  const ini = createInitiative();
  const loop = createLoop({ memory, registry: R, chat, initiative: ini });

  const w0 = await loop.wake();
  eq(calls, 0, 'F1 没有待办时一次模型都不调');
  eq(w0.cost, 0, 'F2 成本是 0');

  ini.raise({ reason: 'unseen', target: 'lamp:1', detail: '刚才灯自己灭了一下，没人看见', candidates: ['go_to'] });
  const w1 = await loop.wake();
  eq(calls, 1, 'F3 有事才叫模型');
  ok(w1.acted, 'F4 她动了');
  eq(w1.do[0].name, 'go_to', 'F5 只用候选里的动作');

  ini.raise({ reason: 'repeat', target: 'chair:1', detail: '第二次被关灯', candidates: ['go_to'] });
  const before = calls;
  const w2 = await loop.wake();
  eq(w2.do.length, 1, 'F6 第二条也能派出去');
  eq(calls, before + 1, 'F7 一次唤醒只问一次');

  const s = loop.stats();
  eq(s.wakes, 3, 'F8 唤醒计数');
  eq(s.wakesWithModel, 2, 'F9 调模型的只有 2 次 —— 唤醒≠决定');
}

console.log('\nG. 同一秒里的两条议程不会互相覆盖');

{
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const a = memory.addAgenda({ text: '把椅子挪一点' });
  const b = memory.addAgenda({ text: '看看窗外' });
  ok(a.id !== b.id, 'G1 id 不撞');
  eq(memory.openAgenda().length, 2, 'G2 两条都在');
}

console.log('\nH. 记忆由她自己查、自己写（不再由我们挑三条塞进去）');

{
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const pre = memory.writeMem({ desc: '椅子被挪到窗边了', body: '十一月五日晚上他说那里有光，她就把椅子推过去了。' });
  const { R } = room();
  const seen = [];
  const chat = async ({ system, messages }) => {
    seen.push({ system, messages });
    if (seen.length === 1) return { content: `{"say":"","read":["${pre.entry.id}"],"do":[]}` };
    return { content: '{"say":"那我把窗帘拉上。","do":[]}' };
  };
  const loop = createLoop({ memory, registry: R, chat });
  const r = await loop.turn({ text: '窗边晒得我难受' });

  ok(seen[0].system.includes(pre.entry.id), 'H1 索引（id + 一句话）进了系统消息');
  ok(!seen[0].system.includes('她就把椅子推过去了'), 'H2 正文不在第一遍里（要读才给）');
  eq(seen.length, 2, 'H3 她说要看，就真去取了再问一次');
  ok(seen[1].system.includes('她就把椅子推过去了'), 'H4 第二遍拿到了正文');
  eq(r.say, '那我把窗帘拉上。', 'H5 用第二遍的话（第一遍只有 read）');
  eq(loop.stats().reads, 1, 'H6 读取次数记上了');
}

{
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const { R } = room();
  let calls = 0;
  // 第二遍还在 read：必须停在两次，不能无限读下去
  const chat = async () => { calls++; return { content: '{"say":"","read":["m1"],"do":[]}' }; };
  memory.writeMem({ desc: '灯很烫', body: '别一直开着。' });
  const loop = createLoop({ memory, registry: R, chat });
  await loop.turn({ text: '把灯打开' });
  eq(calls, 2, 'H7 一次对话最多读一轮（不许套娃）');
}

{
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const { R } = room();
  const chat = async () => ({ content: '{"say":"记住了。","remember":[{"id":null,"desc":"他周三要去外地","body":"下周三走，去三天。他说别问去哪。"}],"do":[]}' });
  const loop = createLoop({ memory, registry: R, chat });
  const r = await loop.turn({ text: '我下周三要出差三天，你别问去哪' });

  eq(memory.memories().length, 1, 'H8 她说记住，就真存下了');
  ok(memory.memories()[0].body.includes('别问去哪'), 'H9 正文存对了');
  eq(r.memory.remembered.length, 1, 'H10 回执里有这一条');
  ok(memory.boot({}).blocks.find(b => b.id === 'boot.memindex').text.includes('他周三要去外地'), 'H11 下次开机索引里就有');
  ok(memory.events().some(e => e.kind === 'memory'), 'H12 记这件事本身也进了事件流');
}

{
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const a = memory.writeMem({ desc: '他讨厌猫', body: '他说过讨厌猫。' });
  const { R } = room();
  const chat = async () => ({ content: `{"say":"我记混了，忘掉吧。","forget":["${a.entry.id}"],"do":[]}` });
  const loop = createLoop({ memory, registry: R, chat });
  await loop.turn({ text: '我什么时候说讨厌猫了' });
  eq(memory.memories().length, 0, 'H13 她说忘，就真忘了');
  eq(loop.stats().forgets, 1, 'H14 忘的次数记上了');
}

{
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const { R } = room();
  // 没写正文：不许存空条目，也不许把整轮搞崩
  const chat = async () => ({ content: '{"say":"嗯","remember":[{"desc":"只有一句话没正文"}],"do":[]}' });
  const loop = createLoop({ memory, registry: R, chat });
  const r = await loop.turn({ text: '记住这个' });
  ok(r.ok, 'H15 空正文不崩');
  eq(memory.memories().length, 0, 'H16 空正文不存');
  ok(r.memory.notes.length === 1, 'H17 要回一句人话，不能悄悄失败');
}

{
  /* 他在她想的时候又说了一句：原来是 {reason:'busy'} 直接丢掉，等于她被叫了两次只应一次。 */
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const { R } = room();
  let calls = 0, release;
  const gate = new Promise(r => { release = r; });
  const chat = async () => { calls++; if (calls === 1) await gate; return { content: '{"say":"嗯。","do":[]}' }; };
  const loop = createLoop({ memory, registry: R, chat });

  const p1 = loop.turn({ text: '第一句' });
  await new Promise(r => setTimeout(r, 5));
  const r2 = await loop.turn({ text: '第二句' });
  eq(r2.queued, true, 'H18 忙的时候先收下，不是丢掉');
  release();
  await p1;
  await new Promise(r => setTimeout(r, 60));
  eq(calls, 2, 'H19 这一轮完了接着跑那一句');
  ok(memory.events().some(e => e.kind === 'said' && e.who === 'him' && e.text === '第二句'), 'H20 第二句进了事件流');
}

console.log('\nI. 她没按格式回的时候');

{
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const { R, log } = room();
  const seen = [];
  // 真跑时出现过这句：话说得对，但不是 JSON，我们收不到 read，她以为查了其实没查
  const chat = async ({ messages }) => {
    seen.push(messages);
    if (seen.length === 1) return { content: '我去翻翻原文。' };
    return { content: '{"say":"翻到了，你说怕黑。","do":[]}' };
  };
  const loop = createLoop({ memory, registry: R, chat });
  const r = await loop.turn({ text: '你还记得那件事吗' });

  eq(seen.length, 2, 'I1 格式不对要重发一次，不是把散文当话说出去');
  ok(seen[1].some(m => m.role === 'user' && m.content.includes('只发一个 JSON')), 'I2 重发时明确告诉她错在哪');
  eq(r.say, '翻到了，你说怕黑。', 'I3 用重发那一遍的结果');
  ok(r.retried, 'I4 这一轮标记了重发过');
  ok(!r.parseError, 'I5 重发成功后不该再报解析错误');
}

{
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const { R } = room();
  let calls = 0;
  // 两次都不是 JSON：不能崩、不能无限重发，原话当话说出去（宁可少动一下）
  const chat = async () => { calls++; return { content: '嗯。' }; };
  const loop = createLoop({ memory, registry: R, chat });
  const r = await loop.turn({ text: '在吗' });
  eq(calls, 2, 'I6 只重发一次');
  eq(r.say, '嗯。', 'I7 还是不行就把原话留下');
  ok(r.stillBad, 'I8 如实标记：这轮没按格式来');
}

console.log('\nP. 议程：她自己写、自己划、重启还在');

{
  const store = baseStore();
  const memory = createMemory({ store });
  memory.load();
  const { R } = room();
  const chat = async () => ({ content: '{"say":"我想把窗台那盆花挪到有光的地方。","plan":[{"text":"把窗台那盆花挪到有光的地方","next":"先看看窗外有没有太阳"}],"do":[]}' });
  const loop = createLoop({ memory, registry: R, chat });
  const r = await loop.turn({ text: '今天太阳不错' });

  eq(r.agenda.planned.length, 1, 'P1 她说 plan，就真记下一条');
  const a = memory.openAgenda()[0];
  ok(a && a.id, 'P2 议程有 id（不然她划不掉）');
  ok(store.dump()['agenda.json'].includes('挪到有光的地方'), 'P3 落了盘，不是只在内存里');
  eq(a.next, '先看看窗外有没有太阳', 'P4 下一步也存住了');

  const B = createMemory({ store }); B.load();
  const blk = B.boot({ cue: '' }).blocks.find(x => x.id === 'boot.agenda');
  ok(blk, 'P5 重启后开机还看得见这件事');
  ok(blk.text.includes(a.id), 'P6 开机带 id，她能划');
  ok(/（[^）]*写下的）/.test(blk.text), 'P7 开机说得出"这是多久以前想的事"');
}

{
  const store = baseStore();
  const memory = createMemory({ store }); memory.load();
  const none = memory.boot({ cue: '' }).blocks.find(x => x.id === 'boot.agenda_none');
  ok(none, 'P8 手上没事时明确说"手上没事"（缺块她会去猜）');
  ok(/不必等人吩咐/.test(none.text), 'P9 这句话允许她自己找事，不是命令她找事');
}

{
  const store = baseStore();
  const memory = createMemory({ store }); memory.load();
  const a = memory.plan({ text: '看看窗外' });
  const { R } = room();
  const chat = async () => ({ content: `{"say":"看完了，外面在下雨。","done":["${a.id}"],"do":[]}` });
  const loop = createLoop({ memory, registry: R, chat });
  const r = await loop.turn({ text: '你刚才干嘛呢' });

  eq(r.agenda.done.length, 1, 'P10 done 生效');
  eq(memory.openAgenda().length, 0, 'P11 划掉了就不再挂着');
  ok(memory.events().some(e => e.kind === 'did' && e.text.includes('看看窗外')), 'P12 做完这件事进了事件流（自主的证据链）');
  const B = createMemory({ store }); B.load();
  ok(!B.boot({ cue: '' }).blocks.some(x => x.id === 'boot.agenda'), 'P13 重启后不再拿这件事问她');
}

{
  const store = baseStore();
  const memory = createMemory({ store }); memory.load();
  const { R } = room();
  const chat = async () => ({ content: '{"say":"好。","done":["a999"],"do":[]}' });
  const loop = createLoop({ memory, registry: R, chat });
  const r = await loop.turn({ text: '那件事不用做了' });
  eq(r.agenda.done.length, 0, 'P14 划不掉就是没划掉');
  ok(r.agenda.notes.some(n => n.includes('a999')), 'P15 告诉她手上没有这一条');
}

{
  const store = baseStore();
  const memory = createMemory({ store }); memory.load();
  const a = memory.plan({ text: '看看窗外' });
  memory.plan({ text: '看看窗外' });
  eq(memory.openAgenda().length, 1, 'P16 同一句话写两遍，只有一条');
  const b = memory.plan({ id: a.id, text: '看看窗外有没有太阳' });
  eq(b.id, a.id, 'P17 带 id 改的是同一条');
  eq(memory.openAgenda().length, 1, 'P18 改不会变成两条');
  eq(memory.openAgenda()[0].asks, 0, 'P18b 改内容不重置"问过几次"');
}

{
  const store = baseStore();
  const memory = createMemory({ store }); memory.load();
  memory.plan({ text: '看看窗外' });
  const { R } = room();
  let calls = 0;
  const chat = async () => { calls++; return { content: '{"say":"","do":[]}' }; };
  const loop = createLoop({ memory, registry: R, chat });
  for (let i = 0; i < 3; i++) await loop.wake({});
  const r4 = await loop.wake({});
  eq(calls, 3, 'P19 同一条议程最多自动问三次');
  eq(r4.reason, 'nothing_pending', 'P20 第四次不再花钱（她可以不做，但不能一直挂着）');
}

{
  const store = baseStore();
  const memory = createMemory({ store }); memory.load();
  const a = memory.plan({ text: '把花挪到有光的地方' });
  const { R } = room();
  const seen = [];
  const chat = async ({ system }) => { seen.push(system); return { content: '{"say":"","do":[]}' }; };
  const loop = createLoop({ memory, registry: R, chat });
  await loop.wake({});
  ok(seen[0].includes(a.id), 'P21 唤醒时告诉她这件事的 id（不然她划不掉）');
  ok(seen[0].includes('这次没人跟你说话'), 'P22 唤醒和对话用两套问法');
  ok(seen[0].includes('如果这件事是你自己记的'), 'P23 唤醒时告诉她不做可以划掉');
}

{
  const r = parseOut('{"say":"","plan":[{"text":"a"},{"text":"b"},{"text":"c"}],"do":[]}');
  eq(r.plan.length, 2, 'P24 一次最多记两条');
  const r2 = parseOut('{"say":"","done":"a1","do":[]}');
  eq(r2.done[0], 'a1', 'P25 done 写成单个字符串也认');
}

{
  /* 页面一定会传 initiative。原来的写法是 if (initiative) {...} else {议程}，
   * 于是议程永远走不到——她写下来的事一次都不会被执行。真跑抓到的（__WAKE 回 nothing_pending）。 */
  const store = baseStore();
  const memory = createMemory({ store }); memory.load();
  memory.plan({ text: '看看窗外' });
  const { R } = room();
  let calls = 0;
  const chat = async () => { calls++; return { content: '{"say":"","do":[]}' }; };
  const loop = createLoop({ memory, registry: R, chat, initiative: createInitiative() });
  const r = await loop.wake({});
  eq(calls, 1, 'P26 发起队列是空的，也要轮到议程（不然她写的事永远不执行）');
  eq(r.item.agendaId, memory.openAgenda()[0].id, 'P27 派发的是议程里那一条');
}

{
  /* 沉默和坏掉要分开记。两者在输出上都是"什么都没有"，
   * 但一个是她判断不用动（合法），一个是模型没答成人话（坏了）。
   * 混成一个数，调提示词时永远查不出是"太吵"还是"收不到"。 */
  const store = baseStore();
  const memory = createMemory({ store }); memory.load();
  memory.plan({ text: '看看窗外' });
  const { R } = room();
  const chat = async () => ({ content: '{"say":"","do":[]}' });
  const loop = createLoop({ memory, registry: R, chat, initiative: createInitiative() });
  const r = await loop.wake({});
  const st = loop.stats();
  eq(st.quiet, 1, 'P28 她选择不动，记成 quiet');
  eq(st.noOutput, 0, 'P29 quiet 不该被算成"没答出来"');
  eq(r.acted, false, 'P30 沉默不算做了事');
  eq(st.actions, 0, 'P31 沉默不该凭空记动作');
}

{
  const store = baseStore();
  const memory = createMemory({ store }); memory.load();
  memory.plan({ text: '看看窗外' });
  const { R } = room();
  const chat = async () => ({ content: '我看看外面。' });   // 人话，不是 JSON；ask 里会重发一次，还是同样的东西
  const loop = createLoop({ memory, registry: R, chat, initiative: createInitiative() });
  await loop.wake({});
  const st = loop.stats();
  eq(st.noOutput, 1, 'P32 解析不出话和动作，记成 noOutput');
  eq(st.quiet, 0, 'P33 坏了不能记成"她选择不说话"');
}

{
  /* 问满三次的议程不能再混进"手上还没做完的"。
   * 真跑抓到的：开机说"你手上还有两件事"，那两件已经问满、永远不会派发——
   * 她记着自己有活，却永远不做，也没人告诉她这两件已经凉了。 */
  const store = baseStore();
  const memory = createMemory({ store }); memory.load();
  const a = memory.plan({ text: '去把台灯关掉' });
  for (let i = 0; i < 3; i++) memory.noteAsked(a.id);
  const ids = memory.boot({ cue: '' }).blocks.map(x => x.id);
  ok(ids.includes('boot.agenda_stale'), 'P34 问满三次的议程要单独说');
  ok(!ids.includes('boot.agenda'), 'P35 凉了的不能再混进"手上还没做完的"');
  ok(!ids.includes('boot.agenda_none'), 'P36 有凉了的议程时，不能说"你手上没有正在做的事"');
  const blk = memory.boot({ cue: '' }).blocks.find(x => x.id === 'boot.agenda_stale');
  ok(blk.text.includes(a.id), 'P37 要带 id，否则她划不掉');
}

console.log('\nQ. 自主回合看得见自己刚说过什么');

{
  const memory = createMemory({ store: baseStore() });
  memory.load();
  const { R } = room();
  const seen = [];
  const chat = async ({ messages }) => {
    seen.push(messages || []);
    return { content: '{"say":"嗯。","do":[]}' };
  };
  const ini = createInitiative();
  const loop = createLoop({ memory, registry: R, chat, initiative: ini });

  await loop.turn({ text: '在吗' });
  ini.raise({ reason: 'signal', target: 'lamp:1', detail: '顶灯刚被关掉了。', candidates: ['go_to'] });
  await loop.wake();

  const msgs = seen.at(-1);
  /* 真日志里的病：三次自主回合都在说同一盏灯
   * （13:37:15「顶灯怎么灭了」13:37:30「顶灯怎么开着」13:38:39「灯还没关吗」），
   * 因为醒来那一轮 messages 是空的——她每次睁眼都不记得自己上一句说了什么。 */
  ok(msgs.length > 0, 'Q1 自主回合不再是一张白纸');
  ok(msgs.some(m => m.role === 'assistant'), 'Q2 里面真有她自己说过的话（不是只塞了他的）');
  ok(msgs.length <= 4, 'Q3 最多 4 条（两轮）：没事发生的时刻不该搬整段对话进来');

  const before = seen.length;
  ini.raise({ reason: 'signal', target: 'chair:1', detail: '椅子被挪了一下。', candidates: [] });
  await loop.wake();
  eq(seen.length, before + 1, 'Q4 仍然一次唤醒只问一次');
}

console.log(`\n${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
