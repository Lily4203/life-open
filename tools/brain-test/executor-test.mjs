/* 执行层：想的是她，动的是这里
 * ------------------------------------------------------------
 * 这组断言测的不是"动作对不对"，是**分界有没有被守住**：
 *   A  一条意图只走一个执行端（屋子 / 游戏 / 身体），不串台
 *   B  一次只做一步，前一步没成就不许有第二步
 *   C  执行失败变成回执，不冒泡、不静默、不假装成功
 *   D  这个文件里没有"想"：不调模型、不拼提示词、不看世界快照
 *   E  loop 真的把动作交给执行层，而不是自己偷偷 registry.call
 *
 * 跑：node tools/brain-test/executor-test.mjs
 */

import fs from 'node:fs';
import { createExecutor, MAX_STEPS } from '../../js/brain/executor.mjs';
import { createRegistry } from '../../js/brain/actions.mjs';
import { createMemory } from '../../js/brain/memory.mjs';
import { createLoop } from '../../js/brain/loop.mjs';

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

/* 假注册表：只记"被调了什么"，不做别的。
 * 故意不用 createRegistry：这组测的是执行层，不应该被校验逻辑干扰。 */
function fakeRegistry(map = {}) {
  const calls = [];
  const defs = new Map();
  for (const [k, v] of Object.entries(map)) defs.set(k, v);
  return {
    calls,
    get: n => defs.get(n) || null,
    call: async (name, args, opt) => {
      calls.push({ name, args, opt });
      const d = defs.get(name);
      if (!d) return { action: name, ok: false, reason: 'no_such_action', by: 'her', message: '没有这个动作' };
      if (d.throw) throw new Error(d.throw);
      return d.result ? { ...d.result } : { action: name, ok: true, effect: d.effect || '做好了' };
    },
  };
}

console.log('\nA. 一条意图只走一个执行端');

{
  const log = [];
  const R = fakeRegistry({
    sit: { intent: '坐下', effect: '坐下了' },
    wave: { intent: '挥手', effect: '挥了挥手' },
  });
  const ex = createExecutor({ registry: R });
  const a = await ex.act('sit', { target: 'chair:1' });
  eq(a.ok, true, 'A1 成功回执 ok');
  eq(a.port, 'room', 'A2 走的是屋子');
  eq(a.effect, '坐下了', 'A3 屋子说做成了什么，就回什么');
  eq(R.calls.length, 1, 'A4 只调了一次');
  eq(R.calls[0].args, { target: 'chair:1' }, 'A5 参数原样递过去（执行层不改她的意思）');

  const r = await ex.act('sit', {});
  const run = await ex.run([{ name: 'wave', args: {} }]);
  eq(run[0].text, '你挥了挥手', 'A6 回执是"你做了什么"');
  eq(run[0].port, 'room', 'A7 run 也标执行端');
}

{
  const log = [];
  const R = fakeRegistry({ sit: { intent: '坐下', result: { ok: false, reason: 'occupied', by: 'room', message: '椅子上有人' } } });
  const ex = createExecutor({ registry: R });
  const r = await ex.act('sit', {});
  eq(r.ok, false, 'B1 失败就是失败');
  eq(r.reason, 'occupied', 'B2 原因保留');
  eq(r.by, 'room', 'B3 责任方保留（屋子没做到）');
  const out = await ex.run([{ name: 'sit', args: {} }]);
  ok(/^你想坐下，但没成：椅子上有人$/.test(out[0].text), 'B4 失败写成她读得懂的一句', out[0].text);
}

{
  const R = fakeRegistry({ sit: { intent: '坐下', throw: '骨骼名找不到' } });
  const ex = createExecutor({ registry: R });
  const r = await ex.act('sit', {});
  eq(r.ok, false, 'C1 执行端抛异常不冒泡');
  eq(r.reason, 'threw', 'C2 记成 threw，不记成"她不会"');
  eq(r.by, 'room', 'C3 异常算执行端的');
}

