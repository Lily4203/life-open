/* 流式：一边到一边说
 * ------------------------------------------------------------
 * 这里验的不是"能流"，是**流式最容易错的那几处**：
 *   中文被切成两半（不加 TextDecoder({stream:true}) 就变乱码）；
 *   一条消息被拆开、两条粘在一起（不缓冲就一定丢）；
 *   [DONE] 和最后一条数据挤在同一个 chunk 里（"发现 [DONE] 就结束"会丢最后一帧）；
 *   说出去的话和定稿接不上（会重复说 / 说半句就改口）。
 *
 * 还有一条最要紧的：**什么时候开口**。散文不开口、半句不开口、quiet 一个都不开口——
 * 这些不是性能优化，是"说了收不回"的代价。
 *
 * 跑：node tools/brain-test/stream-test.mjs
 */
import { extractSay, takeSentences, createLiveSay } from '../../js/brain/say-stream.mjs';
import { createSseParser, createSseDecoder } from '../../js/brain/sse.mjs';
import { createLoop } from '../../js/brain/loop.mjs';
import { createMemory } from '../../js/brain/memory.mjs';
import { createRegistry } from '../../js/brain/actions.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(a === b, name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

/* ================= A. 从没写完的 JSON 里抠 say ================= */
console.log('\nA. 抠 say（原文可能只有一半）');
{
  const a = extractSay('{"say":"椅子在那边。"}');
  eq(a.text, '椅子在那边。', 'A1 完整的一句');
  ok(a.closed, 'A2 右引号到了就是 closed');

  const b = extractSay('{"say":"我在想');
  eq(b.text, '我在想', 'A3 引号还没闭合，也给已经确定的那部分');
  ok(!b.closed, 'A4 没闭合就不算说定');

  eq(extractSay('{"say":"他说\\"好\\"。"}').text, '他说"好"。', 'A5 \\" 还原成引号');
  eq(extractSay('{"say":"第一行\\n第二行"}').text, '第一行\n第二行', 'A6 \\n 还原成换行');
  eq(extractSay('{"say":"\\u4f60\\u597d"}').text, '你好', 'A7 \\uXXXX 还原成字');

  /* 流恰好断在一个转义符中间：已经确定的部分照给，那半个转义不能猜 */
  const c = extractSay('{"say":"你好\\');
  eq(c.text, '你好', 'A8 转义写了一半，不猜那半个字');
  ok(!c.closed, 'A9 半个转义也算没闭合');

  ok(!extractSay('{"do":[]}').found, 'A10 没有 say 键就是不 found');
  const n = extractSay('{"say":null}');
  ok(!n.found && n.notString, 'A11 say 是 null（格式换了）要认出来，不能当成"她没说"');

  eq(extractSay('{"do":[{"do":"go_to"}],"say":"走了。"}').text, '走了。', 'A12 say 排在别的键后面也找得到');
  eq(extractSay('{"say":"看见 { 和 } 也不算结束"}').text, '看见 { 和 } 也不算结束', 'A13 话里的花括号不是 JSON 结束');
}

