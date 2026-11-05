/* 更新检查：我这份是哪一版、外面有没有新的
 * ------------------------------------------------------------
 * 这一组守的是 updates.mjs 开头那三条界线：
 *   A  版本号比较：这东西错起来没有报错——0.10 判成比 0.9 小，
 *      于是所有人永远收不到提示，而且没人会发现
 *   B  四个状态：unknown / current / newer / ahead。查不了不许说成"最新"，
 *      本地比远端新也不许说"有新版"（开发分支天天如此）
 *   C  失败路径：没地址 / 超时 / 404 / 不是 JSON / 字段读不懂，各说各的话
 *   D  缓存：只缓存成功；失败必须**不**进缓存，否则一次断网要背六小时
 *   E  不越界：不写文件、不下命令、不自己更新
 *
 * 全组不联网：fetch 是假的，时间也是假的。
 * 真网络那条在真页面上验（`window.__UPDATES.state()`）。
 *
 * 跑：node tools/brain-test/update-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion, compare, normalizeNotes, createUpdates, KIND_LABEL } from '../../js/brain/updates.mjs';

const LIFE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name,
  JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));

/* 一个假的"外网"：想让它返回什么就返回什么，想让它抛什么就抛什么。
 * 顺带数一下被调用了几次——缓存那条断言要靠它。 */
function net(handler) {
  const calls = [];
  const fetchJson = async (url, opts) => {
    calls.push({ url, at: opts && opts.timeoutMs });
    return handler(url, calls.length);
  };
  return { fetchJson, calls };
}

const hold = (obj) => () => obj;

console.log('A. 版本号比较（错在这里不会报错，只会安静地永远不提示）');

{
  eq(parseVersion('0.1.0'), { major: 0, minor: 1, patch: 0, pre: '' }, 'A1 正常三段');
  eq(parseVersion('v1.2'), { major: 1, minor: 2, patch: 0, pre: '' }, 'A2 可以带 v，可以少写一段');
  ok(parseVersion('1.2.3-dev.4').pre === 'dev.4', 'A3 预发布尾巴留着');
  eq(parseVersion('不是版本'), null, 'A4 读不懂就返回 null，不返回 0');
  eq(parseVersion(''), null, 'A5 空串也是 null');
  eq(parseVersion(null), null, 'A6 null 不炸');

  ok(compare('0.9.0', '0.10.0') === -1, 'A7 0.9.0 < 0.10.0（字符串比较会判反，这条是防它的）');
  ok(compare('0.10.0', '0.9.0') === 1, 'A8 反过来也对');
  ok(compare('1.0.0', '1.0.0') === 0, 'A9 相同就是 0');
  ok(compare('0.1', '0.1.0') === 0, 'A10 少写一段等于补零');
  ok(compare('1.0.0', '1.0.0-dev') === 1, 'A11 正式版比同号的预发布版大');
  ok(compare('1.0.0-dev', '1.0.0') === -1, 'A12 反过来也对');
  ok(compare('1.0.0-alpha', '1.0.0-beta') === -1, 'A13 两个预发布按字典序');
  ok(compare('abc', '1.0.0') === null, 'A14 任一方读不懂 → null（不是 0，不是 -1）');
  ok(compare('2.0.0', '2.0.0.0') === null, 'A15 四段算读不懂，不当成 2.0.0');
}

console.log('\nB. 四个状态（查不了 ≠ 最新）');

const localV = { version: '0.1.0', released: '2026-11-05', notes: [] };

{
  const n = net(hold({ version: '0.2.0' }));
  const u = createUpdates({ local: localV, url: 'https://x/v.json', fetchJson: n.fetchJson });
  const s = await u.check();
  eq(s.status, 'newer', 'B1 远端更高 → newer');
  eq(s.remoteVersion, '0.2.0', 'B2 把远端版本号带出来');
  ok(u.badge(), 'B3 有新版且没点过 → 徽标亮');
}

{
  const n = net(hold({ version: '0.1.0' }));
  const u = createUpdates({ local: localV, url: 'https://x/v.json', fetchJson: n.fetchJson });
  eq((await u.check()).status, 'current', 'B4 一样 → current');
  ok(!u.badge(), 'B5 最新版不亮徽标');
}

