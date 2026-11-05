/* 外部消息入口（chat-in）
 * ------------------------------------------------------------
 * 验四件事：
 *   收得下（落盘、不改话、超长截断）
 *   合得对（同一人同一句只算一次；不同人同一句不算）
 *   交得准（三种时机策略各自的行为，以及"只收不发"）
 *   坏不了（适配器起不来、onBatch 抛错、待看超上限）
 *
 * 跑：node tools/brain-test/chat-in-test.mjs
 */
import { createChatIn, normalizeMsg, SOURCES, POLICIES } from '../../js/brain/chat-in.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(a === b, name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

/* 假的 loop：只记"听见了什么"，别的什么都不做——这一层只该碰 hear。 */
function fakeLoop() {
  const heard = [];
  return {
    heard,
    hear({ text, from, name, source }) {
      if (!text) return { ok: false, heard: false, reason: 'empty' };
      heard.push({ text, from, name, source });
      return { ok: true, heard: true, busy: false, id: 'e' + heard.length };
    },
  };
}

/* 可控时间 + 可控定时器：window 策略要有办法"推进时间"才能验。 */
function fakeClock() {
  let t = 1_000_000;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => t,
    schedule: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    cancel: id => { timers.delete(id); },
    advance(ms) {
      t += ms;
      for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); x.fn(); }
    },
    get pendingTimers() { return timers.size; },
  };
}

/* ================= A. 形状 ================= */
console.log('\nA. 一条消息变成什么');
{
  eq(POLICIES.join('/'), 'every/window/never', 'A1 三种时机策略就这三样');
  ok(SOURCES.includes('danmaku') && SOURCES.includes('group'), 'A2 弹幕和群聊都是来源，不是同一件事');

  const a = normalizeMsg({ text: '  你好\n呀 ', from: 'him' });
  eq(a.text, '你好 呀', 'A3 换行和多余空格压成一行（提示词里不能有多行的一句）');
  eq(a.from, 'him', 'A4 他本人还是 him');
  eq(a.name, '', 'A5 他自己不需要名字');
  eq(a.source, 'script', 'A6 没写来源就当脚本（不编一个平台）');

  const b = normalizeMsg({ text: '在吗', from: 'xiaoming', name: '小明', source: 'danmaku' });
  eq(b.from, 'guest:xiaoming', 'A7 外来的人统一成 guest:xxx');
  eq(b.name, '小明', 'A8 名字留着');
  eq(b.source, 'danmaku', 'A9 来源认得');
  eq(normalizeMsg({ text: 'x', from: 'u1' }).name, 'u1', 'A10 没给名字就用 id，不编"网友123"');
  eq(normalizeMsg({ text: '  ' }), null, 'A11 空话连一条记录都不产生');
  eq(normalizeMsg({ text: '啊'.repeat(900) }).text.length, 500, 'A12 超长截到 500');
  eq(normalizeMsg({ text: 'hi', source: '不明来源' }).source, 'script', 'A13 不认识的来源退回 script，不抛');
}

/* ================= B. 收下 ================= */
console.log('\nB. 收下（收下 ≠ 要回）');
{
  const loop = fakeLoop();
  const got = [];
  const c = createChatIn({ loop, policy: 'never', onBatch: b => got.push(b) });
  const r = c.receive({ text: '你好', from: 'xiaoming', name: '小明', source: 'danmaku' });

  ok(r.ok && r.recorded, 'B1 返回"收下了"');
  eq(loop.heard.length, 1, 'B2 走的是 loop.hear（唯一落盘的地方）');
  eq(loop.heard[0].from, 'guest:xiaoming', 'B3 落盘时带上了是谁');
  eq(loop.heard[0].name, '小明', 'B4 落盘时带上了名字');
  eq(got.length, 0, 'B5 never 策略：收下但一句话都不发出去');
  eq(c.pending, 1, 'B6 但它确实在"待看"里，不是被丢了');
  eq(c.stats().heard, 1, 'B7 收下和交出去分开数');

  const bad = c.receive({ text: '   ' });
  ok(!bad.ok && bad.reason === 'empty', 'B8 空话拒绝，且不落盘');
  eq(loop.heard.length, 1, 'B9 空话没进记忆');
}