/* ================= B. 切句 ================= */
console.log('\nB. 切句（只在能确定是整句的地方切）');
{
  const r1 = takeSentences('我在想。你等一下。');
  eq(r1.ready.length, 2, 'B1 两句都能切出来');
  eq(r1.ready[0].text, '我在想。', 'B2 第一句');
  eq(r1.rest, '', 'B3 切完没有剩的');

  const r2 = takeSentences('我在');
  eq(r2.ready.length, 0, 'B4 没有句末标点就不切（半句说出去收不回）');
  eq(r2.rest, '我在', 'B5 尾巴留在手里等下一批字');

  const r3 = takeSentences('什么？！真的吗？');
  eq(r3.ready[0].text, '什么？！', 'B6 连着两个标点算一句，不拆成两句');

  const r4 = takeSentences('他说「好」。');
  eq(r4.ready[0].text, '他说「好」。', 'B7 收尾的引号跟着句子一起走');

  const long = '一'.repeat(100);
  const r5 = takeSentences(long, { max: 40 });
  ok(r5.ready.length > 0 && r5.ready[0].text.length <= 40, 'B8 一直没有标点也太长，就在中间断开（不能憋成一段）', JSON.stringify(r5.ready.map(x => x.text.length)));

  const soft = '一'.repeat(30) + '，' + '二'.repeat(30);
  const r6 = takeSentences(soft, { max: 40 });
  ok(r6.ready[0].text.endsWith('，'), 'B9 要断的时候优先断在逗号上，不硬切');

  const r7 = takeSentences('。。');
  eq(r7.ready.length, 0, 'B10 只有标点不算一句话');

  const r8 = takeSentences('第一句\n第二句');
  eq(r8.ready[0].text, '第一句', 'B11 换行也算一句结束');

  /* 切出去的长度加起来必须等于原文——差一个字，后面每一句都会错位 */
  const src = '一二三。四五！六七？八九十';
  const r9 = takeSentences(src);
  eq(src.slice(0, r9.usedAll) + r9.rest, src, 'B12 usedAll 记的是原文吃掉多少，拼回去一个字不差');

  /* 真跑踩到的：模型用 "  \n" 给句子之间留空。跳过的空白也算吃掉了，
   * 不算的话下一次会从同一处重扫，同一句被说两遍。 */
  const r10 = takeSentences('A。  \nB。');
  eq(r10.ready.length, 2, 'B13 句间有空白也切得出两句');
  eq(r10.usedAll, 'A。  \nB。'.length, 'B14 被跳过的空白也算吃掉（usedAll 是原文长度，不是句子长度之和）');
  ok(r10.ready.reduce((n, x) => n + x.used, 0) < r10.usedAll, 'B15 句子长度之和与原文长度不等——所以不能拿它当游标');
}

/* ================= C. 什么时候开口 ================= */
console.log('\nC. 什么时候开口');
{
  /* 一条流回散文：一个字都不提前说。
   * 单独一个实例，因为一轮就是一次响应——散文和 JSON 不会同时出现在同一条流里。 */
  const prose = [];
  const p = createLiveSay({ show: t => prose.push(t), speak: () => {} });
  p.begin();
  p.onDelta('我去翻翻原文。');
  eq(prose.length, 0, 'C1 一上来是散文（不是 JSON）：一个字都不说，等着看是不是要重发');
  p.onDelta('（我看看那本红色的）');
  eq(prose.length, 0, 'C2 一直是散文就一直不说');
}

{
  const said = [];
  const live = createLiveSay({ show: t => said.push(t), speak: () => {}, now: (() => { let t = 0; return () => (t += 100); })() });
  live.begin();

  live.onDelta('{"say":"');
  eq(said.length, 0, 'C3 看见了 say 键，但还没有整句');

  live.onDelta('我在想。');
  eq(said.length, 1, 'C4 攒够一整句就开口');
  eq(said[0], '我在想。', 'C5 说的是模型给的那一句，一个字没改');

  live.onDelta('你等一');
  eq(said.length, 1, 'C6 半句不说');
  live.onDelta('下。');
  eq(said.length, 2, 'C7 补齐成句了才说');
  eq(said[1], '你等一下。', 'C8 第二句');

  /* 同一份累计原文再给一遍（网络重发/重复帧）：不许重复说。
   * 注意这里传的是 full（累计），不是 delta——delta 分不出"重复"和"真的又说了遍"。 */
  live.onDelta('', '{"say":"我在想。你等一下。');
  eq(said.length, 2, 'C9 同一份累计原文再给一遍也不重说');

  ok(live.stats().firstMs === 100, 'C10 首句延迟记着（这就是流式换来的东西）', String(live.stats().firstMs));
}