{
  /* 开发分支天天是这个状态。这里要是弹"有新版本"，作者会被自己的项目烦死。 */
  const n = net(hold({ version: '0.1.0' }));
  const u = createUpdates({ local: { version: '0.3.0' }, url: 'https://x/v.json', fetchJson: n.fetchJson });
  const s = await u.check();
  eq(s.status, 'ahead', 'B6 本地比远端新 → ahead，不是 newer');
  ok(!u.badge(), 'B7 ahead 不许亮徽标（提示降级是错的）');
  ok(/比发布版.*新|开发分支/.test(s.reason), 'B8 ahead 要说清楚"你这份更新"', s.reason);
}

{
  const u = createUpdates({ local: localV, url: '', fetchJson: async () => { throw new Error('不该被调用'); } });
  const s = await u.check();
  eq(s.status, 'unknown', 'B9 没配地址 → unknown');
  ok(/发布地址/.test(s.reason), 'B10 并且说清为什么', s.reason);
}

{
  /* 点掉之后不再烦人，但下一个版本号来了要重新提醒。 */
  const n = net(hold({ version: '0.2.0' }));
  const store = new Map();
  const u = createUpdates({
    local: localV, url: 'https://x/v.json', fetchJson: n.fetchJson,
    readCache: (k) => store.get(k) || null,
    writeCache: (k, v) => store.set(k, v),
  });
  await u.check();
  ok(u.badge(), 'B11 第一次查出来 → 亮');
  u.markSeen();
  ok(!u.badge(), 'B12 点过之后 → 不亮');
  ok(u.seen(), 'B13 而且记得点过');
}

console.log('\nC. 失败路径（每种失败要说不同的话）');

const cases = [
  ['C1 超时', new Error('aborted: 超时'), /超时|没联网/],
  ['C2 404', new Error('HTTP 404'), /404|路径写错|没推/],
  ['C3 不是 JSON', new Error('返回的不是 JSON'), /不是 JSON|网页|登录页/],
  ['C4 其它网络错', new Error('ECONNREFUSED'), /查不了/],
];

for (const [name, err, pat] of cases) {
  const n = net(async () => { throw err; });
  const u = createUpdates({ local: localV, url: 'https://x/v.json', fetchJson: n.fetchJson });
  const s = await u.check();
  eq(s.status, 'unknown', name + '：状态必须是 unknown');
  ok(pat.test(s.reason), name + '：原因要说对', s.reason);
  ok(!u.badge(), name + '：不许亮徽标（查不了不等于有新版本）');
}

{
  const n = net(hold({ title: '没有 version 字段' }));
  const u = createUpdates({ local: localV, url: 'https://x/v.json', fetchJson: n.fetchJson });
  const s = await u.check();
  eq(s.status, 'unknown', 'C5 远端缺 version → unknown');
  ok(/version/.test(s.reason), 'C6 说清缺的是 version 字段', s.reason);
}

{
  const n = net(hold({ version: '最新版' }));
  const u = createUpdates({ local: localV, url: 'https://x/v.json', fetchJson: n.fetchJson });
  const s = await u.check();
  eq(s.status, 'unknown', 'C7 远端 version 读不懂 → unknown（不许当 0）');
}

{
  const n = net(hold(null));
  const u = createUpdates({ local: localV, url: 'https://x/v.json', fetchJson: n.fetchJson });
  eq((await u.check()).status, 'unknown', 'C8 返回 null → unknown，不炸');
}

{
  /* 本地 version.json 本身坏了：整份读不成，url 自然是空。
   * 这一条防的是"发布包漏了 version.json"——那时页面该照常能用，只是查不了更新。 */
  const u = createUpdates({ local: {}, url: '', fetchJson: async () => ({}) });
  const s = await u.check();
  eq(s.status, 'unknown', 'C9 本地没有 version.json → 照常跑，只是查不了');
  eq(u.local().version, '', 'C10 本地版本号是空串，不是 undefined');
}

console.log('\nD. 缓存（失败不许进缓存）');

{
  let store = {};
  const n = net(hold({ version: '0.2.0' }));
  let t = 1e12;
  const mk = () => createUpdates({
    local: localV, url: 'https://x/v.json', fetchJson: n.fetchJson,
    now: () => t,
    readCache: (k) => store[k] || null,
    writeCache: (k, v) => { store[k] = v; },
  });
  const u = mk();
  await u.check();
  eq(n.calls.length, 1, 'D1 第一次真的请求了');
  await u.check();
  eq(n.calls.length, 1, 'D2 六小时内第二次用缓存，不再请求');
  t += 7 * 3600 * 1000;
  await u.check();
  eq(n.calls.length, 2, 'D3 过了区间会重新请求');
  await u.check({ force: true });
  eq(n.calls.length, 3, 'D4 force 无视缓存');
}

