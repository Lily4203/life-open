/* 感知层断言：世界变了 → 报告 → 入队；世界没变 → 一个字节都不产生
 * ------------------------------------------------------------
 * 跑：cd life/tools/brain-test && node perception-test.mjs
 *
 * 这里测的不是"她会不会反应"（那是模型的事），是"屋子报得对不对"。
 * 报错了模型再聪明也救不回来，报多了她会跟空气较劲。
 */

import { createPerception, loadRules, CHANGE_TYPES } from '../../js/brain/perception.mjs';
import { normalizeWorld, diffWorld, worldSignature } from '../../js/brain/world.mjs';
import { createInitiative, REASONS } from '../../js/brain/initiative.mjs';
import fs from 'node:fs';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}｜期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m); };
const throws = (fn, m) => { try { fn(); } catch { return; } throw new Error(m); };

const W = (pose, lights = {}, near = null) => ({ pose, near, lights });
const WP = (present, pose = '站着', lights = {}) => ({ pose, near: null, lights, present });
const rulesFile = JSON.parse(fs.readFileSync(new URL('../../rules/room.json', import.meta.url), 'utf8'));

console.log('A. 世界快照的形状');

await t('A1 英文姿态变中文（"我stand"就是这么来的）', () => {
  eq(normalizeWorld({ pose: 'stand' }).pose, '站着', 'A1');
  eq(normalizeWorld({ pose: 'walking' }).pose, '走着', 'A1');
});

await t('A2 lights 的值强制成布尔，未知字段被丢掉', () => {
  const n = normalizeWorld({ pose: 'sit', lights: { 台灯: 1, 顶灯: 0 }, x: 1.22, z: -0.5 });
  eq(n.lights.台灯, true, 'A2 台灯');
  eq(n.lights.顶灯, false, 'A2 顶灯');
  ok(!('x' in n), 'A2 坐标漏进快照了');
});

await t('A3 做差只报变了的那几件，顺序固定', () => {
  const d = diffWorld(W('站着', { 台灯: true, 顶灯: true }), W('坐着', { 台灯: false, 顶灯: true }));
  eq(d.length, 2, 'A3 变化条数');
  eq(d[0].type, 'pose', 'A3 第一条是姿态');
  eq(d[1].type, 'light', 'A3 第二条是灯');
  eq(d[1].label, '台灯', 'A3 灯的名字');
});

await t('A4 一样的快照签名字节相同（at 不参与）', () => {
  eq(worldSignature({ pose: 'sit', lights: { 台灯: true }, at: 1 }),
     worldSignature({ pose: 'sit', lights: { 台灯: true }, at: 999 }), 'A4');
});

console.log('B. 规则文件');

await t('B1 房间的规则文件本身是合法的', () => {
  const list = loadRules(rulesFile);
  ok(list.length >= 2, 'B1 规则太少');
  ok(list.every(r => REASONS.includes(r.emit.reason)), 'B1 有规则用了不存在的原因码');
});

await t('B2 规则写错要当场报，不许默默不生效', () => {
  throws(() => loadRules([{ id: 'x', when: { change: 'mood' }, emit: { reason: 'signal', target: 't', detail: 'd' } }]), 'B2 change 写错没报');
  throws(() => loadRules([{ id: 'x', when: { change: 'light' }, emit: { reason: 'bored', target: 't', detail: 'd' } }]), 'B2 reason 写错没报');
  throws(() => loadRules([{ id: 'x', when: { change: 'light' }, emit: { reason: 'signal', target: 't' } }]), 'B2 缺 detail 没报');
  throws(() => loadRules([{ id: 'x', when: { change: 'light', colour: 1 }, emit: { reason: 'signal', target: 't', detail: 'd' } }]), 'B2 不认识的 when 字段没报');
  throws(() => loadRules([
    { id: 'dup', when: { change: 'light' }, emit: { reason: 'signal', target: 'a', detail: 'd' } },
    { id: 'dup', when: { change: 'pose' }, emit: { reason: 'signal', target: 'b', detail: 'd' } },
  ]), 'B2 重复 id 没报');
});

await t('B3 变化类型是封闭枚举', () => {
  eq(CHANGE_TYPES.join(','), 'pose,near,light,present', 'B3');
});

console.log('C. 看一眼世界');

await t('C1 第一次只立基线，不报"灯本来是亮的"', () => {
  const P = createPerception({ rules: rulesFile });
  const r = P.observe(W('站着', { 台灯: true }));
  eq(r.baseline, true, 'C1');
  eq(r.raised.length, 0, 'C1 开机就报了一次');
});

await t('C2 世界没变：没有任何变化、没有记录、不花钱', () => {
  const P = createPerception({ rules: rulesFile });
  P.observe(W('站着', { 台灯: true }));
  const r = P.observe(W('站着', { 台灯: true }));
  eq(r.changes.length, 0, 'C2');
  eq(r.raised.length, 0, 'C2');
  eq(P.observations, 0, 'C2 没变化却记了一次观察');
});

