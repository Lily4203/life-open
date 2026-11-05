/* 动作窗口 / 注销宽限 / 重名覆盖 / 责任归属
 * ------------------------------------------------------------
 * 这四条是 2026-11-05 09:3x 照 neuro-game-sdk 源码补的，之前我们不如它：
 *   W  窗口：提示词里列的和执行时认的必须是同一组
 *   D  注销宽限：刚收走的动作要认得，回的话不能是"没有这个动作"
 *   R  重名：房间重载会再注册一遍，抛错等于一刷新就崩
 *   B  责任：校验错是她的问题，执行不了是屋子的限制，得写进 message
 *
 * 运行：node tools/brain-test/window-test.mjs
 */

import { createRegistry, GEOMETRY_KEYS, UNREGISTER_GRACE_MS } from '../../js/brain/actions.mjs';
import { buildSystem, buildWakeSystem } from '../../js/brain/prompt.mjs';
import { createLoop } from '../../js/brain/loop.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };
const eq = (a, b, name) => { const c = JSON.stringify(a) === JSON.stringify(b); if (!c) console.log(`     期望 ${JSON.stringify(b)} 实得 ${JSON.stringify(a)}`); ok(c, name); };

/* 一个最小可用的 registry：两个动作，其中一个能失败 */
function mkReg(opts = {}) {
  let t = 1_000_000;
  const R = createRegistry({ now: () => t, ...opts });
  const bump = () => (t += 0);
  R.__setTime = v => { t = v; };
  R.__advance = ms => { t += ms; };
  R.register({
    name: 'go_to', description: '走过去',
    schema: { target: { type: 'entity', kinds: ['chair'] } },
    run: async () => ({ ok: true, effect: 'arrived' }),
  });
  R.register({
    name: 'toggle', description: '开关',
    schema: { target: { type: 'entity', kinds: ['lamp'] }, state: { type: 'enum', values: ['on', 'off'], required: false } },
    run: async () => ({ ok: true, effect: '灯开' }),
  });
  R.register({
    name: 'broken', description: '永远做不到的动作',
    run: async () => ({ ok: false, reason: 'cannot_reach' }),
  });
  return R;
}

console.log('\nW. 窗口：列什么就认什么');