/* ================= C. 合并 ================= */
console.log('\nC. 合并去重');
{
  const loop = fakeLoop();
  const clock = fakeClock();
  const c = createChatIn({ loop, now: clock.now, policy: 'never', mergeMs: 4000, windowMs: 100, schedule: clock.schedule, cancel: clock.cancel });

  const a = c.receive({ text: '草', from: 'u1', name: '甲' });
  const b = c.receive({ text: '草', from: 'u1', name: '甲' });
  const d = c.receive({ text: '草', from: 'u1', name: '甲' });
  ok(a.merged !== true, 'C1 第一遍是真收下');
  ok(b.merged && b.count === 2, 'C2 第二遍算合并，次数 +1');
  ok(d.merged && d.count === 3, 'C3 第三遍次数到 3');
  eq(loop.heard.length, 1, 'C4 三遍只落一条（同一件事不是三件事）');
  eq(c.stats().merged, 2, 'C5 合并次数单独记');

  clock.advance(5000);
  const e = c.receive({ text: '草', from: 'u1', name: '甲' });
  ok(e.merged !== true, 'C6 过了合并窗口，同一句再说算新的一条');
  eq(loop.heard.length, 2, 'C7 它真的又落了一条');

  const f = c.receive({ text: '草', from: 'u2', name: '乙' });
  ok(f.merged !== true, 'C8 换个人说同一句，不算刷屏');
  eq(loop.heard.length, 3, 'C9 三个人的三句都在');
}

/* ================= D. 三种时机 ================= */
console.log('\nD. 什么时候让她看一眼');
{
  /* every：来一条交一条 */
  const loop = fakeLoop();
  const got = [];
  const c = createChatIn({ loop, policy: 'every', onBatch: b => got.push(b) });
  c.receive({ text: '一', from: 'u1' });
  c.receive({ text: '二', from: 'u2' });
  eq(got.length, 2, 'D1 every：两条消息交给页面两次');
  eq(got[0][0].text, '一', 'D2 每一次只带当前这一条');

  /* window：攒一批 */
  const loop2 = fakeLoop();
  const clock = fakeClock();
  const got2 = [];
  const c2 = createChatIn({ loop: loop2, now: clock.now, policy: 'window', windowMs: 1500,
    schedule: clock.schedule, cancel: clock.cancel, onBatch: b => got2.push(b) });
  c2.receive({ text: '一', from: 'u1' });
  c2.receive({ text: '二', from: 'u2' });
  c2.receive({ text: '三', from: 'u3' });
  eq(got2.length, 0, 'D3 window：还没到时间，先不打扰');
  eq(c2.pending, 3, 'D4 三条都在待看里');
  clock.advance(1500);
  eq(got2.length, 1, 'D5 到点只交一次');
  eq(got2[0].length, 3, 'D6 一次交的是三条，不是三条三次');
  eq(c2.pending, 0, 'D7 交完就清空');

  /* window 里又来了新的：计时重置，不提前 */
  const got3 = [];
  const c3 = createChatIn({ loop: fakeLoop(), now: clock.now, policy: 'window', windowMs: 1500,
    schedule: clock.schedule, cancel: clock.cancel, onBatch: b => got3.push(b) });
  c3.receive({ text: '甲', from: 'u1' });
  clock.advance(1000);
  c3.receive({ text: '乙', from: 'u2' });
  clock.advance(1000);
  eq(got3.length, 0, 'D8 新消息把窗口往后推（不在一句话中间截断）');
  clock.advance(600);
  eq(got3.length, 1, 'D9 攒够一整段才交');
  eq(got3[0].length, 2, 'D10 两条一起交');

  /* never + flush */
  const loop4 = fakeLoop();
  const got4 = [];
  const c4 = createChatIn({ loop: loop4, policy: 'never', onBatch: b => got4.push(b) });
  c4.receive({ text: '一', from: 'u1' });
  eq(got4.length, 0, 'D11 never：不自己交');
  const batch = c4.flush();
  eq(got4.length, 1, 'D12 手动 flush 能交（她醒来时用这个）');
  eq(batch.length, 1, 'D13 flush 把交出去的那批返回给调用方');

  /* 暂停 */
  const got5 = [];
  const c5 = createChatIn({ loop: fakeLoop(), policy: 'every', onBatch: b => got5.push(b) });
  c5.pause();
  c5.receive({ text: '一', from: 'u1' });
  eq(got5.length, 0, 'D14 暂停时不交');
  c5.resume();
  c5.flush();
  eq(got5.length, 1, 'D15 恢复后能补交（暂停期间的话没丢）');
}