{
  /* quiet：只流不说。字照样进来，但一个都不放出去 */
  const said = [];
  const q = createLiveSay({ mode: 'quiet', show: t => said.push(t), speak: () => {} });
  q.begin();
  q.onDelta('{"say":"我在想。"}');
  eq(said.length, 0, 'C11 quiet 模式一个字都不提前说');
  eq(q.stats().chars, 14, 'C12 但字是收到了的（能看见她在写）');
  eq(q.finish('我在想。').rest, '我在想。', 'C13 定稿时整段交给上层去说');
}

{
  /* off：压根不走流 */
  const said = [];
  const o = createLiveSay({ mode: 'off', show: t => said.push(t), speak: () => {} });
  o.begin();
  o.onDelta('{"say":"我在想。"}');
  eq(said.length, 0, 'C14 off 模式不开口');
  eq(o.finish('我在想。').rest, '我在想。', 'C15 off 模式整段交出去（和没有流式时一样）');
}

/* ================= D. 定稿对账 ================= */
console.log('\nD. 定稿：哪一段还没说');
{
  const mk = () => {
    const said = [];
    const l = createLiveSay({ show: t => said.push(t), speak: () => {}, onEvent: () => {} });
    l.begin();
    return { l, said };
  };

  const a = mk();
  a.l.onDelta('{"say":"我在想。你等一下。');
  eq(a.said.length, 2, 'D1 两句都先说出去了');
  eq(a.l.finish('我在想。你等一下。').rest, '', 'D2 全说过了，剩空——不能再补一遍');

  const b = mk();
  b.l.onDelta('{"say":"我在想。');
  const fb = b.l.finish('我在想。你别急，马上就好。');
  eq(fb.rest, '你别急，马上就好。', 'D3 只说了一句，剩下那句要补上');
  ok(!fb.mismatch, 'D4 接得上就不算对不上');

  const c = mk();
  c.l.onDelta('{"say":"我在想。');
  const fc = c.l.finish('算了，不去了。');
  ok(fc.mismatch, 'D5 定稿和已说的接不上：要认出来，不能装没发生');
  eq(fc.rest, '算了，不去了。', 'D6 对不上就把定稿整段交出去（她改口了，得让她说出来）');
  eq(c.l.stats().mismatches, 1, 'D7 对不上的次数记着');

  const d = mk();
  d.l.onDelta('{"say":"');
  eq(d.l.finish('').rest, '', 'D8 一个字都没说、定稿也是空：什么都不说');

  /* 真跑抓到的第二种错位：定稿里句子之间带着 "  \n"，说出去的句子没有空白。
   * 按"已说字数"去切定稿，就会切在字中间，最后那句只剩半句。 */
  const e = mk();
  e.l.onDelta('{"say":"我在听你说话。  \\n没事干，闲着。');
  eq(e.said.length, 2, 'D9 带空白的句子照样一句一句说');
  const fe = e.l.finish('我在听你说话。  \n没事干，闲着。  \n你呢？');
  eq(fe.rest, '你呢？', 'D10 定稿时要按字对齐，不能按长度切（否则最后半句是断的）');
  ok(!fe.mismatch, 'D11 空白不同不算"改口"');
}

/* ================= E. 打断 ================= */
console.log('\nE. 打断');
{
  let stopped = 0;
  const said = [];
  const l = createLiveSay({ show: t => said.push(t), speak: () => {}, stop: () => { stopped += 1; } });
  l.begin();
  l.onDelta('{"say":"我在想。');
  eq(said.length, 1, 'E1 打断之前已经说了一句');
  l.abort();
  eq(stopped, 1, 'E2 打断要把声音停掉');
  l.onDelta('你等一下。');
  eq(said.length, 1, 'E3 打断之后来的字一律不再说');
  eq(l.stats().aborts, 1, 'E4 打断次数记着');
  eq(l.abort().ok, false, 'E5 重复打断不重复算');
}

