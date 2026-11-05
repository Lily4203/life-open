/* 外线插槽：别人扔一个文件进来，会不会被正确接上、坏了会不会拖垮别人
 * ------------------------------------------------------------
 * 这一组测的是 tools/adapters.mjs，不启动服务、不连网。
 * 真的接 QQ 要协议端，那就不是断言能覆盖的事（探针在 adapters/_qq-napcat.mjs 里）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdapters } from '../../tools/adapters.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(a === b, name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

const DIR = path.join(process.cwd(), '_tmp', 'adapters-test');
const reset = () => { fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true }); };
const put = (name, code) => fs.writeFileSync(path.join(DIR, name), code, 'utf8');

/* import 缓存是按绝对路径算的：同一路径重写文件，第二次 import 还是旧模块。
 * 测试里加个 query 强制重读——生产环境重启进程，不需要这个。 */
let bump = 0;
const importModule = p => import(pathToFileURL(p).href + '?v=' + (++bump));

function rig() {
  const sent = [];
  const logs = [];
  const AD = createAdapters({
    dir: DIR,
    send: m => { sent.push(m); return { ok: true, delivered: 1 }; },
    log: m => logs.push(m),
    now: () => 1700000000000,
    importModule,
  });
  return { AD, sent, logs };
}

/* ================= A. 没有这个目录 ================= */
console.log('\nA. 没有 adapters/ 目录（默认状态）');
{
  fs.rmSync(DIR, { recursive: true, force: true });
  const { AD } = rig();
  const r = await AD.load();
  ok(r.missing === true, 'A1 目录不存在 = missing，不是报错');
  eq(AD.size, 0, 'A2 一条线都没接');
  eq(AD.info().length, 0, 'A3 health 里是空数组，不是 undefined');
}

/* ================= B. 下划线不加载 ================= */
console.log('\nB. 下划线开头的文件不自动加载');
{
  reset();
  put('_draft.mjs', `
    export default { id: 'draft', label: '草稿',
      start() { throw new Error('不该被调用'); } };
  `);
  const { AD } = rig();
  const r = await AD.load();
  eq(AD.size, 0, 'B1 没被加载');
  ok(r.skipped.some(s => s.file === '_draft.mjs'), 'B2 在 skipped 里说了一声为什么');
}

/* ================= C. 一条正常的线 ================= */
console.log('\nC. 一条正常的线：起来了、发了、where 带上了');
{
  reset();
  put('ok.mjs', `
    let calls = 0;
    export default {
      id: 'ok', label: '好的', where: '墙上',
      start(send) { calls += 1; send({ text: '  起来  了 ', from: 'ok', name: '墙' }); },
      stop() { calls += 100; },
      state() { return { calls }; },
    };
  `);
  const { AD, sent } = rig();
  await AD.load();
  eq(AD.size, 1, 'C1 加载了一条');
  eq(sent.length, 1, 'C2 start 里发的那句到了');
  eq(sent[0].text, '起来 了', 'C3 连续空白压成一个（提示词里不能有多空格的一句）');
  eq(sent[0].where, '墙上', 'C4 where 用适配器的默认值');
  eq(sent[0].source, 'script', 'C5 没写 source 就是 script（不拿 id 冒充来源）');
  eq(AD.info()[0].sent, 1, 'C6 info 里 sent 是 1');
  eq(AD.info()[0].started, true, 'C7 started');
}

/* ================= D. 默认值与覆盖 ================= */
console.log('\nD. from / source / where 的默认值与覆盖');
{
  reset();
  put('def.mjs', `
    export default { id: 'def', where: '手机',
      start(send) { this.send = send; } };
  `);
  const { AD, sent } = rig();
  await AD.load();
  AD.feed('def', { text: '在吗' });
  eq(sent.at(-1).from, 'def', 'D1 from 默认是 id（她看到 guest:def，不是"有人"）');
  eq(sent.at(-1).where, '手机', 'D2 where 默认取适配器');
  AD.feed('def', { text: '在吗', from: 'qq123', name: '小明', source: 'group', where: '手机上的 QQ' });
  eq(sent.at(-1).from, 'qq123', 'D3 from 能覆盖');
  eq(sent.at(-1).source, 'group', 'D4 source 能覆盖');
  eq(sent.at(-1).where, '手机上的 QQ', 'D5 where 能逐条覆盖（同一条线里手机和平板分得开）');
  eq(sent.at(-1).at, 1700000000000, 'D6 at 有值');
}

