/* 模型导入：一个 .vrm 能不能进房间
 * ------------------------------------------------------------
 * 这一组守的是 model-import.mjs 开头那条规矩：
 *   **进房间的门槛是骨骼，不是外观。**
 * 一个缺 hips 的模型照样渲染得出来，然后所有动作从错误的地方起算——
 * 那种错看起来像我们的 bug，实际是模型不合格。
 *
 *   A  slugify：文件名要能同时被 git / URL / shell 安全处理
 *   B  inspect：缺什么、为什么、人话怎么说
 *   C  登记项形状：和 characters.json 里现有条目一字不差（差一个字段面板就点不动）
 *   D  源码契约：这是浏览器模块，不许碰文件系统
 *
 * 不加载真 VRM（那要 WebGL）：summarize 的产物在这里手写，
 * 判定逻辑是纯函数，所以"什么算能用"这件事完全可测。
 *
 * 跑：node tools/brain-test/model-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  slugify, inspect, toAvatarModel,
  REQUIRED_BONES, HEIGHT_MIN, HEIGHT_MAX, MATERIAL_WARN,
} from '../../js/room/model-import.mjs';

const LIFE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name,
  JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));

/* 一个"合格的"摘要：拿它当基线，每次只改一处，看判定怎么变。
 * 这样每条断言都只证明一件事。 */
const good = () => ({
  isVRM: true,
  hasHumanoid: true,
  bones: REQUIRED_BONES.slice(),
  height: 1.357,
  materials: 44,
  expressions: 80,
  metaVersion: '0',
  author: '某人',
});

console.log('A. 文件名（它会变成磁盘上的名字，也会进 URL）');

{
  eq(slugify('MyModel'), 'mymodel', 'A1 大写转小写');
  eq(slugify('my model'), 'my-model', 'A2 空格变连字符');
  eq(slugify('a/b\\c'), 'a-b-c', 'A3 斜杠必须消失（路径遍历的第一道门）');
  eq(slugify('../../etc/passwd'), 'etc-passwd', 'A4 点号全被吃掉，出不去');
  eq(slugify('鱼'), 'model', 'A5 纯中文落回 fallback——文件名不靠中文');
  eq(slugify('小鱼 v2'), 'v2', 'A6 中文被丢掉，拉丁部分留下');
  eq(slugify(''), 'model', 'A7 空串给 fallback');
  eq(slugify(null), 'model', 'A8 null 不炸');
  eq(slugify('a'.repeat(80)).length, 40, 'A9 超长截到 40');
  eq(slugify('---abc---'), 'abc', 'A10 首尾的连字符去掉');
  eq(slugify('a__b'), 'a__b', 'A11 下划线保留（有些模型名用它分词）');
  ok(!/[^a-z0-9_-]/.test(slugify('奇怪的名字 !@#$ 123')), 'A12 结果里只剩安全字符');
}

console.log('\nB. 能不能进房间');

{
  const r = inspect(good());
  ok(r.ok, 'B1 合格模型通过');
  eq(r.fatal, [], 'B2 没有致命问题');
  eq(r.warn, [], 'B3 也没有需要提醒的');
}

{
  const r = inspect({ ...good(), isVRM: false });
  ok(!r.ok, 'B4 不是 VRM → 拒绝');
  ok(/VRM/.test(r.fatal[0]), 'B5 说清是"不是 VRM"', r.fatal[0]);
}

{
  const r = inspect({ ...good(), hasHumanoid: false });
  ok(!r.ok, 'B6 没有 humanoid → 拒绝');
  /* 这条注释是给未来的自己：没有 humanoid 时**不许**再报"缺骨骼"。
   * 两个原因说同一件事，用户会以为是两个问题。 */
  eq(r.fatal.length, 1, 'B7 只说一次（没有 humanoid 就不再逐根报缺）');
  ok(/静默失效|走、坐、挥手/.test(r.fatal[0]), 'B8 说清后果而不只是"缺 humanoid"', r.fatal[0]);
}

{
  /* 缺 hips 是最坏的一种：人还在，但所有动作从错误的根开始。 */
  const r = inspect({ ...good(), bones: REQUIRED_BONES.filter((b) => b !== 'hips') });
  ok(!r.ok, 'B9 缺 hips → 拒绝');
  ok(/hips/.test(r.fatal[0]), 'B10 明确指出缺哪根', r.fatal[0]);
}

{
  const r = inspect({ ...good(), bones: [] });
  ok(!r.ok, 'B11 骨骼表空 → 拒绝');
  ok(/7 根|缺/.test(r.fatal[0]), 'B12 一次列出全部缺失', r.fatal[0]);
}

{
  /* 厘米建模是最常见的坑：模型本身完全正确，只是单位不对。 */
  const r = inspect({ ...good(), height: 135.7 });
  ok(!r.ok, 'B13 身高 135.7（按厘米建的）→ 拒绝');
  ok(/单位/.test(r.fatal[0]), 'B14 提示是单位问题，不是"人太高"', r.fatal[0]);
}