await t('C3 他关灯 → 入队一条，detail 是那句话', () => {
  const ini = createInitiative();
  const P = createPerception({ rules: rulesFile, raise: o => ini.raise(o) });
  P.observe(W('站着', { 台灯: true }));
  const r = P.observe(W('站着', { 台灯: false }), { by: 'him' });
  eq(r.raised.length, 1, 'C3 入队条数');
  eq(r.raised[0].rule, 'light_off', 'C3');
  eq(r.raised[0].detail, '台灯刚被关掉了。', 'C3 detail');
  eq(ini.list().length, 1, 'C3 队列里没东西');
  eq(ini.list()[0].target, 'light:台灯', 'C3 target 没代入名字');
});

await t('C4 她自己关的灯不报给她自己（否则会跟自己较劲）', () => {
  const ini = createInitiative();
  const P = createPerception({ rules: rulesFile, raise: o => ini.raise(o) });
  P.observe(W('站着', { 台灯: true }));
  const r = P.observe(W('站着', { 台灯: false }), { by: 'her' });
  eq(r.raised.length, 0, 'C4 自己做的又报回来了');
  eq(r.unhandled.length, 1, 'C4 应该落在"没人管"里，好查');
});

await t('C5 同一盏灯第二次：原因码从 signal 变 repeat', () => {
  const seen = [];
  const P = createPerception({ rules: rulesFile, raise: o => { seen.push(o.reason); return o; } });
  P.observe(W('站着', { 台灯: true }));
  P.observe(W('站着', { 台灯: false }), { by: 'him' });
  P.observe(W('站着', { 台灯: true }), { by: 'him' });
  P.observe(W('站着', { 台灯: false }), { by: 'him' });
  eq(seen[0], 'signal', 'C5 第一次');
  eq(seen[2], 'repeat', 'C5 第三次（同一盏灯第 2 回灭）');
});

await t('C6 规则按顺序：窗帘走自己那条，不会同时中灯那条', () => {
  const seen = [];
  const P = createPerception({ rules: rulesFile, raise: o => { seen.push(o.rule || o.detail); return o; } });
  P.observe(W('站着', { 窗帘: true, 台灯: true }));
  const r = P.observe(W('站着', { 窗帘: false, 台灯: true }), { by: 'him' });
  eq(r.raised.length, 1, 'C6 一条变化被两条规则各报了一次');
  eq(r.raised[0].rule, 'curtain_closed', 'C6');
  eq(r.raised[0].detail, '窗帘刚被拉上了，屋里暗了一截。', 'C6');
});

await t('C7 没有规则管的变化进 unhandled（缺口要看得见）', () => {
  const P = createPerception({ rules: rulesFile });
  P.observe(W('站着', {}));
  const r = P.observe(W('坐着', {}), { by: 'her' });
  eq(r.changes.length, 1, 'C7');
  eq(r.unhandled.length, 1, 'C7');
  eq(r.unhandled[0].type, 'pose', 'C7');
});

await t('C8 换场景 reset 之后重新立基线', () => {
  const P = createPerception({ rules: rulesFile });
  P.observe(W('站着', { 台灯: true }));
  P.reset();
  const r = P.observe(W('坐着', { 台灯: false }), { by: 'him' });
  eq(r.baseline, true, 'C8 没重新立基线');
  eq(r.raised.length, 0, 'C8 reset 之后还报了一次');
});

await t('C9 整条链：灯灭 → 队列 → 派发时给的是"先探一下"', () => {
  const ini = createInitiative();
  const P = createPerception({ rules: rulesFile, raise: o => ini.raise(o) });
  P.observe(W('站着', { 台灯: true }));
  P.observe(W('站着', { 台灯: false }), { by: 'him' });
  const item = ini.dispatch({ userPresent: false, busy: false });
  ok(item, 'C9 没派发');
  eq(item.probe, true, 'C9 第一次该是探一下');
  ok(item.candidates.includes('look_at'), 'C9 候选里没有最轻的动作');
  eq(item.reason, 'signal', 'C9 原因码');
});

await t('C10 空快照（场景还没加载好）不算"所有灯都灭了"', () => {
  const ini = createInitiative();
  const P = createPerception({ rules: rulesFile, raise: o => ini.raise(o) });
  P.observe(W('站着', { 台灯: true }));
  const r = P.observe({}, { by: 'him' });
  eq(r.invalid, true, 'C10 空快照被当成有效世界了');
  eq(ini.list().length, 0, 'C10 空快照报出了假事件');
  // 基线不能被空快照冲掉：下一张真快照仍和"站着 / 台灯亮"比
  const r2 = P.observe(W('站着', { 台灯: false }), { by: 'him' });
  eq(r2.raised.length, 1, 'C10 基线被空快照冲掉了');
});

console.log('D. 他在不在');

await t('D1 他走了 → 入队一条"屋里只剩你"', () => {
  const ini = createInitiative();
  const P = createPerception({ rules: rulesFile, raise: o => ini.raise(o) });
  P.observe(WP(true));
  const r = P.observe(WP(false), { by: 'him' });
  eq(r.changes.length, 1, 'D1 present 变化没报');
  eq(r.changes[0].type, 'present', 'D1 变化类型');
  eq(r.raised.length, 1, 'D1 没入队');
  ok(r.raised[0].detail.includes('只剩你'), 'D1 detail 不是那句话');
});

