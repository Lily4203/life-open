/* 动作中止：他喊一声，脚步停不停、谁来决定
 * ------------------------------------------------------------
 * 这一组守的是 P2 那条线：**反射归我们，议程归她**。
 *   A  信号能透到动作里（而且 interruptible:false 的动作拿不到）
 *   B  执行层的结果从两分变三分：done / partial / failed，不许混
 *   C  loop 在"正在做"的时候叫停，但**不吊销这一轮**（话已经说出去了）
 *   D  屋子真的站定：不瞬移、不卡 pending、目标点收回
 *   E  源码契约（这几条靠读文件，防的是"以后有人图省事改回去"）
 *
 * 跑：node tools/brain-test/stop-test.mjs
 */

import fs from 'node:fs';
import { createRegistry } from '../../js/brain/actions.mjs';
import { createMemory } from '../../js/brain/memory.mjs';
import { createLoop } from '../../js/brain/loop.mjs';
import { createExecutor } from '../../js/brain/executor.mjs';
import { attachRoom } from '../../js/brain/room-bridge.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name,
  `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    read: n => m.get(n) ?? '',
    write: (n, t) => { m.set(n, t); },
    append: (n, t) => { m.set(n, (m.get(n) || '') + t); },
  };
}
const IDENTITY = '你叫小鱼。\n一句一行，几个字。\n他不在这个屋里。';

const stoppedErr = (effect = '走到一半停下来了') =>
  Object.assign(new Error('停下了'), { code: 'stopped', effect });

/* ============================================================
   A. 信号透传：动作签名是 (w, args, { signal })
   ============================================================ */
console.log('\nA. 信号能不能到动作手里');

{
  const R = createRegistry();
  const got = [];
  R.register({
    name: 'go_to', description: '走过去', intent: '走过去',
    schema: { target: { type: 'entity', kinds: ['chair'] } },
    run: async (w, a, opt) => { got.push(opt); return { ok: true, effect: '到了' }; },
  });
  const ctrl = new AbortController();
  await R.call('go_to', { target: 'chair:1' }, { signal: ctrl.signal });
  ok(got.length === 1, 'A1 动作被调用了一次');
  ok(got[0] && got[0].signal === ctrl.signal, 'A2 传进去的就是同一个 signal（不是拷贝）');
  eq(typeof got[0]?.signal?.aborted, 'boolean', 'A3 动作拿到的是标准 AbortSignal');
}

{
  const R = createRegistry();
  const got = [];
  R.register({
    name: 'one_frame', description: '一帧就做完的事', intent: '按一下',
    interruptible: false,
    schema: { target: { type: 'entity', kinds: ['lamp'] } },
    run: async (w, a, opt) => { got.push(opt); return { ok: true, effect: '按了' }; },
  });
  const ctrl = new AbortController();
  await R.call('one_frame', { target: 'lamp:1' }, { signal: ctrl.signal });
  ok(got[0] && got[0].signal === null,
    'A4 interruptible:false 的动作拿不到 signal（开关灯停不停都没意义）');
}

{
  const R = createRegistry();
  let got = 'unset';
  R.register({
    name: 'go_to', description: '走过去', intent: '走过去',
    schema: { target: { type: 'entity', kinds: ['chair'] } },
    run: async (w, a, opt) => { got = opt; return { ok: true, effect: '到了' }; },
  });
  await R.call('go_to', { target: 'chair:1' });
  ok(got && got.signal === null, 'A5 不给 signal 时动作收到的是 null，不是 undefined（省得动作写两种判断）');
}

{
  /* stopped 与 cannot_reach 是两件完全不同的事，绝不能混成一个失败码：
   * "屋子到不了" 是屋子的问题，"他喊了一声" 不是任何人的问题。 */
  const R = createRegistry();
  R.register({
    name: 'go_to', description: '走过去', intent: '走过去',
    schema: { target: { type: 'entity', kinds: ['chair'] } },
    run: async () => { throw stoppedErr(); },
  });
  const r = await R.call('go_to', { target: 'chair:1' }, {});
  ok(r.partial === true, 'A6 抛 {code:stopped} 出来的是 partial，不是失败');
  eq(r.reason, 'stopped', 'A7 reason 是 stopped');
  ok(r.by === null, 'A8 partial 没有责任方（不是她错，也不是屋子的错）');
  eq(r.effect, '走到一半停下来了', 'A9 带着"停在哪"的事实往上走');
}

{
  const R = createRegistry();
  R.register({
    name: 'go_to', description: '走过去', intent: '走过去',
    schema: { target: { type: 'entity', kinds: ['chair'] } },
    run: async () => { throw Object.assign(new Error('无法到达'), { code: 'cannot_reach' }); },
  });
  const r = await R.call('go_to', { target: 'chair:1' }, {});
  ok(!r.partial, 'A10 cannot_reach 不是 partial');
  eq(r.ok, false, 'A11 cannot_reach 仍然是失败');
  eq(r.reason, 'cannot_reach', 'A12 reason 保持了原样（排错要看得出是到不了）');
}

/* ============================================================
   B. 执行层：三分，不是两分
   ============================================================ */
console.log('\nB. 执行层怎么记"做到一半"');

function partialRegistry(out) {
  const R = createRegistry();
  R.register({
    name: 'go_to', description: '走过去', intent: '走过去',
    schema: { target: { type: 'entity', kinds: ['chair'] } },
    run: async () => { throw stoppedErr(); },
  });
  R.register({
    name: 'use_furniture', description: '坐下', intent: '坐下',
    schema: { target: { type: 'entity', kinds: ['chair'] } },
    run: async () => { out.push('坐下被调了'); return { ok: true, effect: '坐下了' }; },
  });
  return R;
}

{
  const seen = [];
  const R = partialRegistry(seen);
  const exec = createExecutor({ registry: R });
  const r = await exec.act('go_to', { target: 'chair:1' });
  eq(r.status, 'partial', 'B1 结果有第三个状态 partial');
  eq(r.ok, false, 'B2 partial 时 ok 仍是 false（她确实没到）');
  ok(!r.text, 'B3 act 不回执文本（回执是 run 的事，act 只管做）');

  const s = exec.stats();
  eq(s.partial, 1, 'B4 单独数 partial');
  eq(s.failed, 0, 'B5 partial 不算 failed');
  eq(s.lastFail, null, 'B6 partial 不写 lastFail（否则排错时看着像她老做不到）');
}

{
  const seen = [];
  const R = partialRegistry(seen);
  const mem = createMemory({ store: memStore({ 'identity.md': IDENTITY }) });
  mem.load();
  const recorded = [];
  const exec = createExecutor({
    registry: R,
    record: e => { recorded.push(e); mem.record(e); },
  });
  const rs = await exec.run([{ name: 'go_to', args: { target: 'chair:1' } },
                            { name: 'use_furniture', args: { target: 'chair:1' } }]);
  eq(rs.length, 1, 'B7 停下就停：第二步不再做');
  eq(seen.length, 0, 'B8 第二步真的没被调用');
  eq(rs[0].text, '你走到一半停下来了', 'B9 回执只陈述事实，不写"没成"');
  ok(!/没成|失败/.test(rs[0].text), 'B10 回执里没有失败的字眼（她会以为屋子做不到）');
  eq(recorded.length, 1, 'B11 停下来的那条进记忆');
  eq(recorded[0].kind, 'did', 'B12 记的是"做了什么"，不是错误');
  ok(recorded[0].salience >= 0.7, 'B13 停下这条权重更高（下一轮要读到"我停在哪"）',
    String(recorded[0].salience));
  const dids = mem.events().filter(e => e.kind === 'did');
  ok(dids.some(e => /走到一半停下/.test(e.text)), 'B14 记忆里查得到');
  ok(!mem.events().some(e => e.kind === 'error'), 'B15 停下不记成 error');
}

{
  /* 三步表里第二步才是停的：第一步成功、第二步 partial，第三步不许做 */
  const order = [];
  const R = createRegistry();
  const mk = (n, fn) => R.register({
    name: n, description: n, intent: n, schema: {},
    run: async () => { order.push(n); return fn(); },
  });
  mk('a', () => ({ ok: true, effect: '做了 a' }));
  mk('b', () => { throw stoppedErr(); });
  mk('c', () => ({ ok: true, effect: '做了 c' }));
  const exec = createExecutor({ registry: R });
  const rs = await exec.run([{ name: 'a' }, { name: 'b' }]);
  eq(order, ['a', 'b'], 'B16 做到了 a，在 b 停下');
  eq(rs.filter(x => x.status === 'partial').length, 1, 'B17 表里恰好一条 partial');
  eq(exec.stats().ok, 1, 'B18 a 算成功');
  eq(exec.stats().failed, 0, 'B19 b 不算失败');
}

{
  const R = createRegistry();
  R.register({
    name: 'go_to', description: '走过去', intent: '走过去', schema: {},
    run: async () => ({ ok: true, partial: true, reason: 'stopped', effect: '停在门口' }),
  });
  const exec = createExecutor({ registry: R });
  const r = await exec.act('go_to', {});
  eq(r.status, 'partial', 'B20 动作**自己返回** partial 也认（不只认抛异常）');
  eq(r.effect, '停在门口', 'B21 保留它自己说的那一句');
}

/* ============================================================
   C. loop：正在做的时候叫停，但这一轮不作废
   ============================================================ */
console.log('\nC. 叫停的那一刻，这一轮还算不算数');

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return false;
};

function loopWith(actionRun, chatImpl = null) {
  const store = memStore({ 'identity.md': IDENTITY });
  const memory = createMemory({ store, charId: 'fish' });
  memory.load();
  const R = createRegistry();
  R.register({
    name: 'go_to', description: '走过去', intent: '走过去',
    schema: { target: { type: 'entity', kinds: ['chair'] } },
    run: actionRun,
  });
  const recorder = [];
  const exec = createExecutor({ registry: R, record: e => { recorder.push(e); memory.record(e); } });
  const chat = chatImpl || (async () => ({ content: '{"say":"我过去。","do":[{"do":"go_to","to":"chair:1"}]}' }));
  const loop = createLoop({ memory, registry: R, chat, executor: exec });
  return { loop, memory, exec, recorder };
}

/* 一直挂着、直到被 abort 的动作 */
const hangUntilAbort = async (w, a, { signal } = {}) => {
  await new Promise((res, rej) => {
    const t = setInterval(() => {
      if (signal?.aborted) { clearInterval(t); rej(stoppedErr()); }
    }, 5);
    setTimeout(() => { clearInterval(t); res(); }, 4000);
  });
  return { ok: true, effect: '到了' };
};

{
  const { loop, memory, exec } = loopWith(hangUntilAbort);
  const p = loop.turn({ text: '去椅子那儿' });
  const acting = await waitFor(() => loop.phase === 'acting');
  ok(acting, 'C1 这一轮真的走到了"正在做"');
  const before = memory.events().filter(e => e.kind === 'said' && e.who === 'fish').length;
  const ir = loop.interrupt({ text: '等一下' });
  ok(ir.stopped === true, 'C2 正在做的时候叫停，返回 stopped');
  eq(ir.interrupted, false, 'C3 但没掐请求（请求早就回来了）');
  eq(ir.reason, 'acting', 'C4 reason 说清是在哪个阶段停的');

  const r = await p;
  ok(r.ok === true, 'C5 这一轮**仍然成立**（不是失败，也不是被打断）');
  eq(r.stopped, true, 'C6 带一个 stopped 标记给页面');
  eq(r.results?.[0]?.partial, true, 'C7 那一步是 partial');
  const after = memory.events().filter(e => e.kind === 'said' && e.who === 'fish').length;
  eq(after, before + 1, 'C8 她这一轮说的话照样落地（epoch 没被吊销）');
  ok(memory.events().some(e => e.kind === 'said' && /我过去/.test(e.text)), 'C9 落的就是她说的那句');
  eq(loop.stats().stops, 1, 'C10 stops 数了一下');
  eq(loop.stats().interrupts, 0, 'C11 interrupts 没动（那是掐请求的数）');
  eq(loop.stats().actionFails, 0, 'C12 停下不算动作失败');
  eq(exec.stats().failed, 0, 'C13 执行层也不记失败');
  ok(memory.events().some(e => e.kind === 'said' && /等一下/.test(e.text)),
    'C14 他叫的那个人，话也进了记忆（听见和停下是两件事）');
}

{
  /* 对照组：正在想的时候打断，行为和以前一样——请求掐掉、这一轮作废 */
  const store = memStore({ 'identity.md': IDENTITY });
  const memory = createMemory({ store, charId: 'fish' });
  memory.load();
  const R = createRegistry();
  const chat = ({ signal }) => new Promise((res, rej) => {
    const t = setTimeout(() => res({ content: '{"say":"在。","do":[]}' }), 3000);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'aborted' }));
    });
  });
  const loop = createLoop({ memory, registry: R, chat });
  const p = loop.turn({ text: '在吗' });
  await waitFor(() => loop.phase === 'thinking');
  const ir = loop.interrupt({ text: '没事' });
  eq(ir.interrupted, true, 'C15 正在想时仍然是真掐（老行为不变）');
  eq(ir.stopped, undefined, 'C16 想的时候没有 stopped 这一说');
  const r = await p;
  eq(r.ok, false, 'C17 被掐的那一轮不作数');
  eq(r.reason, 'interrupted', 'C18 原因说得清');
  ok(!memory.events().some(e => e.kind === 'said' && e.who === 'fish' && /在。/.test(e.text)),
    'C19 没说完的话不落地');
  eq(loop.stats().interrupts, 1, 'C20 interrupts +1');
  eq(loop.stats().stops, 0, 'C21 stops 没动');
}

{
  /* 叫停之后又说了第二句：actCtrl 已经 abort 过，不能重复数、也不能报错 */
  const { loop } = loopWith(hangUntilAbort);
  const p = loop.turn({ text: '去椅子那儿' });
  await waitFor(() => loop.phase === 'acting');
  loop.interrupt({ text: '等一下' });
  const ir2 = loop.interrupt({ text: '真的等一下' });
  eq(ir2.stopped, undefined, 'C22 第二句不会再报一次"停下了"（已经停了）');
  eq(ir2.reason, 'acting', 'C23 但仍然说得出她在哪个阶段');
  eq(loop.stats().stops, 1, 'C24 stops 只数一次');
  await p;
}

{
  /* 没有动作的一轮（只说话）：叫停不该假装停住了什么 */
  const { loop } = loopWith(hangUntilAbort, async () => ({ content: '{"say":"嗯。","do":[]}' }));
  const p = loop.turn({ text: '在吗' });
  await p;
  const ir = loop.interrupt({ text: '嗯' });
  eq(ir.stopped, undefined, 'C25 这一轮根本没有动作，不要说"停下了"');
}

/* ============================================================
   D. 屋子：脚真的站定
   ============================================================ */
console.log('\nD. 屋子停下的时候，人在哪儿');

class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new V3(this.x, this.y, this.z); }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}

/* 假屋子：家具一件，走起来就是 walking=true 然后**不会自己停**
 * （和真屋子一样：真屋子要靠动画走完，这里靠测试手动结束）。 */
function fakeRoom() {
  const state = {
    pos: new V3(0, 0, 0.5), want: new V3(0, 0, 0.5),
    faceWant: 0, poseName: 'stand', walking: false, pending: null, lift: 0, tiltX: 0,
  };
  const poses = [];
  const furn = [{ userData: { name: '椅子', spot: new V3(3, 0, 3), face: 0, action: 'sit' } }];
  const ints = [{ label: '顶灯', on: false, reach: 1.2, obj: { getWorldPosition: p => p.set(0, 2, 0) } }];
  const win = {
    __state: state,
    __THREE: { Vector3: V3 },
    __apply: p => { poses.push(p); state.poseName = p; },
    __walk: (x, z) => { state.pending = null; state.want.set(x, 0, z); state.walking = true; },
    __FURN: furn,
    __INTS: ints,
    __near: () => ({ it: null, d: 9 }),
    __use: (it, by) => { it.on = !it.on; it.by = by; },
    __poke: () => {},
  };
  const registry = createRegistry();
  const api = attachRoom(win, { registry });
  return { win, state, registry, api, poses };
}

/* node 里没有 requestAnimationFrame：用 10ms 一跳代替（await_ 就靠它）
 * 为什么不用 setImmediate：那样一帧只有 0.05ms，abort 之后可能几百帧过去了才发现，
 * 测出来的"停下有多快"就不真。 */
const prevRAF = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = fn => setTimeout(fn, 10);

{
  const { state, registry, poses } = fakeRoom();
  const ctrl = new AbortController();
  const t0 = Date.now();
  const p = registry.call('go_to', { target: 'chair:1' }, { signal: ctrl.signal });
  await new Promise(r => setTimeout(r, 40));       // 走几帧
  ok(state.walking === true, 'D1 一开始真的在走');
  const x0 = state.pos.x, z0 = state.pos.z;
  ctrl.abort();
  /* 注意这里**不是** throw：注册表把 stopped 收成 partial 交上来。
   * 抛出去会让执行层当异常处理，最后变成"她做不到"；收进来才是"做到一半"。 */
  const out = await p;
  const ms = Date.now() - t0;
  ok(ms < 500, 'D2 叫停之后这一步立刻结束（不等到 8 秒超时）', `${ms}ms`);
  eq(out.partial, true, 'D3 交上来的是 partial（不是异常，也不是成功）');
  eq(out.reason, 'stopped', 'D4 理由写着 stopped（和 cannot_reach 分得开）');
  eq(out.effect, '走到一半停下来了', 'D5 带着她能读的那句话');
  eq(state.walking, false, 'D6 停了之后不再走');
  eq(state.pending, null, 'D7 pending 清空（不清会在下一帧把她拽去坐下）');
  eq(state.poseName, 'stand', 'D8 站在那儿，不是走着');
  ok(poses.includes('stand'), 'D9 真的换了姿势（不是只改字段）');
  eq(state.want.x, state.pos.x, 'D10 目标点收回当前位置（不收，tick 会接着拽她走）');
  eq(state.want.z, state.pos.z, 'D11 z 也收回了');
  eq(x0, state.pos.x, 'D12 没瞬移到目的地');
  eq(z0, state.pos.z, 'D13 也没瞬移回家（停在半路就是半路）');
  ok(Math.hypot(state.pos.x - 3, state.pos.z - 3) > 0.3, 'D14 确实不在椅子那儿');
}

{
  /* 不叫停的那条路：走到之后 normal resolve，别把"到了"也弄成 partial */
  const { state, registry } = fakeRoom();
  const ctrl = new AbortController();
  const p = registry.call('go_to', { target: 'chair:1' }, { signal: ctrl.signal });
  await new Promise(r => setTimeout(r, 30));
  state.walking = false;                        // 模拟：动画走完了
  const out = await p;
  eq(out.ok, true, 'D15 没人叫停时正常到');
  eq(out.effect, '到了', 'D16 回执还是"到了"');
  ok(!out.partial, 'D17 不是 partial');
}

{
  /* 还没来得及迈步就被叫停：停在原地，回执也要说清楚 */
  const { state, registry } = fakeRoom();
  const ctrl = new AbortController();
  ctrl.abort();
  const out = await registry.call('go_to', { target: 'chair:1' }, { signal: ctrl.signal })
    .then(r => r).catch(e => ({ err: e }));
  ok(out?.partial === true || out?.err?.code === 'stopped',
    'D18 一上来就被叫停，结果仍然是 partial（不是成功也不是失败）', JSON.stringify(out));
  eq(state.walking, false, 'D19 而且没开始走');
}

{
  /* 开关灯不给 signal：它是"一帧的事"，没有"停在半路"这种状态。
   * 如果这里也停下，她会收到"按到一半停下了"——那是假话。 */
  const { state, registry } = fakeRoom();
  const ctrl = new AbortController();
  state.pos.set(0, 0, 0);
  const out = await registry.call('toggle', { target: 'lamp:1', state: 'on' }, { signal: ctrl.signal });
  eq(out.ok, true, 'D20 够得着的开关不受停止信号影响');
  ok(!out.partial, 'D21 也不产生 partial');
}
/* ============================================================
   E. 源码契约：这几条读文件，防"以后图省事改回去"
   ============================================================ */
console.log('\nE. 写在源码里的几条规矩');

const src = p => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

{
  const rb = src('js/brain/room-bridge.mjs');
  ok(/if \(signal\?\.aborted\)[\s\S]{0,80}haltHere\(\)/.test(rb),
    'E1 await_ 每帧先看 signal，再决定要不要继续走');
  ok(/rej\(Object\.assign\(new Error\('停下了'\), \{ code: 'stopped'/.test(rb),
    'E2 停下用的是 stopped 这个码，不是 cannot_reach');
  ok(/state\.want\.copy\(state\.pos\)/.test(rb),
    'E3 停下要把目标点收回到脚下（否则 tick 会接着拽）');
  ok(/state\.pending = null/.test(rb), 'E4 停下要清 pending');
  ok(!/signal\?\.aborted[\s\S]{0,40}return res\(true\)/.test(rb),
    'E5 不会把"被叫停"当成"到了"（那样回执会撒谎）');
}

{
  const ac = src('js/brain/actions.mjs');
  ok(/interruptible === false \? null : signal/.test(ac),
    'E6 interruptible:false 的动作拿不到信号（这一条必须在 call 里，动作自己判断不了）');
  ok(/e\.code === 'stopped'[\s\S]{0,120}partial: true/.test(ac),
    'E7 stopped 在注册表层就被认成 partial，不会冒泡成异常');
}

{
  const lp = src('js/brain/loop.mjs');
  ok(/phase === 'acting'[\s\S]{0,400}stopped: true/.test(lp),
    'E8 loop 有专门的 acting 分支');
  ok(/phase === 'acting'[\s\S]{0,700}?epoch \+= 1/.test(lp) === false ||
     /if \(phase !== 'thinking'\) return/.test(lp),
    'E9 acting 分支不会顺手吊销 epoch（这一轮的话要留下）');
  ok(/actCtrl = typeof AbortController/.test(lp),
    'E10 动作有自己的 controller，不和请求共用一个');
  ok(/runActions\(parsed\.do, place, actCtrl\?\.signal \|\| null\)/.test(lp),
    'E11 signal 真的传到了执行层');
  ok(/if \(r\.partial\) continue/.test(lp),
    'E12 停下不进 actionFails（进了就成"她老做不到"）');
}

{
  const pm = src('js/brain/prompt.mjs');
  ok(/走到一半停下来了/.test(pm), 'E13 提示词告诉她"被叫住"是真实会发生的事');
  ok(/接着走完，还是先放下，你自己定/.test(pm),
    'E14 去留交给她，不写成命令（这是这条待办里唯一不能省的一句）');
  ok(!/必须继续走完|重新做一遍/.test(pm), 'E15 不替她决定');
}

{
  const page = src('预览-66.html');
  ok(/r\.stopped \? '她停下脚步听你说'/.test(page), 'E16 页面分得清"停下脚步"和"停下说话"');
  ok(/r\.stopped \? '　（被叫住，停在半路）'/.test(page), 'E17 状态栏说实话');
}

if (prevRAF) globalThis.requestAnimationFrame = prevRAF;

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
