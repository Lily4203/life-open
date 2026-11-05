/* 游戏端口：她能玩，但坐标不进大脑
 * ------------------------------------------------------------
 * 这组断言测五件事：
 *   A  适配器不合格，当场拦住
 *   B  游戏动作和屋子动作走同一张表：schema、窗口、超时都一样
 *   C  局面里带坐标的键会被丢掉（她看不到像素）
 *   D  游戏回一句，她才能接着玩；不是定时器在催
 *   E  猜数字真能玩完一局（流程，不是假数据）
 *
 * 跑：node tools/brain-test/game-test.mjs
 */

import fs from 'node:fs';
import { createGameBridge, sanitizeState } from '../../js/brain/game-bridge.mjs';
import { createRegistry } from '../../js/brain/actions.mjs';
import { createExecutor } from '../../js/brain/executor.mjs';
import { guessGame } from '../../js/brain/games/guess.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name,
  `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

function fakePerception() {
  const seen = [];
  return { seen, signal: ev => { seen.push(ev); return { matched: true, event: ev.type }; } };
}

const game = (over = {}) => ({
  id: 'g1', name: '测试游戏', mode: 'api',
  actions: [{ name: 'g_move', description: '走一步', intent: '走一步', schema: { to: { type: 'enum', values: ['a', 'b'] } } }],
  state: () => ({ turn: 1, hand: ['牌1', '牌2'] }),
  brief: () => '轮到你出牌。',
  act: async () => ({ ok: true, effect: '走了一步' }),
  ...over,
});

console.log('\nA. 不合格的适配器，当场拦住');

{
  const throws = fn => { try { fn(); return false; } catch { return true; } };
  const b = createGameBridge({ registry: createRegistry() });
  ok(throws(() => b.attach(null)), 'A1 不是对象不行');
  ok(throws(() => b.attach(game({ id: 'G 1' }))), 'A2 id 不合法不行');
  ok(throws(() => b.attach(game({ mode: 'video' }))), 'A3 mode 只能是 api/screen');
  ok(throws(() => b.attach(game({ act: null }))), 'A4 没有 act 不行（动作得有人执行）');
  ok(throws(() => b.attach(game({ actions: [] }))), 'A5 没有动作不行');
  ok(throws(() => b.attach(game({ actions: [{ name: 'x' }] }))), 'A6 动作没有 description 不行');
}

console.log('\nB. 游戏动作和屋子动作走同一张表');

{
  const perception = fakePerception();
  const R = createRegistry();
  const b = createGameBridge({ registry: R, perception });
  const r = b.attach(game());
  eq(r.ok, true, 'B1 能接上');
  ok(R.has('g_move'), 'B2 动作进了注册表');
  ok(R.has('stop_game'), 'B3 停这一局也是个动作');
  eq(b.windowFor().names.includes('g_move'), true, 'B4 窗口里有游戏动作');
}

{
  const R = createRegistry();
  R.register({ name: 'g_move', description: '屋子自己的同名动作', run: () => ({ ok: true }) });
  const b = createGameBridge({ registry: R });
  let msg = '';
  try { b.attach(game()); } catch (e) { msg = e.message; }
  ok(/撞名/.test(msg), 'B5 和屋子动作撞名要报错，不能悄悄覆盖');
  ok(R.has('g_move'), 'B6 原来的动作还在（attach 失败要回滚）');
}

{
  const R = createRegistry();
  const b = createGameBridge({ registry: R });
  b.attach(game());
  R.openWindow({ names: ['stop_game'] });
  const r = await b.call('g_move', { to: 'a' });
  eq(r.ok, false, 'B7 窗口外的游戏动作也不许做');
  eq(r.reason, 'not_in_window', 'B8 和屋子动作同一条规矩');
  R.closeWindow();
}

{
  const R = createRegistry();
  let called = 0;
  const b = createGameBridge({ registry: R });
  b.attach(game({ act: async () => { called++; return { ok: true, effect: '走了' }; } }));
  const bad = await b.call('g_move', { to: 'z' });
  eq(bad.ok, false, 'B9 参数不在枚举里，拒绝');
  eq(called, 0, 'B10 适配器根本没被调到（校验在它前面）');
  const geo = await b.call('g_move', { to: 'a', x: 120 });
  eq(geo.ok, false, 'B11 带坐标的调用也拒绝');
  eq(geo.reason, 'geometry_not_allowed', 'B12 和屋子动作同一个原因码');
}

console.log('\nC. 局面里不许有坐标');

{
  const s = sanitizeState({ turn: 2, x: 120, y: 340, cursor: { x: 1 }, hand: [{ name: '牌1', bbox: [0,0,10,10] }], ok: true });
  eq(s, { turn: 2, hand: [{ name: '牌1' }], ok: true }, 'C1 坐标、光标、包围盒都被丢掉');
  eq(sanitizeState({ deep: { a: { b: { c: { d: 1 } } } } }), { deep: { a: {} } }, 'C2 太深的结构不收（最多三层）');

  const R = createRegistry();
  const b = createGameBridge({ registry: R });
  b.attach(game({ state: () => ({ turn: 1, click: { x: 10, y: 20 }, hand: ['牌1'] }) }));
  const st = b.state();
  eq(st.click, undefined, 'C3 适配器塞进来的点击坐标，在出口就被删了');
  eq(st.hand, ['牌1'], 'C4 该留的还留着');
  ok(!/x|y/.test(JSON.stringify(st)), 'C5 整个局面里没有坐标键');
}

console.log('\nD. 游戏回一句，她才能接着玩');

{
  const perception = fakePerception();
  const R = createRegistry();
  const b = createGameBridge({ registry: R, perception });
  const g = game({
    actions: [{ name: 'g_move', description: '走一步' }],
    act: async () => {
      b.emit('game_turn', '轮到你了');
      return { ok: true, effect: '走了一步' };
    },
  });
  b.attach(g);
  await b.call('g_move', {});
  eq(perception.seen.length, 1, 'D1 游戏投了一件事');
  eq(perception.seen[0].type, 'game_turn', 'D2 事件类型对');
  eq(perception.seen[0].detail, '轮到你了', 'D3 事件那句话进提示词');
  eq(perception.seen[0].by, 'game', 'D4 来源是游戏，不是他');
}

{
  const R = createRegistry();
  const b = createGameBridge({ registry: R });
  b.attach(game());
  ok(/轮到你出牌/.test(b.brief()), 'D5 局面说明进提示词');
  ok(/测试游戏/.test(b.brief()), 'D6 她知道自己正在玩什么');
  ok(/g_move/.test(b.brief()) === false, 'D7 动作不重复写两遍（动作表里已经有了）');
}

console.log('\nE. 停：她不想玩了就退出来');

{
  const R = createRegistry();
  const b = createGameBridge({ registry: R });
  b.attach(game());
  const r = await b.call('stop_game', {});
  eq(r.ok, true, 'E1 停得掉');
  eq(b.current, null, 'E2 没有当前游戏了');
  ok(!R.has('g_move'), 'E3 游戏动作收走了');
  const after = await b.call('g_move', { to: 'a' });
  eq(after.reason, 'no_game', 'E4 停了以后不再认这个动作');
  ok(R.isDying('g_move') === false, 'E5 停游戏不走 10 秒宽限（它不是重载，是真的结束了）');
}

console.log('\nF. 猜数字：真玩一局');

{
  const R = createRegistry();
  const b = createGameBridge({ registry: R });
  const g = guessGame({ min: 1, max: 100, rng: () => 0.41 });   // 42
  b.attach(g);
  eq(b.state().status, '进行中', 'F1 开局是进行中');
  const r1 = await b.call('guess_number', { n: 50 });
  eq(r1.ok, true, 'F2 猜 50 能做');
  ok(/大了/.test(r1.effect), 'F3 50 比 42 大', r1.effect);
  eq([b.state().lo, b.state().hi], [1, 49], 'F4 范围缩到 1~49');
  const r2 = await b.call('guess_number', { n: 10 });
  ok(/小了/.test(r2.effect), 'F5 10 比 42 小', r2.effect);
  eq([b.state().lo, b.state().hi], [11, 49], 'F6 范围缩到 11~49');
  const r3 = await b.call('guess_number', { n: 42 });
  ok(/对了/.test(r3.effect), 'F7 猜中');
  eq(b.state().status, '结束了', 'F8 猜中就结束');
  const r4 = await b.call('guess_number', { n: 20 });
  eq(r4.ok, false, 'F9 结束了不能再猜');
}

{
  const g = guessGame({ min: 1, max: 100, rng: () => 0.41 });
  g.start({ emit: () => {}, autoContinue: false });
  await g.act('guess_number', { n: 50 });
  const st = g.state();
  eq(st.tries, 1, 'F10 记次数');
  const again = await g.act('guess_number', { n: 50 });
  ok(again.already, 'F11 同一个数再猜一次，不算新的一次');
  eq(g.state().tries, 1, 'F12 次数没涨');
  eq([g.state().lo, g.state().hi], [1, 49], 'F13 范围也没动');
}

{
  const seen = [];
  const g = guessGame({ min: 1, max: 20, maxTurns: 3, rng: () => 0.5 });  // 11
  g.start({ emit: (t, d) => seen.push({ t, d }), autoContinue: true });
  await g.act('guess_number', { n: 1 });
  eq(seen.filter(x => x.t === 'game_turn').length, 1, 'F14 错一次，游戏回一句，她可以接着玩');
  await g.act('guess_number', { n: 2 });
  await g.act('guess_number', { n: 3 });
  ok(seen.some(x => x.t === 'game_over'), 'F15 次数用完，游戏结束');
  eq(g.state().status, '结束了', 'F16 状态是结束');
}

console.log('\nG. 执行层把游戏的动作交给游戏');

{
  const R = createRegistry();
  const perception = fakePerception();
  const b = createGameBridge({ registry: R, perception });
  b.attach(guessGame({ min: 1, max: 10, rng: () => 0.5 }));
  const ex = createExecutor({ registry: R, game: b });
  const r = await ex.act('guess_number', { n: 5 });
  eq(r.port, 'game', 'G1 回执标的是游戏');
  eq(r.ok, true, 'G2 真跑成了');
  ok(/小了|大了|对了/.test(r.effect), 'G3 游戏说了结果', r.effect);
}

console.log('\nH. 这个文件里没有"想"');

{
  const src = fs.readFileSync(new URL('../../js/brain/game-bridge.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/\bchat\s*\(/.test(src), 'H1 不调模型');
  ok(!/buildSystem|buildWakeSystem|parseOut/.test(src), 'H2 不拼提示词');
  ok(!/memory\.(boot|plan|closeAgenda|nextAgenda)/.test(src), 'H3 不碰记忆和议程');
  ok(!/\bfetch\s*\(/.test(src), 'H4 不发请求');
  ok(!/screenX|screenY|clientX|clientY/.test(src), 'H5 不碰屏幕坐标');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
