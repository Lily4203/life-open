/* 显示后端端口：能力声明、降级、不拖后腿
 * ------------------------------------------------------------
 * 这一层的目的只有一个：**换身体不改大脑**。
 * 所以测的不是"能不能渲染"，是四件：
 *   A  声明的能力就是能做的，没声明的一律够不着（不许试出来的）
 *   B  够不着的时候降级，而且降级写在返回值里（不许静默成功）
 *   C  出错不冒泡（后端抛异常，大脑那一侧照常往下跑）
 *   D  五种后端的典型能力表，每一行都能直接注册（门是通的，不是画在纸上的）
 *
 * 运行：node tools/brain-test/avatar-test.mjs
 */

import { createAvatar, CAPS, BACKEND_TABLE, MOTION_TO_EMOTION, unsupported } from '../../js/brain/avatar.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };
const eq = (a, b, name) => { const c = JSON.stringify(a) === JSON.stringify(b); if (!c) console.log(`     期望 ${JSON.stringify(b)} 实得 ${JSON.stringify(a)}`); ok(c, name); };
const throws = (fn, name) => { try { fn(); ok(false, name); } catch { ok(true, name); } };

/* 一个记日志的假后端：caps 由调用方给，缺的实现按需补 */
function fake(caps, log, extra = {}) {
  const impl = { caps };
  const impls = {
    say: t => log.push(`say:${t}`),
    emotion: e => log.push(`em:${e}`),
    motion: m => log.push(`mo:${m}`),
    lookAt: (x, y) => log.push(`look:${x},${y}`),
    outfit: n => log.push(`outfit:${n}`),
    gesture: k => log.push(`gest:${k}`),
  };
  for (const c of caps) if (c !== 'say') impl[c] = impls[c];
  if (caps.includes('say')) impl.say = impls.say;
  return { ...impl, ...extra };
}

console.log('\nA. 声明的能力就是能做的');

{
  const log = [];
  const av = createAvatar();
  av.register('vrm', fake(['say', 'emotion', 'motion', 'lookAt'], log));
  eq(av.can('motion'), true, 'A1 声明了 motion 就是能做');
  eq(av.can('outfit'), false, 'A2 没声明 outfit 就是不能做');
  eq(av.setOutfit('裙子').reason, 'unsupported', 'A3 够不着要明确说 unsupported，不是崩');
  eq(av.setOutfit('裙子').ok, false, 'A4 够不着不算成功');
  throws(() => av.register('坏身体', { caps: ['emotion'], emotion() {} }), 'A5 没有 say 的身体不许注册（话都说不出来）');
  throws(() => av.register('吹牛', { caps: ['say', 'motion'], say() {} }), 'A6 声明了 motion 却没实现，不许注册');
  throws(() => av.register('乱写', { caps: ['say', 'dance'], say() {} }), 'A7 未知能力名不许蒙混过去');
  throws(() => av.use('不存在'), 'A8 切到没注册过的后端要抛（这是配置错，不是运行时错）');
  eq(CAPS.length, 8, 'A9 能力表是封闭的八种（多出来的是 gesture，P5 加的）');
}

console.log('\nB. 够不着的时候降级，而且降级不静默');

{
  const log = [];
  const av = createAvatar();
  av.register('tachie', fake(['say', 'emotion'], log));   // 立绘：不会动
  const r = av.play('sit');
  eq(r.ok, true, 'B1 立绘上"坐下"要退成能看见的反应，不是什么都不做');
  eq(r.via, 'emotion', 'B2 走的是表情那条路');
  eq(r.degraded, true, 'B3 必须自己承认是降级');
  ok(/不会做动作/.test(r.message), 'B4 降级要有一句人话，不能只给个布尔');
  eq(log.join('|'), 'em:relaxed', 'B5 实际发生的正是表情');
  eq(MOTION_TO_EMOTION.sit, 'relaxed', 'B6 动作→表情的映射表在');
}

