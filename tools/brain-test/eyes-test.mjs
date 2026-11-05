/* 眼睛：看一眼 = 截一张屏 → 缩图 → 问出那句话 → 投一条事件
 * ------------------------------------------------------------
 * 这组断言盯的是四条最容易"看起来对、其实出了事"的地方：
 *   A  没同意时**一次都不许截屏**（不是"截了不发"）
 *   B  正在看的时候再点，不排队也不重截
 *   C  限频：刚看过就说刚看过，还告诉他还差多久
 *   D  失败要说清是哪一步（壳 / 图 / 网络 / 服务端 / 感官层），而且不投假事件
 *
 * 另外两条是契约：图不进 last/stats，不碰浏览器存储。
 *
 * 跑：node tools/brain-test/eyes-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEyes, dataUrlBytes } from '../../js/brain/eyes.mjs';
import { createSenses } from '../../js/brain/senses.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'js', 'brain', 'eyes.mjs');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name,
  `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

const raw = (n, mime = 'jpeg') => `data:image/${mime};base64,` + Buffer.alloc(n, 3).toString('base64');
const BIG = raw(900 * 1024);
const SHOT = raw(400 * 1024, 'png');
const SMALL = raw(120 * 1024);

function harness({ consent = true, captureOk = true, post = null, shrink = null,
                   maxBytes = 700 * 1024, now0 = 1000 } = {}) {
  let t = now0;
  const seen = [];
  const senses = createSenses({ emit: (type, detail) => { seen.push({ type, detail }); return { ok: true }; },
                                now: () => t });
  if (consent) senses.consent(true);
  const calls = { capture: 0, shrink: 0, post: 0 };
  const posts = [];
  const eyes = createEyes({
    capture: async () => { calls.capture += 1; return captureOk ? { ok: true, dataUrl: SHOT, name: '屏幕' } : { ok: false, reason: 'no_source' }; },
    shrink: async (_d, opt) => { calls.shrink += 1; return shrink ? shrink(opt) : SMALL; },
    post: async (body) => {
      calls.post += 1; posts.push(body);
      if (post) return post(body);
      return { status: 200, json: { ok: true, summary: '他在写代码，屏幕上有一行红色报错',
                                    entities: ['编辑器', '报错'], private: false,
                                    provider: 'zhipu', model: 'glm-4v-flash', ms: 900 } };
    },
    senses,
    now: () => t,
    minIntervalMs: 3000,
    maxBytes,
  });
  return { eyes, senses, seen, calls, posts, tick: ms => { t += ms; }, t: () => t };
}

console.log('\nA. 许可与顺序');

{
  const seen = [];
  const senses = createSenses({ emit: (t, d) => { seen.push({ t, d }); return { ok: true }; } });
  senses.consent(true);
  const eyes = createEyes({ capture: null, senses, shrink: async () => SMALL, post: async () => ({ status: 200, json: {} }) });
  const r = await eyes.look();
  eq(r.reason, 'no_shell', 'A1 不在桌面壳里：说 no_shell');
  ok(/桌面壳/.test(r.message), 'A2 说人话（不是只给一个码）', r.message);
}

{
  const h = harness({ consent: false });
  const r = await h.eyes.look();
  eq(r.reason, 'no_consent', 'A3 没同意：no_consent');
  eq(h.calls.capture, 0, 'A4 关键：没同意时一次都没截屏（不是截了不发）');
  eq(h.calls.post, 0, 'A5 也没发请求');
  eq(h.seen.length, 0, 'A6 没有事件');
}

{
  const h = harness();
  const r = await h.eyes.look({ why: '他按了按钮' });
  eq(r.ok, true, 'A7 同意了就能看');
  eq(h.calls.capture, 1, 'A8 只截一次');
  eq(h.calls.post, 1, 'A9 只发一次');
  ok(h.posts[0].image === SMALL, 'A10 发出去的是缩过的图，不是原图');
  ok(!h.posts[0].image.startsWith('data:image/png'), 'A11 缩成 JPEG 再发（PNG 一张顶十倍钱）');
  eq(r.entities, ['编辑器', '报错'], 'A12 实体透传');
}

console.log('\nB. 事件：真的进了感官层');

{
  const h = harness();
  const r = await h.eyes.look();
  eq(h.seen.length, 1, 'B1 投了一条事件');
  eq(h.seen[0].type, 'screen', 'B2 类型是 screen');
  ok(h.seen[0].detail.includes('他在写代码'), 'B3 detail 里有那句话', h.seen[0].detail);
  eq(h.senses.stats().screen, 1, 'B4 感官层记了一次');
  ok(r.sent && r.sent.ok, 'B5 返回里带"感官层收下了"');
}

{
  /* 感官层被关掉（enable('screen', false)）时：图看了，但不许假装"她已经知道" */
  const h = harness();
  h.senses.enable('screen', false);
  const r = await h.eyes.look();
  eq(r.reason, 'not_accepted', 'B6 感官层没收：not_accepted');
  eq(h.seen.length, 0, 'B7 没有事件');
}

console.log('\nC. 一次一看 + 限频');

