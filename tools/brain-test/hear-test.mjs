/* 听见与打断：话有没有到、这一轮该不该停
 * ------------------------------------------------------------
 * 这一组只验"话的传递"，不验她想不想回：
 *   听见  = 话先落盘，她忙的时候也落；忙的话记一笔 owed，这一轮完了再接一句
 *   打断  = 只掐"正在想"的那一次请求；"正在做"不掐（要不要放下是她的事）
 *   自愈  = 锁卡死 90 秒后自动放开，且晚回来的那一轮不许把新的一轮放跑
 *
 * 跑：node tools/brain-test/hear-test.mjs
 */
import { createRegistry } from '../../js/brain/actions.mjs';
import { createMemory } from '../../js/brain/memory.mjs';
import { createLoop } from '../../js/brain/loop.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(a === b, name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    read: n => m.get(n) ?? '',
    write: (n, t) => { m.set(n, t); },
    append: (n, t) => { m.set(n, (m.get(n) || '') + t); },
  };
}

const IDENTITY = '你叫小鱼。\n一句一行，几个字。';
const mkMem = () => { const m = createMemory({ store: memStore({ 'identity.md': IDENTITY }), charId: 'fish' }); m.load(); return m; };

function room() {
  const R = createRegistry();
  const log = [];
  R.registerAll([{
    name: 'go_to', description: '走到某件家具旁边', intent: '走过去',
    schema: { target: { type: 'entity', kinds: ['chair'] } },
    run: async (w, { target }) => { log.push(target); return { ok: true, effect: '到了' }; },
  }]);
  return { R, log };
}

const settle = () => new Promise(r => setTimeout(r, 20));
const saidBy = (memory, who) => memory.events().filter(e => e.kind === 'said' && e.who === who);

/* ================= A. 听见：话先落盘 ================= */
console.log('\nA. 听见');
{
  const memory = mkMem();
  const { R } = room();
  let calls = 0;
  const loop = createLoop({ memory, registry: R, chat: async () => { calls++; return { content: '{"say":"嗯"}' }; } });

  const h = loop.hear({ text: '  在吗   我回来了 ', from: 'him' });
  ok(h.ok && h.heard, 'A1 hear 返回"听见了"');
  eq(calls, 0, 'A2 只是听见，不花模型调用');
  const ev = saidBy(memory, 'him');
  eq(ev.length, 1, 'A3 话已经落盘');
  eq(ev[0].text, '在吗 我回来了', 'A4 多空格压成一个，话本身不改');

  const empty = loop.hear({ text: '   ' });
  ok(!empty.ok && empty.reason === 'empty', 'A5 空话不算听见（不写一条空事件）');
  eq(saidBy(memory, 'him').length, 1, 'A6 空话没落盘');

  const long = loop.hear({ text: '啊'.repeat(900) });
  eq(long.ok && saidBy(memory, 'him')[1].text.length, 500, 'A7 超长的截到 500（数据库层的兜底，不靠上游自觉）');
  ok(loop.lastHeard.text.startsWith('啊啊'), 'A8 lastHeard 记着最后一句');
}

/* ================= B. 她在忙的时候听见 ================= */
console.log('\nB. 她正在想的时候他说话');
{
  const memory = mkMem();
  const { R } = room();
  let release;
  const gate = new Promise(r => { release = r; });
  const loop = createLoop({ memory, registry: R, chat: async () => { await gate; return { content: '{"say":"刚才在忙"}' }; } });

  const p = loop.turn({ text: '你在干嘛' });
  await settle();
  eq(loop.phase, 'thinking', 'B1 第一轮在"想"');
  const h = loop.hear({ text: '我跟你说个事', from: 'him' });
  ok(h.busy === true, 'B2 忙的时候听，返回 busy');
  eq(loop.owed(), true, 'B3 记下"欠一句"');
  eq(loop.stats().heardWhileBusy, 1, 'B4 忙的时候听见的次数单独记');

  /* hear 只听见，不掐：这一轮该跑完还是跑完 */
  release();
  const r = await p;
  ok(r.ok && r.say === '刚才在忙', 'B5 hear 不会掐断正在想的那一轮');
  eq(loop.takeOwed(), true, 'B6 欠的那一句可以被取走');
  eq(loop.takeOwed(), false, 'B7 取走之后不再欠');
}

/* ================= C. 打断：只掐"正在想" ================= */
console.log('\nC. 打断');
{
  const memory = mkMem();
  const { R } = room();
  const chat = ({ signal }) => new Promise((res, rej) => {
    signal?.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    });
  });
  const loop = createLoop({ memory, registry: R, chat });

  const p = loop.turn({ text: '讲个长故事' });
  await settle();
  const r1 = loop.interrupt({ text: '等一下，先听我说', from: 'him' });
  ok(r1.interrupted === true, 'C1 正在想的时候可以掐');
  eq(r1.reason, 'thinking', 'C2 掐的理由是"正在想"');
  const r2 = await p;
  ok(!r2.ok && r2.reason === 'interrupted', 'C3 这一轮以"被打断"结束，不是"出错"');
  eq(loop.stats().interrupted, 1, 'C4 被打断的轮数单独记');
  ok(memory.events().some(e => e.kind === 'event' && e.text.includes('打断')),
    'C5 留了一条事实：话说到一半被打断了');
  ok(saidBy(memory, 'him').some(e => e.text === '等一下，先听我说'), 'C6 打断的那句话本身也落盘了');
  eq(loop.busy, false, 'C7 打断之后锁放开了');
  eq(loop.owed(), true, 'C8 打断也算"欠一句"（这句还没被回答过）');
}