{
  /* 这条很重要：如果失败也能缓存，用户断一次网就要背六小时"查不了"，
   * 而且中途恢复了也不会再试。 */
  let store = {};
  let broken = true;
  const fetchJson = async () => {
    if (broken) throw new Error('ECONNREFUSED');
    return { version: '0.2.0' };
  };
  const u = createUpdates({
    local: localV, url: 'https://x/v.json', fetchJson,
    readCache: (k) => store[k] || null,
    writeCache: (k, v) => { store[k] = v; },
  });
  eq((await u.check()).status, 'unknown', 'D5 断网 → unknown');
  broken = false;
  eq((await u.check()).status, 'newer', 'D6 网一恢复，下一次就查到了（失败没被缓存住）');
}

{
  const n = net(hold({ version: '0.2.0' }));
  const store = {};
  const u = createUpdates({
    local: localV, url: 'https://x/v.json', fetchJson: n.fetchJson,
    readCache: (k) => store[k] || null,
    writeCache: (k, v) => { store[k] = v; },
  });
  await u.check();
  const u2 = createUpdates({
    local: localV, url: 'https://x/v.json', fetchJson: async () => { throw new Error('不该被调用'); },
    readCache: (k) => store[k] || null,
    writeCache: () => {},
  });
  eq(u2.boot().status, 'newer', 'D7 重开页面先亮上次的结论（不让页面空着一片"检查中"）');
}

console.log('\nE. 不越界（能读源码的都查一遍）');

{
  const src = fs.readFileSync(path.join(LIFE, 'js/brain/updates.mjs'), 'utf8');
  ok(!/from ['"]node:(fs|child_process|os)['"]/.test(src), 'E1 不碰文件系统、不下命令');
  ok(!/writeFile|unlink|spawn|exec\(/.test(src), 'E2 没有任何写盘或执行');
  /* 写成 `|| true` 的断言等于没写——这一条真的查：远端整份展开（...remote）
   * 会把别人文件里的任意键塞进我们的状态对象。 */
  ok(!/\.\.\.\s*remote\b/.test(src), 'E3 远端的字段只按名字取，不整份展开进状态');
  /* 远端 JSON 是外部输入：它给什么键都不能直接变成我们的状态字段。 */
  ok(/remoteVersion:\s*rv/.test(src), 'E4 只把读得懂的版本号搬进来');
  ok(/typeof remote\.version === 'string'/.test(src), 'E5 取之前先验类型');
}

console.log('\nF. 更新日志归一化（人手写的，缺一半是常态）');

{
  eq(normalizeNotes(null), [], 'F1 null → 空数组');
  eq(normalizeNotes('不是数组'), [], 'F2 不是数组 → 空数组');
  eq(normalizeNotes([null, 3, 'x']), [], 'F3 全是垃圾 → 空数组（不炸）');

  const n = normalizeNotes([
    { v: '0.2.0', title: '更新了', items: ['一条', '', 3, null] },
    { title: '没写版本号' },
    { v: '0.1.0', kind: '乱写的' },
    {},
  ]);
  eq(n.length, 3, 'F4 空对象被丢掉，其余留下');
  eq(n[0].items, ['一条'], 'F5 items 里非字符串和空串被剔掉');
  eq(n[1].v, '', 'F6 缺版本号就是空串，不编一个');
  eq(n[2].kind, 'release', 'F7 认不出的 kind 落回 release');
  ok(Object.keys(KIND_LABEL).length >= 4, 'F8 每个 kind 都有中文名');
}

console.log('\nG. 和本地 version.json 对得上');

{
  const raw = JSON.parse(fs.readFileSync(path.join(LIFE, 'version.json'), 'utf8'));
  ok(!!parseVersion(raw.version), 'G1 version.json 里的 version 能读懂', String(raw.version));
  ok(Array.isArray(raw.notes) && raw.notes.length >= 1, 'G2 至少写了一条更新日志');
  eq(normalizeNotes(raw.notes).length, raw.notes.length, 'G3 每条都能通过归一化（没写坏）');
  ok(typeof raw.check === 'object' && 'url' in raw.check, 'G4 有 check.url 这个位置等人填');
  ok(!raw.version.endsWith('-dev'), 'G5 发布版不带预发布尾巴');
  /* 更新日志里的第一条必须是当前版本，否则"最新一条"和"我这份"对不上。 */
  eq(raw.notes[0].v, raw.version, 'G6 最上面那条日志就是这一版');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
