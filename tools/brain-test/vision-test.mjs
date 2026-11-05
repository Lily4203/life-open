/* 看图：一帧进，一句话出
 * ------------------------------------------------------------
 * 这组断言只测四件事，全是"错了不会报错、只会慢慢变贵或变脏"的地方：
 *   A  只收能收的图（不收 gif/svg/URL；超 2.5MB 拒；字节按解码后算）
 *   B  模型不听话时怎么收（```json / 前后废话 / 纯人话 / 只有实体）
 *   C  选哪一家（没 key 就说没 key，指定了没 key 不偷偷换一家）
 *   D  请求形状 + **返回值里不能有图**
 *
 * 跑：node tools/brain-test/vision-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDataUrl, readAnswer, pickProvider, describe,
  MAX_BYTES, MAX_SUMMARY, MAX_ENTITIES, PROVIDERS, SCREEN_PROMPT,
} from '../../tools/vision.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'tools', 'vision.mjs');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name,
  `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

const b64 = n => Buffer.alloc(n, 7).toString('base64');
const img = (n = 100, mime = 'png') => `data:image/${mime};base64,${b64(n)}`;

console.log('\nA. 只收能收的图');

{
  const a = parseDataUrl(img(100, 'png'));
  ok(a && a.mime === 'image/png', 'A1 png 收');
  eq(a.bytes, 100, 'A2 字节按解码后算，不按字符串长度');
  ok(parseDataUrl(img(100, 'jpeg'))?.mime === 'image/jpeg', 'A3 jpeg 收');
  ok(parseDataUrl(img(100, 'webp'))?.mime === 'image/webp', 'A4 webp 收');
  eq(parseDataUrl(img(10, 'gif')), null, 'A5 gif 不收（会动，一眼看一帧没意义）');
  eq(parseDataUrl('data:image/svg+xml;base64,PHN2Zz4='), null, 'A6 svg 不收（能带脚本）');
  eq(parseDataUrl('https://example.com/a.png'), null, 'A7 只认 dataURL，不认外链');
  eq(parseDataUrl(''), null, 'A8 空串');
  eq(parseDataUrl(null), null, 'A9 null');
  eq(parseDataUrl('data:image/png;base64,'), null, 'A10 没有数据的 dataURL');
}

{
  /* 带换行的 base64（有些客户端会这么发），要能收 */
  const raw = b64(120);
  const wrapped = 'data:image/png;base64,' + raw.slice(0, 40) + '\n' + raw.slice(40);
  const a = parseDataUrl(wrapped);
  ok(a && a.bytes === 120, 'A11 换行的 base64 也收', a ? String(a.bytes) : 'null');
}

{
  ok(parseDataUrl(img(MAX_BYTES)) !== null, 'A12 正好 2.5MB 可以');
  eq(parseDataUrl(img(MAX_BYTES + 1000)), null, 'A13 超过 2.5MB 拒');
  /* 提前按字符串长度挡掉：不解析就不占内存 */
  const huge = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(MAX_BYTES * 1.4) + 8192);
  eq(parseDataUrl(huge), null, 'A14 明显超大的在解析前就挡');
}

console.log('\nB. 模型不听话时怎么收');

{
  const r = readAnswer('{"what":"他在写代码，屏幕上有一行红色报错","entities":["编辑器","报错"],"private":false}');
  eq(r.summary, '他在写代码，屏幕上有一行红色报错', 'B1 干净 JSON');
  eq(r.entities, ['编辑器', '报错'], 'B2 实体');
  eq(r.private, false, 'B3 private');
  eq(r.degraded, false, 'B4 没降级');
}

{
  const r = readAnswer('```json\n{"what":"他在看视频","entities":["视频网站"]}\n```');
  eq(r.summary, '他在看视频', 'B5 ```json 包裹能剥');
  eq(r.entities, ['视频网站'], 'B6 剥完实体还在');
}

{
  const r = readAnswer('好的，我看到了：\n{"what":"他在看文档","entities":[]}\n以上就是。');
  eq(r.summary, '他在看文档', 'B7 前后有废话也能捞出 JSON');
}

{
  const r = readAnswer('他在一个黑底白字的窗口里打字，旁边有个聊天列表。');
  eq(r.summary, '他在一个黑底白字的窗口里打字，旁边有个聊天列表。', 'B8 纯人话：降级成一句话，不判失败');
  eq(r.degraded, true, 'B9 但标记了 degraded');
  eq(r.entities, [], 'B10 降级时没有实体');
}

{
  const r = readAnswer('   ');
  eq(r.ok, false, 'B11 空回：失败（不能当成"她无话可说"）');
  eq(r.reason, 'empty', 'B12 原因清楚');
}