{
  const R = mkReg();
  R.openWindow({ names: ['go_to'], note: '你在床边' });

  const sys = buildSystem({ boot: { blocks: [] }, registry: R, entities: [] });
  ok(/## 这次能做的（只有这几件）/.test(sys), 'W1 标题改成"这次能做的"，不是"你能做的"');
  ok(/- go_to/.test(sys) && !/- toggle/.test(sys), 'W2 只列窗口内的动作');
  ok(sys.includes('你在床边'), 'W3 note 进了提示词（她知道自己现在什么状态）');
  ok(sys.includes('do 只能填「这次能做的」'), 'W4 明确说了 do 只能填这几个');

  const r1 = await R.call('toggle', { target: 'lamp:1', state: 'on' });
  eq([r1.ok, r1.reason, r1.by], [false, 'not_in_window', 'her'], 'W5 窗口外的动作被拒，且算她的问题');
  ok(/只允许做：go_to/.test(r1.message || ''), 'W6 拒绝时把"这次能做什么"说给她听');

  const r2 = await R.call('go_to', { target: 'chair:1' });
  eq(r2.ok, true, 'W7 窗口内的动作照常执行');

  R.closeWindow();
  const r3 = await R.call('toggle', { target: 'lamp:1', state: 'on' });
  eq(r3.ok, true, 'W8 关窗后恢复全开（旧调用方不用改）');

  const sys2 = buildSystem({ boot: { blocks: [] }, registry: R, entities: [] });
  ok(/## 你能做的/.test(sys2), 'W9 没窗口时标题回到"你能做的"');
}

{
  const R = mkReg();
  R.openWindow({ names: ['go_to'] });
  const r = await R.call('fly', {});
  eq([r.ok, r.reason], [false, 'no_such_action'], 'W10 窗口内提一个不存在的动作 → no_such_action（不是 not_in_window）');
}

{
  const R = mkReg();
  let threw = false;
  try { R.openWindow({ names: ['go_to', 'fly'] }); } catch { threw = true; }
  ok(threw, 'W11 开窗时混进未注册的动作直接抛错（早失败，别等到运行时）');
}

console.log('\nD. 注销宽限：刚收走的动作要认得');

{
  const R = mkReg();
  R.unregister('toggle');

  const r1 = await R.call('toggle', { target: 'lamp:1' });
  eq([r1.ok, r1.reason, r1.by], [false, 'recently_unregistered', 'room'], 'D1 刚注销 10 秒内仍认得，回"刚被收走"');
  ok(/刚被收走/.test(r1.message || ''), 'D2 这句话不能是"没有这个动作"——那会让她以为自己在幻觉');
  ok(R.isDying('toggle') === true, 'D3 isDying 为真');

  R.__advance(UNREGISTER_GRACE_MS + 1);
  const r2 = await R.call('toggle', { target: 'lamp:1' });
  eq([r2.reason, r2.by], ['no_such_action', 'her'], 'D4 过了宽限期才算真没有');
  ok(R.isDying('toggle') === false, 'D5 宽限过期');
}

{
  const R = mkReg();
  R.unregister('toggle');
  R.register({ name: 'toggle', description: '开关（重新装回来）', schema: {}, run: async () => ({ ok: true }) });
  const r = await R.call('toggle', {});
  eq(r.ok, true, 'D6 同名动作重新注册后，立刻就能用（dying 被清掉）');
}

console.log('\nR. 重名注册：默认覆盖，不抛错');

{
  const R = mkReg();
  let threw = false;
  try { R.register({ name: 'go_to', description: '新的 go_to', schema: {}, run: async () => ({ ok: true, effect: 'v2' }) }); }
  catch { threw = true; }
  ok(!threw, 'R1 默认不抛错（房间重载会再注册一遍）');
  const r = await R.call('go_to', {});
  eq(r.effect, 'v2', 'R2 后注册的覆盖先注册的');
  eq(R.size(), 3, 'R3 覆盖不增加数量');

  const S = createRegistry({ strictNames: true });
  let threw2 = false;
  S.register({ name: 'a_b', description: 'x', run: async () => ({ ok: true }) });
  try { S.register({ name: 'a_b', description: 'y', run: async () => ({ ok: true }) }); } catch { threw2 = true; }
  ok(threw2, 'R4 strictNames 时才抛错（测试用）');
}

console.log('\nB. 责任归属：写进 message，不是只放字段');

{
  const R = mkReg();
  const her = await R.call('go_to', { target: 'chair:1', x: 1.2 });
  eq([her.ok, her.reason, her.by], [false, 'geometry_not_allowed', 'her'], 'B1 传了坐标 → 她的错');
  ok(/怎么走过去由屋子算/.test(her.message || ''), 'B2 拒绝时把分工再说一遍');

  const bad = await R.call('go_to', { target: 'bed:1' });
  eq([bad.reason, bad.by], ['wrong_entity_kind', 'her'], 'B3 实体种类不对 → 她的错');

  const room = await R.call('broken', {});
  eq([room.ok, room.reason, room.by], [false, 'cannot_reach', 'room'], 'B4 执行不了 → 屋子的限制');
}

console.log('\nL. loop：开窗在调模型之前，关窗在 finally');

{
  // 假 memory：只提供 loop 用到的几样
  const memory = {
    setWorld() {}, record() {},
    boot: () => ({ blocks: [{ id: 'identity', text: '你是鱼' }], chars: 8, dropped: [] }),
    events: () => [], openAgenda: () => [],
  };
  let seenSystem = '';
  const chat = async ({ system }) => { seenSystem = system; return JSON.stringify({ say: '好', do: [{ do: 'toggle', to: 'lamp:1' }] }); };

  const R = mkReg();
  const loop = createLoop({ memory, registry: R, chat, windowFor: () => ({ names: ['go_to'], note: '这次只让你走过去' }) });

  const r = await loop.turn({ text: '去椅子那儿' });
  ok(/- go_to/.test(seenSystem) && !/- toggle/.test(seenSystem), 'L1 调模型时提示词里只有窗口内的动作');
  eq(r.window, ['go_to'], 'L2 返回值里带了这次的窗口');
  eq([r.results[0].ok, r.results[0].reason], [false, 'not_in_window'], 'L3 她越界选了 toggle，被窗口拦住');
  eq(R.windowInfo(), null, 'L4 一轮结束后窗口关掉了（不会卡住下一次）');

  // 抛异常也要关窗
  const loop2 = createLoop({ memory, registry: R, chat: async () => { throw new Error('模型挂了'); }, windowFor: () => ['go_to'] });
  await loop2.turn({ text: 'hi' });
  eq(R.windowInfo(), null, 'L5 这一轮抛异常，窗口照样关掉');

  // 没有 windowFor 的旧用法
  const loop3 = createLoop({ memory, registry: R, chat: async () => JSON.stringify({ say: '嗯', do: [] }) });
  const r3 = await loop3.turn({ text: 'hi' });
  eq([r3.ok, r3.window], [true, null], 'L6 不给 windowFor 就不开窗（兼容旧调用）');
}

{
  // wake：item.candidates 优先当窗口
  const memory = {
    setWorld() {}, record() {},
    boot: () => ({ blocks: [], chars: 0, dropped: [] }),
    events: () => [], openAgenda: () => [],
  };
  const ini = {
    dispatch: () => ({ id: 'p1', reason: 'unseen', target: 'lamp:1', detail: '灯自己灭了', candidates: ['toggle'], attempts: 0, state: 'pending', probe: false }),
    resolve: () => true,
  };
  let seen = '';
  const R = mkReg();
  const loop = createLoop({ memory, registry: R, initiative: ini, chat: async ({ system }) => { seen = system; return JSON.stringify({ say: '', do: [{ do: 'toggle', to: 'lamp:1' }] }); } });

  const r = await loop.wake();
  ok(/- toggle/.test(seen) && !/- go_to/.test(seen), 'L7 唤醒时候选就是窗口');
  eq(r.do.length, 1, 'L8 候选内的动作照常执行（以前这里是静默 filter）');
  ok(!/这件事只考虑这几个动作/.test(seen), 'L9 窗口已列出候选，提示词不再重复一句（自我重复会被当成强调）');
}

{
  // 候选里有未注册的动作：不能因为开窗抛错就整轮崩
  const memory = {
    setWorld() {}, record() {},
    boot: () => ({ blocks: [], chars: 0, dropped: [] }),
    events: () => [], openAgenda: () => [],
  };
  const ini = {
    dispatch: () => ({ id: 'p2', detail: '门外有声音', candidates: ['listen', 'toggle'], probe: true }),
    resolve: () => true,
  };
  const R = mkReg();
  const loop = createLoop({ memory, registry: R, initiative: ini, chat: async () => JSON.stringify({ say: '嗯', do: [] }) });
  const r = await loop.wake();
  eq([r.ok, r.window], [true, ['toggle']], 'L10 候选里有没注册的动作时，过滤掉而不是整轮崩');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