/* ================= D. 请求不听 signal 也不能让旧结果落地 ================= */
console.log('\nD. 掐不掉的时候靠代数');
{
  const memory = mkMem();
  const { R, log } = room();
  let release;
  const gate = new Promise(r => { release = r; });
  /* 故意做成"不理 signal"：真实网络里也常见（请求已经发出去了） */
  const chat = async () => { await gate; return { content: '{"say":"我讲完了","do":[{"do":"go_to","to":"chair:1"}]}' }; };
  const loop = createLoop({ memory, registry: R, chat });

  const p = loop.turn({ text: '讲个故事' });
  await settle();
  loop.interrupt({ text: '先别讲了', from: 'him' });
  release();
  const r = await p;
  ok(!r.ok && r.reason === 'interrupted', 'D1 迟到的结果不算数');
  eq(log.length, 0, 'D2 迟到的动作没有执行（半句话不该落地）');
  ok(!memory.events().some(e => e.kind === 'said' && e.who === 'fish'), 'D3 迟到的 say 也没写进记忆');
}

/* ================= E. 正在做的时候不掐 ================= */
console.log('\nE. 她正在做的时候');
{
  const memory = mkMem();
  const R = createRegistry();
  let release;
  const gate = new Promise(r => { release = r; });
  R.register({
    name: 'slow_walk', description: '慢慢走过去', intent: '走过去', schema: {},
    run: async () => { await gate; return { ok: true, effect: '到了' }; },
  });
  const loop = createLoop({ memory, registry: R, chat: async () => ({ content: '{"say":"我过去","do":[{"do":"slow_walk"}]}' }) });

  const p = loop.turn({ text: '去那边' });
  await settle();
  eq(loop.phase, 'acting', 'E1 已经在做了');
  const r1 = loop.interrupt({ text: '算了别去了', from: 'him' });
  ok(r1.interrupted === false, 'E2 正在做的时候不掐');
  eq(r1.reason, 'acting', 'E3 理由说清楚是"正在做"');
  eq(loop.owed(), true, 'E4 但话听见了，做完要接');

  release();
  const r2 = await p;
  ok(r2.ok && r2.results[0].ok, 'E5 这一轮照常做完（不走半路）');
}

/* ================= F. 多人：谁说的一句话，不能被读成她自己说的 ================= */
console.log('\nF. 不只他一个人');
{
  const memory = mkMem();
  const { R } = room();
  const seen = [];
  const loop = createLoop({ memory, registry: R, chat: async ({ messages }) => { seen.push(messages); return { content: '{"say":"嗯"}' }; } });

  loop.hear({ text: '你好呀', from: 'guest:xiaoming', name: '小明' });
  loop.hear({ text: '我也来了', from: 'guest:ali', name: '阿里' });
  await loop.turn({ text: '我回来了', from: 'him' });
  const msgs = seen.at(-1);
  eq(msgs.length, 3, 'F1 三个人三句话都进了对话');
  ok(msgs[0].role === 'user' && msgs[0].content.includes('[小明]'), 'F2 来访的人算"别人说的"，带名字');
  ok(msgs[1].role === 'user' && msgs[1].content.includes('[阿里]'), 'F3 第二个人也带名字');
  ok(msgs[2].role === 'user' && !/^\[[^\]]{1,8}\] \[/.test(msgs[2].content),
    'F4 他自己那句不带名字（前面只有时间戳）');
  ok(msgs.every(m => m.role === 'user'), 'F5 没有一句被当成"她说的"');

  const seen2 = [];
  const loop2 = createLoop({ memory, registry: R, chat: async ({ messages }) => { seen2.push(messages); return { content: '{"say":"我刚回来"}' }; } });
  await loop2.turn({ text: '接着说' });
  ok(seen2.at(-1).some(m => m.role === 'assistant'), 'F6 她自己说过的话仍然是 assistant');
}

/* ================= G. 锁卡死了要能自己放开 ================= */
console.log('\nG. 锁超时');
{
  const memory = mkMem();
  const { R } = room();
  let clock = 1_000_000;
  let release;
  const gate = new Promise(r => { release = r; });
  let first = true;
  const chat = async () => {
    if (first) { first = false; await gate; return { content: '{"say":"卡住的那句"}' }; }
    return { content: '{"say":"放开了"}' };
  };
  const loop = createLoop({ memory, registry: R, chat, now: () => clock });

  const p1 = loop.turn({ text: '这一轮会卡住' });
  await settle();
  eq(loop.busy, true, 'G1 第一轮占着位子');

  clock += 100_000;                       // 过了 100 秒（阈值 90 秒）
  const r2 = await loop.turn({ text: '还在吗' });
  ok(r2.ok && r2.say === '放开了', 'G2 卡死的锁被放开，新的一轮能跑');
  eq(loop.stats().staleReleases, 1, 'G3 自愈次数记下来（>0 就该查）');
  ok(memory.events().some(e => e.text.includes('卡了')), 'G4 留了一条事实：上一轮卡住了');

  /* 迟到的第一轮回来了：不许把新的一轮放跑，也不许说它的话 */
  release();
  const r1 = await p1;
  ok(!r1.ok && r1.reason === 'stale', 'G5 迟到的那一轮按"过期"结束，不算成功也不算出错');
  ok(!memory.events().some(e => e.kind === 'said' && e.text === '卡住的那句'),
    'G6 迟到的那句话没有说出去（它已经过期了）');
}

console.log(`\n${fail ? '✗ ' : '✓ '} 通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