{
  const h = harness();
  const p1 = h.eyes.look();
  const p2 = h.eyes.look();          // 同一 tick 里再点一次
  const [r1, r2] = await Promise.all([p1, p2]);
  eq(r1.ok, true, 'C1 第一眼成功');
  eq(r2.reason, 'busy', 'C2 第二眼 busy');
  eq(h.calls.capture, 1, 'C3 只截了一次（不排队、不重截）');
  eq(h.eyes.stats().busy, 1, 'C4 busy 计数');
}

{
  const h = harness();
  await h.eyes.look();
  const r = await h.eyes.look();
  eq(r.reason, 'too_soon', 'C5 立刻再点：too_soon');
  ok(r.waitMs > 0 && r.waitMs <= 3000, 'C6 告诉他还差多久（不是只说"太频繁"）', String(r.waitMs));
  eq(h.calls.capture, 1, 'C7 太频繁时一次都没重截');
  h.tick(3100);
  eq((await h.eyes.look()).ok, true, 'C8 过了 3 秒可以再看');
}

console.log('\nD. 失败要说清是哪一步');

{
  const h = harness({ post: async () => ({ status: 503, json: { ok: false, reason: 'no_key', message: '没有能看图的密钥。在 keys.json 里填一个：ZHIPU_API_KEY' } }) });
  const r = await h.eyes.look();
  eq(r.reason, 'no_key', 'D1 服务端说没 key，原样透出来');
  ok(/ZHIPU_API_KEY/.test(r.message), 'D2 连"填哪个键"都带回来', r.message);
  eq(h.seen.length, 0, 'D3 失败时不投事件');
}

{
  const h = harness({ post: async () => ({ status: 502, json: { ok: false, reason: 'upstream', message: '上游 500：quota' } }) });
  const r = await h.eyes.look();
  eq([r.reason, r.status], ['upstream', 502], 'D4 上游失败带状态码');
}

{
  const h = harness({ post: async () => { throw new Error('Failed to fetch'); } });
  const r = await h.eyes.look();
  eq(r.reason, 'net', 'D5 连不上：net');
  ok(/Failed to fetch/.test(r.message), 'D6 原始错误留着（排障要看）');
}

{
  const h = harness({ captureOk: false });
  const r = await h.eyes.look();
  eq(r.reason, 'capture_failed', 'D7 壳截不到：capture_failed');
  eq(h.calls.post, 0, 'D8 截图失败就不发请求');
}

{
  /* 缩完还超预算：说明递进来的根本不是屏幕截图（是原图/4K 艺术图） */
  const h = harness({ shrink: () => BIG, maxBytes: 700 * 1024 });
  const r = await h.eyes.look();
  eq(r.reason, 'bad_image', 'D9 缩完还太大：bad_image');
  eq(h.calls.shrink, 3, 'D10 试了三档才放弃（原质量/低质量/小一号）');
  eq(h.calls.post, 0, 'D11 不发出去（看不清的图不花这个钱）');
}

{
  const h = harness();
  const r = await h.eyes.look();
  h.tick(4000);
  const p = h.eyes.look();
  h.tick(4000);
  await p;
  ok(h.eyes.stats().failed === 0, 'D12 成功过的一眼不算失败（failed 只数真失败）', String(h.eyes.stats().failed));
  ok(r.ok, 'D13 前面那条也成功');
}

console.log('\nE. 图不进 last / 不碰存储');

{
  const h = harness();
  await h.eyes.look();
  const last = h.eyes.last();
  const flat = JSON.stringify(last);
  ok(!flat.includes('data:image'), 'E1 last 里没有图');
  ok(!flat.includes('他在写代码'), 'E2 last 里也没有摘要（只记数字）');
  ok(last.bytes > 0 && last.chars > 0, 'E3 记了字节数和字数');
  ok(JSON.stringify(h.eyes.stats()).indexOf('data:image') < 0, 'E4 stats 里没有图');
}

{
  ok(dataUrlBytes('data:image/jpeg;base64,' + Buffer.alloc(300).toString('base64')) === 300, 'E5 字节数算对');
  eq(dataUrlBytes('nonsense'), 0, 'E6 不是 dataURL 就是 0');
}

{
  const src = fs.readFileSync(SRC, 'utf8');
  ok(!/localStorage|sessionStorage|indexedDB/.test(src), 'E7 不碰浏览器存储（图不该被留下来）');
  ok(!/URL\.createObjectURL/.test(src), 'E8 不建 blob URL（建了就有人忘了 revoke）');
  ok(/先问许可，再截屏/.test(src) || /先查许可/.test(src), 'E9 源码里写着这个顺序（改的人会看到）');
}

console.log('\nF. 能不能看：四个条件');

{
  const h = harness({ consent: false });
  const a = h.eyes.available();
  eq([a.shell, a.consent], [true, false], 'F1 有壳但没同意');
  h.senses.consent(true);
  eq(h.eyes.available().consent, true, 'F2 同意后就是 true');
  await h.eyes.look();
  ok(h.eyes.available().waitMs > 0, 'F3 刚看完，available 里带着还要等多久');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
