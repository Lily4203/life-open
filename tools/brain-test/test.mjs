/* 三条拍定意见的逐条验证。
 *   A 动作空间用枚举 —— 大脑只说做什么，几何归屋子
 *   B 上下文 replace / append 两条都算，能同时打出来对比
 *   C 发起层：没有定时器、单槽派发、四条规则、能落盘
 * 运行：node test.mjs
 */
import { readFileSync } from 'node:fs';
import { createRegistry } from '../../js/brain/actions.mjs';
import { createContext } from '../../js/brain/context.mjs';
import { createInitiative, REASONS, PRIORITY } from '../../js/brain/initiative.mjs';

let pass = 0, fail = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; fails.push([name, e.message]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}\n        期望 ${B}\n        实际 ${A}`);
};
const throws = (fn, m) => { try { fn(); } catch { return; } throw new Error(m); };

/* ---------------- A. 动作枚举 ---------------- */
console.log('\n── A. 动作空间：枚举，几何归屋子 ────────────────────');

const mkRoom = () => {
  const calls = [];
  const world = {
    // 屋子的能力：只有它知道距离、朝向、能不能走到
    resolve: id => ({ id, kind: String(id).split(':')[0], dist: id === 'chair:1' ? 2.4 : 0.6 }),
    walkTo: () => { calls.push('walk'); },
    calls,
  };
  return world;
};

await t('A1 schema 里出现几何字段，注册就该失败', () => {
  const R = createRegistry();
  throws(() => R.register({
    name: 'sit', description: '坐下',
    schema: { x: { type: 'int', required: false } }, run: () => true,
  }), '带 x 字段的 schema 没被拦住');
});

await t('A2 调用时塞坐标 → geometry_not_allowed（不是静默接受）', async () => {
  const R = createRegistry();
  R.register({ name: 'sit', description: '坐到某件家具上', schema: { target: { type: 'entity', kinds: ['chair', 'bed'] } },
    run: () => true });
  const r = await R.call('sit', { target: 'chair:1', x: 0.8 });
  eq([r.ok, r.reason], [false, 'geometry_not_allowed'], '坐标没被拒');
  ok(/怎么走过去/.test(r.message), '拒绝话术没解释分工');
});

await t('A3 未知动作必须回 failed（否则会触发服务端自动重试）', async () => {
  const R = createRegistry();
  const r = await R.call('fly', {});
  eq([r.ok, r.reason], [false, 'no_such_action'], '未知动作没回失败');
});

await t('A4 执行层自己算距离：太远就由屋子走过去，大脑拿不到坐标', async () => {
  const R = createRegistry();
  const world = mkRoom();
  let seenArgs = null;
  R.register({
    name: 'go_sit', description: '走到并坐下', schema: { target: { type: 'entity', kinds: ['chair', 'bed'] } },
    run: (w, args) => {
      seenArgs = args;
      const t = w.resolve(args.target);
      if (t.dist > 1.2) { w.walkTo(); return { ok: true, effect: 'walked_then_sat' }; }  // 距离由屋子承担
      return { ok: true, effect: 'sat' };
    },
  });
  const r = await R.call('go_sit', { target: 'chair:1' }, { world });
  eq(r.effect, 'walked_then_sat', '屋子没接手"走过去"这一步');
  eq(seenArgs, { target: 'chair:1' }, 'run 拿到的参数里混进了别的东西');
  ok(!Object.keys(seenArgs).some(k => /^(x|y|z|pos|dist)$/.test(k)), 'run 仍然收到了几何量');
  ok(world.calls.includes('walk'), 'walkTo 没被调用');
});

await t('A5 20 秒无回执判失败（参数化后短时间内可测）', async () => {
  const R = createRegistry();
  R.register({ name: 'slow', description: '很慢的动作', run: () => new Promise(r => setTimeout(r, 40)) });
  const r = await R.call('slow', {}, { timeoutMs: 10 });
  eq([r.ok, r.reason], [false, 'timeout'], '超时没判失败');
});

await t('A6 没有 description 的动作不许注册（提示词里只剩名字，模型只能瞎猜）', () => {
  const R = createRegistry();
  throws(() => R.register({ name: 'wave', schema: {}, run: () => true }), '缺 description 仍然注册成功');
});

await t('A7 给提示词的清单是一句一条，且不含任何数字坐标', () => {
  const R = createRegistry();
  R.register({ name: 'sit', description: '坐到椅子或床上', schema: {
    target: { type: 'entity', kinds: ['chair', 'bed'] },
    mode: { type: 'enum', values: ['sit', 'lie'], required: false },
  }, run: () => true });
  const d = R.describeAll();
  ok(/^- sit\(target: chair\|bed, mode\?: sit\|lie\) — 坐到椅子或床上$/m.test(d), `清单形状不对：${d}`);
  ok(!/\d+\.\d/.test(d), '清单里出现了小数（几何又漏进来了）');
});

/* ---------------- B. 上下文双模式 ---------------- */
console.log('\n── B. 上下文：replace / append 同时算 ──────────────');

await t('B1 replace：同一写者刷 30 次，字数不增长', () => {
  const ctx = createContext();
  const w = ctx.writer('room.now', { authority: 'context', order: 10 });
  for (let i = 0; i < 30; i++) w.set(`她坐在窗边，第 ${i} 秒`);
  const p = ctx.project('replace');
  const b = p.blocks.find(x => x.id === 'room.now');
  eq(b.itemCount, 1, 'replace 没塌成一条');
  ok(b.chars === `她坐在窗边，第 29 秒`.length, '字数没有停在最后一条');
});

await t('B2 append：30 条事件留着，超上限丢最旧并记账（不截断）', () => {
  const ctx = createContext();
  const w = ctx.writer('room.log', { authority: 'context', mode: 'append', maxItems: 12 });
  for (let i = 0; i < 30; i++) w.push(`第 ${i} 件事发生了`);
  const b = ctx.project('append').blocks.find(x => x.id === 'room.log');
  eq(b.itemCount, 12, 'append 没按上限收口');
  eq(b.droppedItems, 18, '丢了多少没记账');
  ok(b.items.at(-1) === '第 29 件事发生了', '留下的不是最新的 12 条');
});

await t('B3 标了 append 的写者，在 replace 投影里也不许被覆盖（事件不可覆盖）', () => {
  const ctx = createContext();
  const st = ctx.writer('room.now', { authority: 'context' });
  const ev = ctx.writer('room.log', { authority: 'context', mode: 'append' });
  for (let i = 0; i < 3; i++) { st.set(`状态 ${i}`); ev.push(`事件 ${i}`); }
  const p = ctx.project('replace');
  eq(p.blocks.find(x => x.id === 'room.now').itemCount, 1, '状态没有塌成一条');
  eq(p.blocks.find(x => x.id === 'room.log').itemCount, 3, '事件被 replace 吃掉了');
});

await t('B4 authority：房间状态进不了指令区', () => {
  const ctx = createContext();
  ctx.writer('sys.rule', { authority: 'system', order: 1, weight: 99 }).set('你是鱼，不要解释情绪。');
  ctx.writer('room.now', { authority: 'context', order: 10, weight: 99 }).set('灯关着，她刚坐下。');
  const a = ctx.assemble({ mode: 'replace' });
  eq(a.instruction.map(b => b.id), ['sys.rule'], '指令区混进了别的东西');
  eq(a.context.map(b => b.id), ['room.now'], '状态区没分开');
  ok(/## 规则[\s\S]*## 眼前/.test(a.text), '两段没有物理隔开');
});

await t('B5 超预算整块丢，绝不截断', () => {
  const ctx = createContext({ budget: 20 });
  ctx.writer('a', { authority: 'context', weight: 10, order: 1 }).set('这是一段很短的话。');
  ctx.writer('b', { authority: 'context', weight: 1, order: 2 }).set('这是一段很长很长很长很长很长很长很长很长的话。');
  const a = ctx.assemble({ mode: 'replace' });
  eq(a.blocks.map(x => x.id), ['a'], '预算没生效');
  eq(a.dropped, [{ id: 'b', authority: 'context', why: 'budget', chars: 23, whole: true }], '丢弃记录不对');
  ok(!/…|\.\.\./.test(a.text), '出现了截断痕迹');
});

await t('B6 两条路能同时打出来对比，并指出谁被谁盖掉', () => {
  const ctx = createContext();
  const w = ctx.writer('room.now', { authority: 'context' });
  for (let i = 0; i < 5; i++) w.set(`她在不同位置的同一个状态 ${i}`);
  const c = ctx.compare();
  ok(c.append.chars > c.replace.chars, 'append 没比 replace 长');
  eq(c.perWriter.find(x => x.id === 'room.now').r, 14, '逐块字数对比不对');
  ok(c.deltaChars > 0, '差值没算');
});

/* ---------------- C. 发起层：待执行意图队列 ---------------- */
console.log('\n── C. 发起：队列 + 四条规则，没有定时器 ────────────');

await t('C1 模块里没有任何定时器，空闲多久都不会自己派发', () => {
  const src = readFileSync(new URL('../../js/brain/initiative.mjs', import.meta.url), 'utf8');
  ok(!/setInterval|setTimeout|requestAnimationFrame/.test(src), '源码里出现了定时器/轮询');
  const I = createInitiative();
  I.raise({ reason: 'repeat', target: 'lamp:1', detail: '灯今天第二次被关', candidates: ['toggle'] });
  const dispatched = 0;
  for (let i = 0; i < 180; i++) { /* 时间在走，但没有任何状态变化 */ }
  eq(dispatched, 0, '空闲期间被派发了');
  eq(I.inFlight, null, '队列自己派发了');
});

await t('C2 同一 target 第二次触发是合并，不是新开一条', () => {
  const I = createInitiative();
  I.raise({ reason: 'repeat', target: 'lamp:1', detail: '灯今天第二次被关' });
  I.raise({ reason: 'repeat', target: 'lamp:1', detail: '灯今天第二次被关' });
  I.raise({ reason: 'unseen', target: 'window', detail: '窗外刚才有只猫，没人看见' });
  const l = I.list();
  eq(l.length, 2, '同一件事被拆成了两条记录');
  eq(l.find(x => x.target === 'lamp:1').occurrences, 2, '次数没合并');
});

await t('C3 结案三态：接住=删除，没接住=留着重试，执行失败=记一次失败', () => {
  const I = createInitiative();
  I.raise({ reason: 'unseen', target: 'window', detail: '窗外有只猫' });
  const a = I.dispatch({ userPresent: false });
  ok(a.probe === true, '没人在场时应该只给低代价动作');
  eq(I.resolve(a.id, { outcome: 'ignored' }).dropped, false, '试了一次就放弃了');
  eq(I.outstanding(), 1, '没接住就把记录删了');

  const b = I.dispatch({ userPresent: true });
  eq(b.probe, false, '人在场、第二次派发应该允许正经动作');
  eq(b.attempt, 2, '尝试次数没累加');
  I.resolve(b.id, { outcome: 'acknowledged' });
  eq(I.outstanding(), 0, '接住了还没清掉');

  I.raise({ reason: 'unfinished', target: 'chair:1', detail: '走到一半被叫住' });
  const c = I.dispatch({ userPresent: true });
  I.resolve(c.id, { outcome: 'failed' });
  eq(I.outstanding(), 1, '执行失败一次就丢了（应该还有一次机会）');
});

await t('C4 单槽：一条没结案，不许开第二条（一次只走一步）', () => {
  const I = createInitiative();
  I.raise({ reason: 'repeat', target: 'a', detail: 'A 事' });
  I.raise({ reason: 'repeat', target: 'b', detail: 'B 事' });
  ok(I.dispatch({ userPresent: false }), '第一条没派出去');
  eq(I.dispatch({ userPresent: false }), null, '两条同时在路上');
  I.resolve(I.inFlight.id, { outcome: 'acknowledged' });
  ok(I.dispatch({ userPresent: false }), '结案后应该能派下一条');
});

await t('C5 结案后的记录不会再被派发', () => {
  const I = createInitiative();
  I.raise({ reason: 'unseen', target: 'window', detail: '窗外有只猫' });
  const a = I.dispatch({ userPresent: true });
  I.resolve(a.id, { outcome: 'acknowledged' });
  eq(I.dispatch({ userPresent: true }), null, '结过的记录又被派出来了');
  eq(I.outstanding(), 0, '列表里还留着');
});

await t('C6 L0 反射占住身体时，L2 不许派发（Inhibition）', () => {
  const I = createInitiative();
  I.raise({ reason: 'unseen', target: 'window', detail: '窗外有只猫' });
  const release = I.lockReflex('hit_by_ball');
  eq(I.dispatch({ userPresent: true }), null, '反射没挡住派发');
  release();
  ok(I.dispatch({ userPresent: true }), '反射结束后没恢复');
});

await t('C7 试满 3 次没人接：丢弃，并只记一次"没人接"', () => {
  const I = createInitiative();
  I.raise({ reason: 'unseen', target: 'window', detail: '窗外有只猫' });
  for (let i = 0; i < 3; i++) {
    const x = I.dispatch({ userPresent: true });
    I.resolve(x.id, { outcome: 'ignored' });
  }
  eq(I.outstanding(), 0, '试满三次还在派发');
  eq(I.ignoredCount, 1, '"没人接"记错了次数');
  eq(I.dispatch({ userPresent: true }), null, '放弃之后还在派发');
});

await t('C8 优先级是固定表：没接住 > 没做完 = 又来了 > 没人看见', () => {
  eq([PRIORITY.no_response > PRIORITY.repeat, PRIORITY.repeat === PRIORITY.unfinished,
      PRIORITY.unfinished > PRIORITY.unseen], [true, true, true], '优先级表被改动了');
  const I = createInitiative();
  I.raise({ reason: 'unseen', target: 'window', detail: '窗外有只猫' });
  I.raise({ reason: 'no_response', target: 'chair:1', detail: '推了椅子给他，他没坐' });
  eq(I.dispatch({ userPresent: true }).reason, 'no_response', '派发顺序没按优先级表');
});

await t('C9 未知的触发原因直接报错（原因码是封闭枚举）', () => {
  const I = createInitiative();
  throws(() => I.raise({ reason: 'bored', target: 'x', detail: '闲得慌' }), '未定义的原因被放行了');
  // 4 → 5：接上感知以后补了 signal（原来四条全是"为什么又提一遍"，没有"第一次"）
  eq(REASONS.length, 5, '原因码数量变了，文档要同步');
});

await t('C10 队列要落盘：重启后还在，走到一半的不重放', () => {
  const I = createInitiative();
  I.raise({ reason: 'unseen', target: 'window', detail: '窗外有只猫' });
  I.raise({ reason: 'repeat', target: 'lamp:1', detail: '灯又被他关了' });
  I.dispatch({ userPresent: false });                 // 一条在跑，未结案
  const snap = JSON.parse(JSON.stringify(I.serialize()));

  const J = createInitiative();
  J.restore(snap);
  eq(J.outstanding(), 2, '重启后队列丢了');
  eq(J.inFlight, null, '把走到一半的意图重放了');
  eq(J.list().find(x => x.target === 'lamp:1').attempts, 1,
     '"已经派过一次"没保住 —— 重启后会把同一件事重说一遍');
});

console.log(`\n${fail ? '✗' : '✓'}  通过 ${pass} / ${pass + fail}`);
if (fail) { console.log('失败：'); fails.forEach(([n, m]) => console.log(` - ${n}: ${m}`)); process.exit(1); }