{
  const r = inspect({ ...good(), height: 0 });
  ok(!r.ok, 'B15 身高 0 → 拒绝');
  const r2 = inspect({ ...good(), height: NaN });
  ok(!r2.ok, 'B16 身高 NaN → 拒绝（不炸）');
  const r3 = inspect({ ...good(), height: 0.25 });
  ok(!r3.ok, 'B17 比下限还矮 → 拒绝');
  ok(inspect({ ...good(), height: HEIGHT_MIN }).ok, 'B18 正好在下限 → 通过');
  ok(inspect({ ...good(), height: HEIGHT_MAX }).ok, 'B19 正好在上限 → 通过');
}

{
  /* 这三条是"能进但要说一句"，不是拒绝。判错了会把好模型挡在门外。 */
  const noExpr = inspect({ ...good(), expressions: 0 });
  ok(noExpr.ok, 'B20 没有表情 → 仍然能进（不是致命）');
  ok(noExpr.warn.length === 1, 'B21 但要提醒一句');
  ok(/表情/.test(noExpr.warn[0]), 'B22 提醒说的是表情', noExpr.warn[0]);

  const heavy = inspect({ ...good(), materials: MATERIAL_WARN + 1 });
  ok(heavy.ok, 'B23 材质超限 → 仍然能进');
  ok(/材质|掉帧/.test(heavy.warn[0]), 'B24 但要说会掉帧', heavy.warn[0]);

  const noMeta = inspect({ ...good(), metaVersion: '' });
  ok(noMeta.ok, 'B25 没 meta → 仍然能进');
  ok(/授权|作者/.test(noMeta.warn[0]), 'B26 提醒补授权信息', noMeta.warn[0]);
}

{
  const r = inspect(null);
  ok(!r.ok, 'B27 null 输入 → 不通过，但不炸');
  const r2 = inspect({});
  ok(!r2.ok, 'B28 空对象 → 不通过');
  ok(r2.fatal.length >= 2, 'B29 空对象会把缺的都说出来', String(r2.fatal.length));
}

{
  /* fatal 的每一条都要是能直接显示给用户的话。
   * 四个字的"导入失败"等于什么都没说——这是这一组最想守的东西。 */
  const bad = inspect({ isVRM: true, hasHumanoid: true, bones: [], height: 100 });
  for (const m of bad.fatal) {
    ok(typeof m === 'string' && m.length >= 10, `B30 这句是完整的人话：${m.slice(0, 18)}…`);
  }
}

console.log('\nC. 登记项的格式（差一个字段，面板里就点不动）');

{
  const m = toAvatarModel({ id: 'vrm-x', label: '3D', src: 'assets/vrm/x.vrm', name: 'X' });
  eq(Object.keys(m).sort(), ['credit', 'id', 'kind', 'label', 'note', 'src', 'use'],
    'C1 字段集合和 characters.json 里的一致');
  eq(m.kind, 'vrm', 'C2 kind 是 vrm');
  eq(m.use, ['room'], 'C3 use 只有 room（Live2D 才进封面）');
  ok(!!m.credit && 'commercial' in m.credit, 'C4 授权里必须有 commercial 这个位');

  /* 和真文件比一次：不是"我看着像"，是"和现有条目同构"。
   * 开源版里注册表是空的（模型有各自授权，不随仓库分发），这时候没得比——
   * 跳过要**说出来**，不能让读者以为 C5/C6 也过了。 */
  const reg = JSON.parse(fs.readFileSync(path.join(LIFE, 'assets/characters.json'), 'utf8'));
  const first = (reg.characters || [])[0];
  const real = first ? (first.avatarModels || []).find((a) => a.kind === 'vrm') : null;
  if (real) {
    ok(true, 'C5 注册表里本来就有一条 vrm');
    const got = Object.keys(m).sort(), want = Object.keys(real).sort();
    ok(got.every((k) => want.includes(k)), 'C6 新条目的键都在现有条目里出现过',
      got.filter((k) => !want.includes(k)).join(','));
  } else {
    console.log('  · C5/C6 跳过：注册表里没有真条目（开源版就是这样，不是红）');
  }
}

console.log('\nD. 边界（这是浏览器模块）');

{
  const src = fs.readFileSync(path.join(LIFE, 'js/room/model-import.mjs'), 'utf8');
  ok(!/from ['"]node:/.test(src), 'D1 不 import node 的东西');
  ok(!/writeFile|unlink|readdir|mkdir/.test(src), 'D2 不碰文件系统');
  ok(/REQUIRED_BONES/.test(src) && REQUIRED_BONES.length === 7, 'D3 关键骨骼是 7 根');
  /* 判定逻辑不许依赖 three —— 否则这条测试就得开 WebGL。 */
  ok(!/THREE|three\.module/.test(src), 'D4 inspect 不依赖 three（所以能在这里跑）');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