await t('D2 他回来 → 另一条，不是同一条', () => {
  const ini = createInitiative();
  const P = createPerception({ rules: rulesFile, raise: o => ini.raise(o) });
  P.observe(WP(false));
  const r = P.observe(WP(true), { by: 'him' });
  eq(r.raised[0].detail, '他回来了。', 'D2 back 的 detail');
  eq(r.raised[0].target, 'present:him', 'D2 target 要能合并成一条');
});

await t('D3 不知道他在不在（null）不算变化', () => {
  const P = createPerception({ rules: rulesFile });
  P.observe(WP(true));
  const r = P.observe({ pose: '站着', lights: { 台灯: true } }, { by: 'him' });
  eq(r.changes.filter(c => c.type === 'present').length, 0, 'D3 不知道他在不在，却被当成了"他走了"');
});

await t('D4 签名里带 present：只有他走人，也算世界变了', () => {
  ok(worldSignature(WP(true)) !== worldSignature(WP(false)), 'D4 present 没进签名');
});

console.log('E. 事件通道（没有恢复的那种事）');

/* 事件类规则：现在网页里没有事件源，所以这是给桌面壳/游戏留的门。
   门要能通，而且不能跟快照那条路混。 */
const EVT_RULES = {
  rules: [
    { id: 'app_focus', when: { event: 'app_focus' },
      emit: { reason: 'signal', target: 'app:focus', detail: '他切到别的地方去了。', candidates: ['look_at'] } },
    { id: 'file_drop', when: { event: 'file_drop' },
      emit: { reason: 'signal', target: 'app:file', detail: '他往这儿拖了个东西：{{text}}', candidates: [] } },
  ],
};

await t('E1 投递一件事 → 入队一条', () => {
  const ini = createInitiative();
  const P = createPerception({ rules: EVT_RULES, raise: o => ini.raise(o) });
  const r = P.signal({ type: 'app_focus' });
  eq(r.matched, true, 'E1 事件没命中规则');
  eq(r.target, 'app:focus', 'E1 target 不对');
  eq(ini.list().length, 1, 'E1 队列里没有这一条');
});

await t('E2 事件自己带的话能填进 detail', () => {
  const P = createPerception({ rules: EVT_RULES });
  const r = P.signal({ type: 'file_drop', detail: '一张照片' });
  eq(r.detail, '他往这儿拖了个东西：一张照片', 'E2 模板没取到事件正文');
});

await t('E3 没有规则管的事件：不入队，但要留痕', () => {
  const ini = createInitiative();
  const P = createPerception({ rules: EVT_RULES, raise: o => ini.raise(o) });
  const r = P.signal({ type: 'nobody_cares' });
  eq(r.matched, false, 'E3 没规则也算命中');
  eq(ini.list().length, 0, 'E3 没规则却入了队');
  ok(P.log().some(x => x.op === 'unhandled_event' && x.event === 'nobody_cares'), 'E3 没留痕，以后查不出来');
});

await t('E4 同一件事第二次 → repeat，不是又开一条', () => {
  const ini = createInitiative();
  const P = createPerception({ rules: EVT_RULES, raise: o => ini.raise(o) });
  P.signal({ type: 'app_focus' });
  const r = P.signal({ type: 'app_focus' });
  eq(r.reason, 'repeat', 'E4 第二次没降级成 repeat');
  eq(ini.list().length, 1, 'E4 队列里应该还是一条');
});

await t('E5 没有 type 的事件直接拒收', () => {
  const P = createPerception({ rules: EVT_RULES });
  let threw = false;
  try { P.signal({}); } catch { threw = true; }
  ok(threw, 'E5 没名字的事件被收下了');
});

await t('E6 一条规则不能同时等"变化"和"事件"', () => {
  let threw = false;
  try {
    loadRules({ rules: [{ id: 'x', when: { change: 'pose', event: 'app_focus' }, emit: { reason: 'signal', target: 't', detail: 'd' } }] });
  } catch { threw = true; }
  ok(threw, 'E6 两条路混在一起居然通过了校验');
});

await t('E7 事件规则里写 from/to 要当场报错', () => {
  let threw = false;
  try {
    loadRules({ rules: [{ id: 'y', when: { event: 'app_focus', from: 'a' }, emit: { reason: 'signal', target: 't', detail: 'd' } }] });
  } catch { threw = true; }
  ok(threw, 'E7 事件没有"从什么变成什么"，写了居然不报错');
});

await t('E8 事件不碰快照基线', () => {
  const P = createPerception({ rules: EVT_RULES });
  P.observe(WP(true));
  P.signal({ type: 'app_focus' });
  const r = P.observe(WP(true));       // 世界没变
  eq(r.changes.length, 0, 'E8 投了个事件，却把世界变化算乱了');
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