/* ================= E. 送进来的东西 ================= */
console.log('\nE. 空话、超长、没有 id');
{
  reset();
  put('edge.mjs', `export default { id: 'edge', start(send) { this.send = send; } };`);
  const { AD, sent } = rig();
  await AD.load();
  const r1 = AD.feed('edge', { text: '   ' });
  ok(r1.ok === false && r1.reason === 'empty', 'E1 空话不收，且回 reason');
  eq(sent.length, 0, 'E2 空话没往 pushIn 送');
  eq(AD.info()[0].errors, 1, 'E3 但记了一次 error（不许静默）');
  AD.feed('edge', { text: '啊'.repeat(900) });
  eq(sent.at(-1).text.length, 500, 'E4 超长截到 500');
  eq(AD.feed('nope', { text: 'x' }).reason, 'no_such_adapter', 'E5 发到不存在的线，回 no_such_adapter 而不是崩');
}

/* ================= F. 坏文件不拖垮好文件 ================= */
console.log('\nF. 一个坏文件不拖垮别人');
{
  reset();
  put('bad.mjs', `export default { id: 'bad', start( } ;`);          // 语法错
  put('good.mjs', `export default { id: 'good', start(send) { send({ text: '我还活着' }); } };`);
  const { AD, sent, logs } = rig();
  const r = await AD.load();
  eq(AD.size, 1, 'F1 好的那条起来了');
  eq(sent.length, 1, 'F2 并且真的发了话');
  ok(r.skipped.some(s => s.file === 'bad.mjs' && /import 失败/.test(s.why)), 'F3 坏的记在 skipped 里');
  ok(logs.some(l => l.startsWith('bad.mjs')), 'F4 日志里说了，不是悄悄跳过');
}

/* ================= G. 契约不合格 ================= */
console.log('\nG. 契约不合格的，当场说清楚');
{
  reset();
  put('noid.mjs', `export default { start(send) {} };`);
  put('upid.mjs', `export default { id: 'Bad-Id', start(send) {} };`);
  put('nostart.mjs', `export default { id: 'nostart' };`);
  put('notobj.mjs', `export default 42;`);
  const { AD } = rig();
  const r = await AD.load();
  eq(AD.size, 0, 'G1 一个都没加载');
  const why = Object.fromEntries(r.skipped.map(s => [s.file, s.why]));
  ok(/id 不合格/.test(why['noid.mjs'] || ''), 'G2 没 id 说"不合格"');
  ok(/id 不合格/.test(why['upid.mjs'] || ''), 'G3 大写/横线说不合格（小写蛇形）');
  ok(/缺 start/.test(why['nostart.mjs'] || ''), 'G4 缺 start');
  ok(/export default/.test(why['notobj.mjs'] || ''), 'G5 不是对象');
}

/* ================= H. 重名 ================= */
console.log('\nH. 两条线抢一个 id');
{
  reset();
  put('a-qq.mjs', `export default { id: 'qq', start(send) { send({ text: '我是 a' }); } };`);
  put('b-qq.mjs', `export default { id: 'qq', start(send) { send({ text: '我是 b' }); } };`);
  const { AD, sent } = rig();
  const r = await AD.load();
  eq(AD.size, 1, 'H1 只活一条');
  eq(sent.length, 1, 'H2 只发了一句（没有两条线同时说话）');
  ok(r.skipped.some(s => /重名/.test(s.why)), 'H3 另一条在 skipped 里说重名');
}

/* ================= I. start 抛错 ================= */
console.log('\nI. start 抛错：这条标红，别的照跑');
{
  reset();
  put('boom.mjs', `export default { id: 'boom', start() { throw new Error('端口占了'); } };`);
  put('fine.mjs', `export default { id: 'fine', start(send) { send({ text: '我没事' }); } };`);
  const { AD, sent } = rig();
  await AD.load();
  const info = Object.fromEntries(AD.info().map(x => [x.id, x]));
  ok(/端口占了/.test(info.boom.error || ''), 'I1 error 里是 start 抛的那句话');
  eq(info.boom.started, false, 'I2 boom 没起来');
  eq(info.fine.started, true, 'I3 fine 起来了');
  eq(sent.length, 1, 'I4 fine 的话照发');
}

/* ================= J. stop 与 info ================= */
console.log('\nJ. 停、不再重复停、state 抛错不外溢');
{
  reset();
  put('s.mjs', `
    let stopped = 0;
    export default {
      id: 'ess', start(send) { this.send = send; },
      stop() { stopped += 1; this.stopped = stopped; },
      state() { return { stopped: this.stopped || 0 }; },
    };
  `);
  put('sick.mjs', `
    export default { id: 'sick', start() {}, state() { throw new Error('state 坏了'); } };
  `);
  const { AD } = rig();
  await AD.load();
  const r1 = AD.stopAll();
  eq(r1.length, 2, 'J1 两条都停了');
  const r2 = AD.stopAll();
  eq(r2.length, 0, 'J2 第二次不再停（已经停过了）');
  const sick = AD.info().find(x => x.id === 'sick');
  ok(/state 坏了/.test(sick.stateError || ''), 'J3 state() 抛错记在 stateError，不影响 info');
  ok(sick.state === null, 'J4 state 是 null，不是假对象');
}

/* ================= 收尾 ================= */
console.log(`\n全过：${pass} 过，${fail} 不过`);
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