{
  const R = fakeRegistry({ sit: { intent: '坐下', result: { ok: false, reason: 'no_such_thing', by: 'her', message: '屋里没有这件东西' } } });
  const ex = createExecutor({ registry: R });
  const a = await ex.act('sit', {});
  const b = await ex.run([{ name: 'sit', args: {} }]);
  eq(a.by, 'her', 'C4 "她指错了东西"仍然算她的');
  eq(b[0].text, '你想坐下，但没成：屋里没有这件东西', 'C5 她的错也写成同一句话，但责任方不同');
}

{
  const R = fakeRegistry({});
  const ex = createExecutor({ registry: R });
  const r = await ex.act('');
  eq(r.ok, false, 'D1 没给动作名，就直说没给');
  eq(r.reason, 'no_action', 'D2 不是"没有这个动作"');
}

console.log('\nB. 一次只做一步，没成就停');

{
  const log = [];
  const R = fakeRegistry({
    first: { intent: '先做', effect: '做完了第一件' },
    second: { intent: '再做', effect: '做完了第二件' },
  });
  const ex = createExecutor({ registry: R });
  const out = await ex.run([{ name: 'first', args: {} }, { name: 'second', args: {} }]);
  eq(out.length, 2, 'B5 两步都做了');
  eq(R.calls.map(c => c.name).join(','), 'first,second', 'B6 顺序就是她给的顺序');
}

{
  const R = fakeRegistry({
    first: { intent: '先做', result: { ok: false, reason: 'blocked', by: 'room', message: '过不去' } },
    second: { intent: '再做', effect: '做完了第二件' },
  });
  const ex = createExecutor({ registry: R });
  const out = await ex.run([{ name: 'first', args: {} }, { name: 'second', args: {} }]);
  eq(out.length, 1, 'B7 第一步没成就停');
  eq(R.calls.length, 1, 'B8 第二步根本没被执行');
}