{
  const log = [];
  const av = createAvatar();
  av.register('tachie', fake(['say'], log));              // 连表情都没有
  const r = av.play('sit');
  eq(r.ok, false, 'B7 什么都不会的后端，降不动就明确回失败');
  eq(r.degraded, false, 'B8 没降级成功就不许标成降级');
  eq(av.stats().calls.degraded, 0, 'B9 失败不算降级（两个数要分开）');
}

{
  const log = [];
  const av = createAvatar();
  av.register('vrm', fake(['say', 'emotion', 'motion'], log));
  const r = av.play('sit');
  eq(r.degraded, false, 'B10 会动的后端上，正常播动作不算降级');
  eq(log.join('|'), 'mo:sit', 'B11 动作走动作那条路，不走表情');
}

console.log('\nC. 出错不冒泡');

{
  const log = [];
  const av = createAvatar();
  av.register('boom', fake(['say', 'motion'], log, { motion: () => { throw new Error('骨骼名找不到'); } }));
  const r = av.play('sit');
  eq(r.ok, false, 'C1 后端抛异常要变成回执，不是往上炸');
  eq(r.reason, 'threw', 'C2 原因要写清是后端自己炸的');
  ok(/骨骼名找不到/.test(r.message), 'C3 原始信息要留着，否则没法修');
}

{
  /* 能力边界和 bug 必须分开：前者是"这个身体本来就不会"，后者是"代码坏了"。
   * 混成一个 reason，排错时永远分不清该改模型配置还是改代码。 */
  const av = createAvatar();
  av.register('vrm', fake(['say', 'motion'], [], { motion: () => { throw unsupported('这个身体不会挥手'); } }));
  const r = av.play('wave');
  eq(r.reason, 'unsupported', 'C7 后端明说"不会"，要记成能力边界');
  ok(/不会挥手/.test(r.message), 'C8 拒绝的理由要原样留着');
}

{
  const av = createAvatar();
  const r = av.say('你好');
  eq(r.ok, false, 'C4 一个后端都没注册时，说话回失败');
  eq(r.reason, 'no_backend', 'C5 原因要能区分"没有身体"和"身体不会"');
  ok(/没有可见的身体/.test(av.describe()), 'C6 没身体时 describe 也要说人话');
}

console.log('\nD. 五种后端的门都是通的');

{
  for (const [name, caps] of Object.entries(BACKEND_TABLE)) {
    const log = [];
    const av = createAvatar();
    let err = null;
    try { av.register(name, fake(caps, log)); } catch (e) { err = e.message; }
    eq(err, null, `D-${name} 这张表能直接注册成后端`);
    ok(av.describe().includes(name), `D-${name} describe 说得出自己是谁`);
  }
  eq(Object.keys(BACKEND_TABLE).length, 5, 'D1 五个后端：vrm / live2d / mmd / spine / tachie');
}

{
  const av = createAvatar();
  av.register('vrm', fake(['say', 'emotion', 'motion', 'lookAt', 'outfit'], []));
  const d = av.describe();
  ok(/做动作/.test(d) && /换衣服/.test(d), 'D2 能力全的时候 describe 把能做的都说出来');
  ok(!/不能/.test(d), 'D3 能力全的时候不许说"不能"');
}

console.log('\nE. 换身体不改大脑');

{
  const log = [];
  const av = createAvatar();
  av.register('vrm', fake(['say', 'emotion', 'motion'], log));
  av.register('tachie', fake(['say', 'emotion'], log));
  eq(av.current(), 'vrm', 'E1 先注册的自动成为当前');
  av.use('tachie');
  eq(av.current(), 'tachie', 'E2 能换');
  /* 同一句调用，换身体前后都能跑完——这就是"换身体不改大脑" */
  const a = av.play('sit'); const b = av.setEmotion('happy'); const c = av.say('坐下了');
  ok(a.ok && b.ok && c.ok, 'E3 换了身体，同样的调用一个都不用改');
  eq(a.degraded, true, 'E4 但降级的事实要说出来');
  eq(av.list().length, 2, 'E5 换掉的后端仍在册（能换回来）');
  eq(av.list().filter(x => x.current).length, 1, 'E6 同时只有一个当前');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