{
  const r = readAnswer(JSON.stringify({
    what: 'x',
    entities: ['编辑器', '编辑器', ' ', 'AB', '报错', '终端', '浏览器', '聊天', '多余的一个'],
  }));
  ok(r.entities.length <= MAX_ENTITIES, `B13 实体最多 ${MAX_ENTITIES} 个`, String(r.entities.length));
  eq(r.entities.filter(x => x === '编辑器').length, 1, 'B14 去重');
  ok(!r.entities.includes(' '), 'B15 去空');
}

{
  const long = '啊'.repeat(400);
  const r = readAnswer(JSON.stringify({ what: long }));
  eq(Array.from(r.summary).length, MAX_SUMMARY, `B16 长摘要截到 ${MAX_SUMMARY} 字`);
}

{
  const r = readAnswer(JSON.stringify({ what: '一屏私人的东西', private: '是' }));
  eq(r.private, true, 'B17 private 写"是"也认');
}

{
  const r = readAnswer(JSON.stringify({ entities: ['编辑器', '报错'] }));
  ok(r.ok && /屏幕上/.test(r.summary), 'B18 只有实体没有一句话：拼一句', r.summary);
  eq(r.degraded, true, 'B19 拼的算降级');
}

{
  const r = readAnswer('[1,2,3]');
  eq(r.ok, true, 'B20 数组也算"不是 JSON 对象"，走降级');
  eq(r.degraded, true, 'B21 降级标记');
}

console.log('\nC. 选哪一家');

{
  eq(pickProvider({ keys: {}, env: {} }), null, 'C1 一个 key 都没有 → null');
  const p = pickProvider({ keys: { ZHIPU_API_KEY: 'k1' }, env: {} });
  eq([p.id, p.model], ['zhipu', 'glm-4v-flash'], 'C2 有智谱就用智谱（免费额度最稳）');
  const q = pickProvider({ keys: { DASHSCOPE_API_KEY: 'k2' }, env: {} });
  eq(q.id, 'dashscope', 'C3 只有通义就用通义');
  const g = pickProvider({ keys: { GEMINI_API_KEY: 'k3' }, env: {} });
  eq(g.id, 'gemini', 'C4 只有 Gemini 就用 Gemini');
  eq(pickProvider({ keys: { ZHIPU_API_KEY: 'k1' }, env: {}, prefer: 'gemini' }), null,
     'C5 指定了 Gemini 但没它的 key：报没有，不偷偷换一家');
  const e = pickProvider({ keys: {}, env: { ZHIPU_API_KEY: 'envkey' } });
  eq(e?.key, 'envkey', 'C6 环境变量优先于 keys.json');
  const m = pickProvider({ keys: { ZHIPU_API_KEY: 'k' }, env: {}, model: 'glm-4.5v' });
  eq(m.model, 'glm-4.5v', 'C7 可以指定模型');
}

console.log('\nD. 发出去的东西 + 返回的东西');

const stub = (status, json, text = '') => {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { status, json, text: text || JSON.stringify(json || {}) }; };
  fn.calls = calls;
  return fn;
};
const answer = { what: '他在写代码，屏幕上有一行红色报错', entities: ['编辑器'], private: false };

{
  const req = stub(200, { choices: [{ message: { content: JSON.stringify(answer) } }], usage: { total_tokens: 900 } });
  const r = await describe({ dataUrl: img(200), keys: { ZHIPU_API_KEY: 'k' }, env: {}, request: req });
  eq(r.ok, true, 'D1 成功');
  eq(r.summary, answer.what, 'D2 摘要');
  eq(r.provider, 'zhipu', 'D3 用了哪家要回来说');
  eq(req.calls.length, 1, 'D4 只发一次');
  const body = req.calls[0].opts.body;
  eq(body.model, 'glm-4v-flash', 'D5 请求里带模型名');
  const parts = body.messages[0].content;
  eq(parts[0].type, 'image_url', 'D6 图在前');
  ok(/^[A-Za-z0-9+/=]+$/.test(parts[0].image_url.url), 'D7 智谱要纯 base64，不带 data: 前缀');
  eq(parts[1].type, 'text', 'D8 话在后');
  ok(parts[1].text.includes('不要复述'), 'D9 提示词里有"不许念屏幕上的字"');
}

{
  const req = stub(200, { choices: [{ message: { content: '{"what":"他在看视频"}' } }] });
  await describe({ dataUrl: img(200), keys: { DASHSCOPE_API_KEY: 'k' }, env: {}, request: req });
  const url = req.calls[0].url;
  eq(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'D10 通义走 compatible-mode');
  ok(req.calls[0].opts.body.messages[0].content[0].image_url.url.startsWith('data:image/png;base64,'),
     'D11 通义要带 data: 前缀（同一张图两家格式不同）');
}