/* ================= F. SSE 分帧（照 eventsource-parser + 规范） ================= */
console.log('\nF. SSE 分帧');
{
  const got = [];
  const p = createSseParser({ onEvent: e => got.push(e.data) });
  p.push('data: {"d":"你好"}\n\n');
  eq(got[0], '{"d":"你好"}', 'F1 一条完整消息');

  const got2 = [];
  const p2 = createSseParser({ onEvent: e => got2.push(e.data) });
  p2.push('data: {"d":"你');
  eq(got2.length, 0, 'F2 半条消息先攒着（不猜）');
  p2.push('好"}\n\n');
  eq(got2[0], '{"d":"你好"}', 'F3 补齐了才交出来');

  const got3 = [];
  const p3 = createSseParser({ onEvent: e => got3.push(e.data) });
  p3.push('data: a\n\ndata: b\n\n');
  eq(got3.join('|'), 'a|b', 'F4 两条粘在同一个 chunk 里也不能丢第二条');

  const got4 = [];
  const p4 = createSseParser({ onEvent: e => got4.push(e.data) });
  p4.push('data: 第一行\ndata: 第二行\n\n');
  eq(got4[0], '第一行\n第二行', 'F5 多条 data 行用换行连起来（不是覆盖）');

  const got5 = [];
  const p5 = createSseParser({ onEvent: e => got5.push(e.data) });
  p5.push(': ping\n\ndata: a\n\n');
  eq(got5.join('|'), 'a', 'F6 冒号开头是注释/心跳，丢掉，不能打断正在攒的消息');

  const got6 = [];
  const p6 = createSseParser({ onEvent: e => got6.push(e.data) });
  p6.push('data: a\r\n\r\n');
  eq(got6[0], 'a', 'F7 CRLF 也认（Windows 上的服务端会发这个）');

  const got7 = [];
  const p7 = createSseParser({ onEvent: e => got7.push(e.data) });
  p7.push('data:  两个空格\n\n');
  eq(got7[0], ' 两个空格', 'F8 data: 后面只去掉一个空格（规范写死的 exactly one）');

  const got8 = [];
  const p8 = createSseParser({ onEvent: e => got8.push(e.data) });
  // 两条**各自完整**的消息挤在同一个 chunk 里（这才是真实情况：服务端一次 write 两条）
  p8.push('data: 最后一条\n\ndata: [DONE]\n\n');
  eq(got8.join('|'), '最后一条|[DONE]', 'F9 [DONE] 和最后一条挤在同一个 chunk：当成独立消息，不能连最后一条一起丢');

  const got9 = [];
  const p9 = createSseParser({ onEvent: e => got9.push(e.data) });
  p9.push('data: 没有结尾空行');
  eq(got9.length, 0, 'F10 还没到空行，先不提交');
  p9.end();
  eq(got9[0], '没有结尾空行', 'F11 流结束时把最后一帧交出来（服务端常常直接 close）');
}

{
  /* 真实会出事的那条：一个汉字的三个字节被切到两个 chunk 里。
   * 不加 TextDecoder({stream:true}) 就会解成 "�"——英文测试永远发现不了。 */
  const bytes = Buffer.from('data: {"d":"你好"}\n\n', 'utf8');
  const cut = bytes.indexOf(Buffer.from('你', 'utf8')) + 1;   // 切在"你"的三个字节中间
  const got = [];
  const dec = createSseDecoder({ onEvent: e => got.push(e.data) });
  dec.push(bytes.subarray(0, cut));
  dec.push(bytes.subarray(cut));
  dec.end();
  eq(got[0], '{"d":"你好"}', 'F12 中文被切成两半也能拼回来（不是乱码，也不是少一个字）');
  ok(!/�/.test(String(got[0] || '')), 'F13 不能出现替换字符');
}

