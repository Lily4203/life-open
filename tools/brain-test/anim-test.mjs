/* 动作插槽：换一版动作，屋子要不要跟着改
 * ------------------------------------------------------------
 * 这一组不打开浏览器：给它一副假骨头，看它写进去的角度对不对。
 * 真好不好看（穿不穿模、像不像人）只能靠眼睛，那是另一回事——
 * 这里只验四件**能验**的事：
 *   ① 左右反相（不反相就是同手同脚）
 *   ② 相位跟距离走（跟时间走就是滑步）
 *   ③ 差分记账不发散（写错一次，几十帧后骨头会歪到回不来）
 *   ④ 坐着躺着不乱摆腿
 */

import { defineAnimator, createAnimatorSet, CLIPS } from '../../js/room/anim/index.mjs';
import { procedural, STRIDE } from '../../js/room/anim/procedural.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(a === b, name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);
const near = (a, b, tol, name) => ok(Math.abs(a - b) <= tol, name, `得到 ${a}，要 ${b}±${tol}`);

const BONE_NAMES = ['spine', 'chest', 'leftUpperLeg', 'rightUpperLeg',
  'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot',
  'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];

function rig() {
  const bones = new Map(BONE_NAMES.map(n => [n, { rotation: { x: 0, y: 0, z: 0 } }]));
  return { bone: n => bones.get(n) || null, bones, get: n => bones.get(n).rotation };
}

function makeSet() {
  const set = createAnimatorSet();
  set.register(procedural());
  return set;
}

const step = (A, dt = 1 / 60, ctx = {}) => A.update(dt, { speed: 0.9, pose: 'stand', ...ctx });

/* ================= A. 契约 ================= */
console.log('\nA. 一个动作要长什么样（不合格当场说）');
{
  let e = null;
  try { defineAnimator({ mount() {}, update() {}, clips: ['walk'] }); } catch (x) { e = x; }
  ok(e && /id/.test(e.message), 'A1 没 id 不行');

  e = null;
  try { defineAnimator({ id: 'ok', update() {}, clips: ['walk'] }); } catch (x) { e = x; }
  ok(e && /mount/.test(e.message), 'A2 没 mount 不行');

  e = null;
  try { defineAnimator({ id: 'ok', mount() {}, clips: ['walk'] }); } catch (x) { e = x; }
  ok(e && /update/.test(e.message), 'A3 没 update 不行');

  e = null;
  try { defineAnimator({ id: 'ok', mount() {}, update() {}, clips: [] }); } catch (x) { e = x; }
  ok(e && /clips/.test(e.message), 'A4 一个动作都不声明不行');

  e = null;
  try { defineAnimator({ id: 'ok', mount() {}, update() {}, clips: ['dance'] }); } catch (x) { e = x; }
  ok(e && /dance/.test(e.message), 'A5 声明了词表外的动作不行（' + CLIPS.join('/') + '）');

  const a = defineAnimator({ id: 'x', mount() {}, update() {}, clips: ['walk'] });
  eq(a.label, 'x', 'A6 没 label 就用 id，不编一个名字');
}

/* ================= B. 注册表 ================= */
console.log('\nB. 换一版：要谁给谁，要不到要说出来');
{
  const set = makeSet();
  eq(set.size(), 1, 'B1 注册了一个');
  const a = set.create('procedural', rig());
  eq(a.fallback, false, 'B2 点名的那个存在，不算退回');

  const b = set.create('nope', rig());
  eq(b.fallback, true, 'B3 要的没有 → 退回第一个，并且标 fallback（不许悄悄换）');
  eq(b.id, 'procedural', 'B4 退回的是确实注册过的那个');

  set.register({ id: 'procedural', label: '第二版', mount() { return {}; }, update() {}, clips: ['idle'] });
  eq(set.get('procedural').label, '第二版', 'B5 同名覆盖（房间热重载会再注册一遍，不能崩）');
}

/* ================= C. 走路 ================= */
console.log('\nC. 走路：左右反相、膝盖只往一个方向弯');
{
  const r = rig();
  const A = makeSet().create('procedural', r);
  for (let i = 0; i < 30; i++) step(A);        // 走半秒，权重和相位都起来了

  const l = r.get('leftUpperLeg').x, rl = r.get('rightUpperLeg').x;
  ok(Math.abs(l) > 0.01, 'C1 左腿真的在动（不是原地滑）');
  ok(l * rl < 0, 'C2 左腿和右腿反相（同号就是同手同脚）');

  let kneeMin = Infinity, kneeMax = -Infinity;
  const r2 = rig();
  const A2 = makeSet().create('procedural', r2);
  for (let i = 0; i < 120; i++) {
    step(A2);
    const k = r2.get('leftLowerLeg').x;
    kneeMin = Math.min(kneeMin, k); kneeMax = Math.max(kneeMax, k);
  }
  ok(kneeMin >= -1e-9, 'C3 膝盖不往反方向折（人的膝盖不会向前踢）');
  ok(kneeMax > 0.3, 'C4 但确实会弯（一直直着就是拄拐走）');
}

/* ================= D. 相位跟距离走 ================= */
console.log('\nD. 步频跟着速度，不跟着时间');
{
  /* 半个周期 = 走 STRIDE/2 米。用 dt=1 秒、speed=STRIDE/2 米每秒，正好半步。 */
  const r = rig();
  const A = makeSet().create('procedural', r);
  A.update(1, { speed: STRIDE / 2, pose: 'stand' });
  const st = A.state();
  near(st.phase, Math.PI, 0.02, 'D1 走半个周期那么远，相位正好半圈');

  /* 同样一秒，走得快一倍 → 相位也快一倍（不是按时间给固定的摆幅） */
  const r2 = rig();
  const B = makeSet().create('procedural', r2);
  B.update(1, { speed: STRIDE, pose: 'stand' });
  near(B.state().phase, 0, 0.02, 'D2 走一整圈回到原点（相位会绕回来，不会无限涨）');
}

/* ================= E. 停下就停腿 ================= */
console.log('\nE. 站住：腿回正，不是停在半空');
{
  const r = rig();
  const A = makeSet().create('procedural', r);
  for (let i = 0; i < 60; i++) step(A);
  ok(Math.abs(r.get('leftUpperLeg').x) > 0.01, 'E1 走着的时候腿是抬着的');

  for (let i = 0; i < 120; i++) step(A, 1 / 60, { speed: 0 });
  near(r.get('leftUpperLeg').x, 0, 0.01, 'E2 停两秒后大腿回到 0（权重渐变，不是硬切）');
  near(r.get('leftLowerLeg').x, 0, 0.01, 'E3 膝盖也回 0');
  eq(A.state().weight, 0, 'E4 权重归零');
}

/* ================= F. 差分记账不发散 ================= */
console.log('\nF. 跑十分钟，骨头不会歪到回不来');
{
  const r = rig();
  const A = makeSet().create('procedural', r);
  /* 3000 帧 ≈ 50 秒，速度在 0~1.2 之间来回变——加速、减速、停、再走。 */
  let worst = 0;
  for (let i = 0; i < 3000; i++) {
    const speed = (Math.sin(i / 40) + 1) * 0.6;
    step(A, 1 / 60, { speed });
    for (const n of BONE_NAMES) worst = Math.max(worst, Math.abs(r.get(n).x), Math.abs(r.get(n).y), Math.abs(r.get(n).z));
  }
  ok(worst < 1.6, 'F1 任何骨头都没超过 1.6 弧度（记账写错就会一路涨上去）', `最大 ${worst.toFixed(2)}`);

  /* 再走 3000 帧，最大值不该变——真的发散的话它一定继续涨。 */
  let worst2 = 0;
  for (let i = 0; i < 3000; i++) {
    step(A, 1 / 60, { speed: (Math.cos(i / 37) + 1) * 0.6 });
    for (const n of BONE_NAMES) worst2 = Math.max(worst2, Math.abs(r.get(n).x));
  }
  ok(worst2 < 1.6, 'F2 再跑 50 秒还是不越界（不累积漂移）', `最大 ${worst2.toFixed(2)}`);
}

/* ================= G. 坐着躺着不摆腿 ================= */
console.log('\nG. 坐着、躺着：位置变了不等于走了两步');
{
  const r = rig();
  const A = makeSet().create('procedural', r);
  for (let i = 0; i < 60; i++) A.update(1 / 60, { speed: 1.5, pose: 'sit' });
  near(r.get('leftUpperLeg').x, 0, 0.001, 'G1 坐着时速度再大，腿也不摆（那是换了个地方，不是走）');
  eq(A.state().weight, 0, 'G2 权重一直是 0');

  for (let i = 0; i < 60; i++) A.update(1 / 60, { speed: 1.5, pose: 'lie' });
  near(r.get('leftUpperLeg').x, 0, 0.001, 'G3 躺着也一样');
}

/* ================= H. forget：applyPose 重摆之后 ================= */
console.log('\nH. 屋子重摆姿势之后，不能算两遍');
{
  const r = rig();
  const A = makeSet().create('procedural', r);
  for (let i = 0; i < 30; i++) step(A);

  /* 模拟 applyPose：把骨头设成绝对值（坐下时那一串），腿回到 0。
   * 这时候如果没有 forget，下一帧只会补"和上一帧的差"——几乎为 0，腿就僵在那儿；
   * forget 之后才是从当前姿势起算的完整一份。 */
  const zero = () => { for (const n of BONE_NAMES) { r.get(n).x = 0; r.get(n).y = 0; r.get(n).z = 0; } };

  zero();
  A.update(1 / 60, { speed: 0.9, pose: 'stand' });
  const noForget = Math.abs(r.get('leftUpperLeg').x);

  zero();
  A.forget();
  A.update(1 / 60, { speed: 0.9, pose: 'stand' });
  const withForget = Math.abs(r.get('leftUpperLeg').x);

  ok(noForget < 0.05, 'H1 不 forget：只补了相邻两帧的差，骨头几乎不动（腿会僵住）', `${noForget}`);
  ok(withForget > 0.1, 'H2 forget 之后：从当前姿势重新起算，是完整一份', `${withForget}`);
}

/* ================= I. bob ================= */
console.log('\nI. 落脚那一下');
{
  const r = rig();
  const A = makeSet().create('procedural', r);
  let lo = 0, hi = 0;
  for (let i = 0; i < 200; i++) {
    const o = step(A);
    if (o && typeof o.bob === 'number') { lo = Math.min(lo, o.bob); hi = Math.max(hi, o.bob); }
  }
  ok(lo < -0.005, 'I1 走起来人真的会往下沉一点');
  ok(hi <= 1e-9, 'I2 但不会往上飘（下沉是唯一的，浮起来就是被吊着）');
  ok(lo > -0.05, 'I3 也不会陷进地里');
}

console.log(`\n全过：${pass} 过，${fail} 不过`);
process.exit(fail ? 1 : 0);