/* ================= E. 待看超上限 ================= */
console.log('\nE. 太多了怎么办');
{
  const c = createChatIn({ loop: fakeLoop(), policy: 'never', maxPending: 3 });
  for (const t of ['一', '二', '三', '四', '五']) c.receive({ text: t, from: 'u1' });
  eq(c.pending, 3, 'E1 待看最多 3 条');
  eq(c.stats().dropped, 2, 'E2 挤掉的两条要计数（不许静默丢）');
  ok(c.log().some(x => x.op === 'drop'), 'E3 丢的时候留了痕，能查是哪两条');
  const b = c.flush();
  eq(b.at(-1).text, '五', 'E4 留下的是最新的（人也是这样）');
}

/* ================= F. 适配器 ================= */
console.log('\nF. 来源适配器');
{
  const loop = fakeLoop();
  const c = createChatIn({ loop, policy: 'never' });

  let emitFn = null;
  let stopped = 0;
  c.registerAdapter('danmaku', {
    start(emit) { emitFn = emit; },
    stop() { stopped += 1; },
  });
  c.registerAdapter('broken', { start() { throw new Error('连不上'); } });

  const out = c.startAll();
  eq(out.length, 2, 'F1 两个适配器都试了一遍');
  ok(out.find(x => x.id === 'broken').started === false, 'F2 起不来的那个如实说没起来');
  ok(c.adapters().find(x => x.id === 'broken').error.includes('连不上'), 'F3 起不来的原因留着');
  ok(c.adapters().find(x => x.id === 'danmaku').started, 'F4 另一个照常起来（坏一个不拖垮全部）');

  emitFn({ text: '主播你好', from: 'u9', name: '观众甲' });
  eq(loop.heard.length, 1, 'F5 适配器发一条，就落一条');
  eq(loop.heard[0].source, 'danmaku', 'F6 来源记成适配器 id');
  eq(loop.heard[0].name, '观众甲', 'F7 名字带上了');

  c.stopAll();
  eq(stopped, 1, 'F8 stopAll 真的停了适配器');
  ok(!c.adapters().find(x => x.id === 'danmaku').started, 'F9 状态跟着变');

  let threw = false;
  try { c.registerAdapter('danmaku', { start() {} }); } catch { threw = true; }
  ok(threw, 'F10 重名要当场报错（不然两个来源抢一个 id）');

  let threw2 = false;
  try { c.registerAdapter('x', {}); } catch { threw2 = true; }
  ok(threw2, 'F11 没有 start 的不算适配器');
}

/* ================= G. 坏不掉 ================= */
console.log('\nG. 坏不了');
{
  const c = createChatIn({
    loop: fakeLoop(), policy: 'every',
    onBatch: () => { throw new Error('页面那边炸了'); },
  });
  const r = c.receive({ text: '一', from: 'u1' });
  ok(r.ok, 'G1 onBatch 抛错不影响接收');
  eq(c.stats().errors, 1, 'G2 抛错要计数');

  const c2 = createChatIn({ loop: { hear() { throw new Error('记忆写不进去'); } } });
  const r2 = c2.receive({ text: '一', from: 'u1' });
  ok(!r2.ok && r2.reason === 'hear_failed', 'G3 落盘失败要如实说失败（不能假装收下了）');

  const c3 = createChatIn({ loop: fakeLoop(), policy: 'window', windowMs: 1000 });
  c3.receive({ text: '一', from: 'u1' });
  c3.close();
  eq(c3.pending, 0, 'G4 close 之后不留下定时器勾着页面');
}

/* ================= H. 给它一张人话说明书 ================= */
console.log('\nH. 描述');
{
  const c = createChatIn({ loop: fakeLoop(), policy: 'window', windowMs: 2000 });
  c.registerAdapter('group', { start() {} });
  const d = c.describe();
  ok(d.includes('攒') && d.includes('2000'), 'H1 说清楚"多久看一次"', d);
  ok(d.includes('group'), 'H2 说清楚有哪些来源', d);
  c.receive({ text: '一', from: 'u1' });
  ok(c.describe().includes('待看 1'), 'H3 说清楚还有几条没看', c.describe());
}

console.log(`\n${fail ? '✗ ' : '✓ '} 通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