{
  const got = [];
  const dec = createSseDecoder({ onEvent: e => got.push(e.data) });
  const b = Buffer.from('data: ok', 'utf8');
  dec.push(b);
  eq(got.length, 0, 'F14 没有换行结尾时先不交');
  dec.end();
  eq(got[0], 'ok', 'F15 end() 收尾把它交出来');
}

/* ================= H. 和大脑对接：第二遍什么时候才允许接流 ================= */
/* 真跑踩到的场景：模型先用散文回一句（"站着，没动。灯亮着…"），我们一个字都没说，
 * 然后走格式重发拿到 JSON。重发那遍如果不接流，流式的收益正好被最常见的这条路吃掉。
 * 反过来，已经说出去半句再换一段接着说，两段会拼成一句她没说过的话。 */
function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    read: n => m.get(n) ?? '',
    write: (n, t) => { m.set(n, t); },
    append: (n, t) => { m.set(n, (m.get(n) || '') + t); },
  };
}
const newLoop = chat => createLoop({
  memory: createMemory({ store: memStore(), charId: 'fish' }),
  registry: createRegistry(),
  chat,
});

console.log('\nH. 第二遍要不要接流');
{
  const gotDelta = [];
  const chat = async ({ onDelta }) => {
    gotDelta.push(!!onDelta);
    if (gotDelta.length === 1) {
      onDelta?.('我去翻翻原文。', '我去翻翻原文。');
      return { content: '我去翻翻原文。' };            // 散文 → parseError → 重发
    }
    onDelta?.('{"say":"', '{"say":"');
    return { content: '{"say":"原文我找到了。","do":[]}' };
  };
  const loop = newLoop(chat);
  /* 假装成页面：散文一个字都说不出来（said:0），JSON 才说得出话（said:1）。
   * 这一条正是"重发要不要接流"的分水岭。 */
  const r = await loop.turn({ text: '去翻翻', onDelta: d => ({ said: /^\s*\{/.test(String(d)) ? 1 : 0 }) });
  ok(r.ok, 'H1 这一轮走完了');
  eq(gotDelta.length, 2, 'H2 散文那次确实触发了重发');
  ok(gotDelta[0] && gotDelta[1], 'H3 一个字都没说出去时，重发那遍也接流（不然最常见的那条路没有流式收益）');
}

{
  const gotDelta = [];
  const chat = async ({ onDelta }) => {
    gotDelta.push(!!onDelta);
    if (gotDelta.length === 1) {
      onDelta?.('{"say":"我先看看。","read":["m1"]}', '{"say":"我先看看。","read":["m1"]}');
      return { content: '{"say":"我先看看。","read":["m1"]}' };
    }
    return { content: '{"say":"看完了。","read":[]}' };
  };
  const loop = newLoop(chat);
  await loop.turn({ text: '看看', onDelta: () => ({ said: 1 }) });
  eq(gotDelta.length, 2, 'H4 说了 read 会再问一遍');
  ok(gotDelta[0] === true && gotDelta[1] === false,
    'H5 已经说出去话了：取正文那遍不再接流（否则两句会拼成一句她没说过的话）');
}

{
  /* 页面靠"第几次"来清缓冲：换了一遍就该从零抠，但说过的话不能跟着清 */
  const said = [];
  const l = createLiveSay({ show: t => said.push(t), speak: () => {} });
  l.begin();
  l.onDelta('{"say":"第一句。');
  eq(said.length, 1, 'H6 第一遍说了第一句');
  l.nextAttempt();
  l.onDelta('{"say":"第二句。');
  eq(said.length, 2, 'H7 换一遍之后还能接着说（缓冲清了，说过的不清）');
  eq(l.spoken, '第一句。第二句。', 'H8 说过的话累计着——定稿时要用它对账');
  eq(l.finish('第一句。第二句。').rest, '', 'H9 两遍说的正好是定稿，不重复说');
}

/* ================= G. 源码断言：这几处不许退回去 ================= */
console.log('\nG. 源码断言');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const root = path.resolve(here, '../..');
  const page = fs.readFileSync(path.join(root, '预览-66.html'), 'utf8');
  const serve = fs.readFileSync(path.join(root, 'tools/serve.mjs'), 'utf8');
  const net = fs.readFileSync(path.join(root, 'tools/net-http.mjs'), 'utf8');

  ok(page.includes('getReader()'), 'G1 页面用流式读（getReader），不是等 response.json()');
  ok(page.includes('createSseDecoder'), 'G2 页面用同一个分帧器，不是自己 split');
  ok(/stream:\s*true/.test(page), 'G3 页面确实请求流式');
  /* 真会出事的那种写法：先 r.json() 把流吃掉，再想读就晚了。
   * 所以"是不是事件流"必须先看 content-type，再决定走哪条路。 */
  ok(/ct\.includes\('text\/event-stream'\)/.test(page), 'G4 先看 content-type 再决定走流还是走整段（不然 r.json() 会把流吃掉）');

  ok(/if \(delta\.reasoning_content\)/.test(serve), 'G5 思考内容（reasoning_content）要挡掉，不能当她说的话转出去');
  ok(/stream: true/.test(serve), 'G6 服务端确实向上游要流');
  ok(/ac\.abort\(\)/.test(serve) && /res\.on\('close'/.test(serve), 'G7 页面断了自己也要掐上游（不然钱还在花）');
  ok(/req\.destroy/.test(net), 'G8 掐断要真的 destroy 请求，不是只标记一下');

  ok(page.includes('stopSpeak()') && page.includes('live.abort()'), 'G9 打断要同时停声音和停活字');
  ok(/deliverSay/.test(page), 'G10 定稿只补"没说过的"（不然整段说两遍）');

  /* ---- 逐句出声：最容易被"顺手简化"掉的一段 ----
   * 流式是**一句一次** speaker.speak。如果直接调 voice.speak，它一进去就 hardStop 前一句，
   * 结果就是"只听到最后一句"——而且听不出是 bug，只觉得她说话怪。
   * 所以逐句必须走队列，且队列要按代熄声（被打断后不许把排着的念完）。 */
  ok(/speak:\s*t\s*=>\s*loop\.executor\.speak\(t,\s*\{\s*append:\s*true/.test(page),
    'G11 流式逐句走执行层 + append（同一段话的延续，不是另起一句）');
  ok(/speakQueued\(/.test(page) && /function speakQueued/.test(page),
    'G12 逐句出声要排队，不许直接 voice.speak（它会掐掉上一句）');
  ok(/my !== speakGen/.test(page),
    'G13 队列带代：被打断之后，排着的那几句一句都不许再出声');
  ok(/speakGen \+= 1[\s\S]{0,200}voice\.stop\(\)/.test(page),
    'G14 stopSpeak 既加代又真停声（加代不真停 = 还在响；真停不加代 = 回头又念）');
  ok(!/speak:\s*t\s*=>\s*voice\.speak\(/.test(page),
    'G15 流式的出口不许绕过 executor（绕过就是两个出口，账也对不上）');
  /* 排队要等"真的播完"。按 duration 估算会掐尾（估短）或留空档（估长），
   * 两种都听得出来；onended 才知道得准。但 onended 有环境不触发，所以必须带超时兜底，
   * 否则一句卡住，后面的排到天荒地老。 */
  ok(/Promise\.race\(\[r\.done/.test(page),
    'G16 排队等的是 done（onended），不是估算时长');
  ok(/setTimeout\(res, cap\)/.test(page),
    'G17 done 没来时有超时兜底（不然一句卡死后面全哑）');
}

console.log(`\n${fail ? '✗' : '✓'} 全部通过：${pass}${fail ? `，失败 ${fail}` : ''}`);
process.exit(fail ? 1 : 0);