{
  const R = fakeRegistry({ a: {}, b: {}, c: {} });
  const ex = createExecutor({ registry: R });
  const out = await ex.run([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  eq(out.length, MAX_STEPS, 'B9 超过上限的部分不执行（模型改了、解析没改也要拦住）');
}

{
  const rec = [];
  const R = fakeRegistry({ sit: { intent: '坐下', effect: '坐下了' } });
  const ex = createExecutor({ registry: R, record: e => rec.push(e) });
  await ex.run([{ name: 'sit', args: {} }], { place: '书桌' });
  eq(rec.length, 1, 'B10 每做一步，事件流里有一条');
  eq(rec[0].kind, 'did', 'B11 记的是"做过"，不是"想过"');
  eq(rec[0].place, '书桌', 'B12 地点跟着走');
  eq(rec[0].text, '你坐下了', 'B13 记下来的也是她那句话');
}

console.log('\nC. 游戏：动作归游戏，坐标不归大脑');

{
  const calls = [];
  const game = {
    owns: n => n.startsWith('guess_'),
    intentOf: n => (n === 'guess_number' ? '猜一个数' : n),
    act: async (n, args) => { calls.push({ n, args }); return { ok: true, effect: '猜了 42，大了' }; },
  };
  const R = fakeRegistry({ sit: { intent: '坐下' } });
  const ex = createExecutor({ registry: R, game });
  const r = await ex.act('guess_number', { n: 42 });
  eq(r.port, 'game', 'C6 游戏的动作走游戏');
  eq(R.calls.length, 0, 'C7 没有落到屋子');
  eq(calls[0].args, { n: 42 }, 'C8 语义参数原样给游戏（数字是"猜几"，不是坐标）');
  const out = await ex.run([{ name: 'guess_number', args: { n: 7 } }]);
  eq(out[0].text, '你猜了 42，大了', 'C9 游戏说做成了什么，就回什么');
}

{
  const game = {
    owns: () => true,
    act: async () => { throw new Error('窗口没抓住'); },
  };
  const ex = createExecutor({ registry: fakeRegistry({}), game });
  const r = await ex.act('click_card', {});
  eq(r.ok, false, 'C10 游戏执行端出错也不冒泡');
  eq(r.reason, 'threw', 'C11 记成 threw');
  eq(r.by, 'game', 'C12 责任方是游戏，不是她');
}

console.log('\nD. 说话和表情也走执行层（只有一个出口）');

{
  const said = [], emo = [];
  const avatar = { say: t => { said.push(t); return { ok: true, cap: 'say', via: 'fake' }; }, setEmotion: e => { emo.push(e); return { ok: true }; } };
  const ex = createExecutor({ registry: fakeRegistry({}), avatar });
  const a = ex.speak('我在这儿。');
  const b = ex.express('happy');
  eq(said, ['我在这儿。'], 'D3 说话真的到了身体');
  eq(a.port, 'body', 'D4 说话算身体的动作');
  eq(emo, ['happy'], 'D5 表情也走同一个出口');
  eq(b.ok, true, 'D6 表情回执 ok');
}

{
  const ex = createExecutor({ registry: fakeRegistry({}) });
  const a = ex.speak('喂');
  const b = ex.express('happy');
  eq(a.ok, false, 'D7 没有身体就如实说');
  eq(a.reason, 'no_backend', 'D8 不是静默成功');
  eq(b.reason, 'no_backend', 'D9 表情同样');
}

{
  const avatar = { say: () => { throw new Error('字幕层挂了'); } };
  const ex = createExecutor({ registry: fakeRegistry({}), avatar });
  const r = ex.speak('喂');
  eq(r.ok, false, 'D10 身体出错不冒泡');
}

console.log('\nE. 分界有没有被守住（读源码）');

{
  const src = fs.readFileSync(new URL('../../js/brain/executor.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');          // 注释里会提到这些词，先去掉
  ok(!/\bchat\s*\(/.test(src), 'E1 执行层不调模型');
  ok(!/buildSystem|buildWakeSystem|parseOut/.test(src), 'E2 执行层不拼提示词');
  ok(!/memory\.(boot|plan|closeAgenda|nextAgenda)/.test(src), 'E3 执行层不碰记忆和议程');
  ok(!/normalizeWorld|diffWorld|worldSignature/.test(src), 'E4 执行层不看世界快照');
  ok(!/\bfetch\s*\(/.test(src), 'E5 执行层不发请求');
}

{
  const src = fs.readFileSync(new URL('../../js/brain/loop.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/registry\.call\s*\(/.test(src), 'E6 大脑不直接调动作注册表（动作只能经执行层）');
  ok(/exec\.run\s*\(/.test(src), 'E7 大脑把动作交给执行层');
  ok(!/avatar\.(say|play|setEmotion|setOutfit)\s*\(/.test(src), 'E8 大脑不碰身体端口');
}

/* 真跑一遍 loop：把执行层换成一个小间谍，看它到底走哪条路 */
{
  const IDENTITY = '你叫小鱼。';
  const store = memStore({ 'identity.md': IDENTITY });
  const memory = createMemory({ store, charId: 'fish' });
  memory.load();
  const R = createRegistry();
  R.register({
    name: 'go_to', description: '走过去', intent: '走过去',
    schema: { target: { type: 'entity', kinds: ['chair'] } },
    run: () => { throw new Error('这条不该被直接调到'); },
  });
  const spy = [];
  const executor = {
    run: async (list, opt) => {
      spy.push({ list, opt });
      return list.map(d => ({ ...d, ok: true, port: 'room', effect: '到了', text: '你到了' }));
    },
    speak: () => ({ ok: true }),
  };
  const chat = async () => ({ content: '{"say":"好。","do":[{"do":"go_to","to":"chair:1"}]}' });
  const loop = createLoop({ memory, registry: R, chat, executor });
  const r = await loop.turn({ text: '去椅子那儿' });
  eq(spy.length, 1, 'E9 loop 把动作交给了注入的执行层');
  eq(spy[0].list[0].name, 'go_to', 'E10 交给执行层的是意图，不是坐标');
  eq(r.results[0].text, '你到了', 'E11 执行层的回执原样回到这一轮');
  eq(loop.executor, executor, 'E12 loop 暴露的是同一个执行层，不是一个副本');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