{
  const req = stub(200, { candidates: [{ content: { parts: [{ text: '{"what":"他在看网页"}' }] } }] });
  await describe({ dataUrl: img(200), keys: { GEMINI_API_KEY: 'k' }, env: {}, request: req });
  const u = req.calls[0].url;
  ok(u.includes(':generateContent') && u.includes('key=k'), 'D12 Gemini 的 key 在 query 上', u);
  const b = req.calls[0].opts.body;
  eq(b.contents[0].parts[1].inline_data.mime_type, 'image/png', 'D13 Gemini 用 inline_data');
  eq(b.generationConfig.responseMimeType, 'application/json', 'D14 要求 JSON 输出');
  eq(b.generationConfig.thinkingConfig?.thinkingBudget, 0, 'D15 2.5 关掉思考（看图不用想）');
}

{
  const req = stub(429, { error: 'quota' });
  const r = await describe({ dataUrl: img(100), keys: { ZHIPU_API_KEY: 'k' }, env: {}, request: req });
  eq([r.ok, r.reason], [false, 'rate_limited'], 'D16 限流要单独一个原因（和"坏了"不一样）');

  const req2 = stub(500, null, 'boom');
  const r2 = await describe({ dataUrl: img(100), keys: { ZHIPU_API_KEY: 'k' }, env: {}, request: req2 });
  eq(r2.reason, 'upstream', 'D17 上游错');
  ok(r2.message.includes('500'), 'D18 报错带状态码');

  const boom = async () => { throw new Error('ECONNRESET'); };
  const r3 = await describe({ dataUrl: img(100), keys: { ZHIPU_API_KEY: 'k' }, env: {}, request: boom });
  eq(r3.reason, 'net', 'D19 网络错单独一个原因');
}

{
  const req = stub(200, {});
  const r = await describe({ dataUrl: img(100), keys: {}, env: {}, request: req });
  eq(r.reason, 'no_key', 'D20 没 key：no_key');
  eq(req.calls.length, 0, 'D21 没 key 时**一个请求都不发**');
  ok(/ZHIPU_API_KEY/.test(r.message), 'D22 报错要说到具体填哪个键');
}

{
  const req = stub(200, {});
  const r = await describe({ dataUrl: 'nonsense', keys: { ZHIPU_API_KEY: 'k' }, env: {}, request: req });
  eq(r.reason, 'bad_image', 'D23 图不对');
  eq(req.calls.length, 0, 'D24 图不对时也不发请求');
}

{
  /* 最要紧的一条：她拿到的是"一句话"，不是图。返回值里出现 base64 就是泄漏。 */
  const req = stub(200, { choices: [{ message: { content: JSON.stringify(answer) } }] });
  const r = await describe({ dataUrl: img(500), keys: { ZHIPU_API_KEY: 'k' }, env: {}, request: req });
  const flat = JSON.stringify(r);
  ok(!/data:image/.test(flat) && !/base64/.test(flat), 'D25 返回值里没有图（只有字数和摘要）');
  ok(!flat.includes(b64(500).slice(0, 60)), 'D26 也没有 base64 片段');
}

{
  /* 自定义 VISION_BASE：本地 mock 就靠这个，不然"没 key 就永远验证不了管线" */
  const req = stub(200, { choices: [{ message: { content: '{"what":"x"}' } }] });
  await describe({ dataUrl: img(100), keys: { ZHIPU_API_KEY: 'k' }, env: { VISION_BASE: 'http://127.0.0.1:9999/v1' }, request: req });
  eq(req.calls[0].url, 'http://127.0.0.1:9999/v1/chat/completions', 'D27 VISION_BASE 能改出口（给 mock 用）');
}

console.log('\nE. 源码契约');

{
  const src = fs.readFileSync(SRC, 'utf8');
  ok(!/writeFile|appendFile|createWriteStream/.test(src), 'E1 不写文件（图不落盘）');
  ok(!/console\.log/.test(src), 'E2 不打印（图或摘要都不该进 stdout）');
  ok(!/localStorage|indexedDB/.test(src), 'E3 不存浏览器存储（这是 Node 模块，顺手也算一层保险）');
  ok(/不要复述屏幕上的具体文字/.test(SCREEN_PROMPT), 'E4 提示词里写死了"不念屏幕上的字"');
  ok(/不要给像素、坐标/.test(SCREEN_PROMPT), 'E5 提示词里写死了"不给坐标"');
  ok(/private/.test(SCREEN_PROMPT), 'E6 有一屏私人的东西时要说 private');
  eq(Object.keys(PROVIDERS).length, 3, 'E7 三家：智谱 / 通义 / Gemini');
  ok(Object.values(PROVIDERS).every(p => p.model && p.keyName), 'E8 每家都有默认模型和 key 名');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
