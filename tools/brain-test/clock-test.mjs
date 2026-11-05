/* 时钟端口：什么时候算"一个时刻"
 * ============================================================
 * 这一组不是测"功能对不对"，是测**方向和边界对不对**。
 *
 * 两句用户原话（2026-11-05）：
 *   ① "这个动力来源是什么？谁来写？如果是我们做的算法驱动大模型去做，那就没意义"
 *   ② "让模型自己会动这个部分要是做不出来可以先往后放，留下的做一个和别的一样
 *       所有人都可以替换的接口就好了"
 *
 * 所以分三段：
 *   A–D  钟本身：只递时刻、不带主张、不打断、不乱花钱；
 *   E    出处：源码里不该再有那套衰减曲线，提示词里不该替她下判断；
 *   F–G  真跑一次空时刻，以及**这个接口是不是真能换**（三个内置钟 + 注册门）。
 *
 * 跑：node tools/brain-test/clock-test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClock, registerClock, listClocks, describeClocks, BUILTIN_CLOCKS,
  TICK_MS, IDLE_MS, AFTER_HUMAN_MS } from '../../js/brain/clock.mjs';
import { createLoop } from '../../js/brain/loop.mjs';
import { createMemory } from '../../js/brain/memory.mjs';
import { createRegistry } from '../../js/brain/actions.mjs';
import { buildWakeSystem } from '../../js/brain/prompt.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);
/* 一拍跑完才放开下一拍，所以两次 step 之间要让微任务落定。 */
const flush = () => new Promise(r => setTimeout(r, 0));

console.log('\nA. 钟只递时刻，不递主张');

{
  let t = 1_000_000;
  const calls = [];
  const st = { busy: false, pending: 0, ownPlan: 0, sinceHumanMs: 999_999 };
  const b = createClock({ kind: 'beat',
    now: () => t,
    wake: (o) => { calls.push(o); return Promise.resolve(); },
    state: () => st,
  });

  eq(b.step(), { fired: false, why: 'stopped' }, 'A1 没 start 之前一步都不走');
  b.start();
  eq(b.lastIdleAt(), t, 'A2 开机那一刻算刚给过（不会一开页面就空转）');

  t += TICK_MS;
  eq(b.step().why, 'not_yet', 'A3 一分钟还没到空转的间隔');
  t += IDLE_MS;
  const r = b.step();
  await flush();
  eq(r.why, 'beat', 'A4 到了才递一个空时刻');
  eq(calls.length, 1, 'A5 只递了一次');
  eq(calls[0], { reason: 'beat', beat: true }, 'A6 递出去的只有"这是个时刻"，没有"你难受了"');
  /* 这就是整条立论：wake 的入参里除了一个布尔，什么都没有。
   * 想在这里加 drives/fatigue/thirst 之类的字段，先读 beat.mjs 顶上那段。 */
  eq(Object.keys(calls[0]).sort(), ['beat', 'reason'], 'A7 入参里没有一个字是在说她该有什么感觉');

  t += IDLE_MS;
  b.step();
  eq(calls.length, 2, 'A8 过一个 idleMs 还能再给一次');
}

console.log('\nB. 三条合法来源，一条优先');

{
  let t = 0;
  const calls = [];
  const st = { busy: false, pending: 0, ownPlan: 0, sinceHumanMs: 999_999 };
  const b = createClock({ kind: 'beat', now: () => t, wake: o => { calls.push(o); return Promise.resolve(); }, state: () => st });
  b.start();

  st.pending = 1;
  eq(b.step().why, 'world', 'B1 世界真的变了 → 先处理事实');
  await flush();
  st.pending = 0;
  st.ownPlan = 2;
  eq(b.step().why, 'own_plan', 'B2 她自己写下过还没做的 → 递给她自己的话');
  await flush();
  st.pending = 3; st.ownPlan = 2;
  eq(b.step().why, 'world', 'B3 两样都有 → 先外面，再自己（外面的不能等）');
  await flush();
  eq(calls.map(c => c.beat), [false, false, false], 'B4 有事的时候不算"空时刻"（beat:false）');
}

console.log('\nC. 不打断、不重叠、不补发');

{
  let t = 0;
  const calls = [];
  const st = { busy: false, pending: 0, ownPlan: 0, sinceHumanMs: 999_999 };
  const b = createClock({ kind: 'beat', now: () => t, wake: o => { calls.push(o); return Promise.resolve(); }, state: () => ({ ...st, sinceHumanMs: 5_000 }) });
  b.start();
  t += IDLE_MS * 2;
  eq(b.step().why, 'talking', 'C1 他刚说完话 → 不塞空时刻进去（那是打断，不是陪）');
  ok(AFTER_HUMAN_MS > 0, 'C2 这个窗口是可配的，不是硬编码在页面里');
}

{
  let t = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const b = createClock({ kind: 'beat',
    now: () => t,
    wake: () => gate,
    state: () => ({ busy: false, pending: 1, ownPlan: 0, sinceHumanMs: 9e9 }),
  });
  b.start();
  const p = b.step();
  const again = b.step();
  eq(again.why, 'busy', 'C3 上一拍没跑完，这一拍不叠上去（一拍只有一次模型调用）');
  release();
  await p;
  await new Promise(r => setTimeout(r, 0));
  eq(b.step().why, 'world', 'C4 跑完就能再拍');
}

{
  let t = 0;
  let once = true;
  const b = createClock({ kind: 'beat',
    now: () => t,
    wake: () => { if (once) { once = false; throw new Error('模型挂了'); } return Promise.resolve(); },
    state: () => ({ busy: false, pending: 1, ownPlan: 0, sinceHumanMs: 9e9 }),
  });
  b.start();
  const r = b.step();
  eq(r.why, 'failed', 'C5 一拍炸了不往外抛');
  eq(b.stats().failed, 1, 'C6 记了一次失败');
  /* 关键：不立刻补发。补发就是"到点必须说话"，那是定时叫醒。 */
  eq(b.step().why, 'world', 'C7 下一拍照常，但不补发上一次');
}

{
  const b = createClock({ kind: 'beat', now: () => 0, wake: () => Promise.resolve(), state: () => ({ busy: true }) });
  b.start();
  eq(b.step().why, 'busy', 'C8 模型正忙 → 直接跳过，不排队');
  b.stop();
  eq(b.step().why, 'stopped', 'C9 stop 之后真的停');
}

console.log('\nD. 没有事的时候不花钱');

{
  const b = createClock({ kind: 'beat', now: () => 0, wake: () => { throw new Error('这就不该被调用'); }, state: () => ({ busy: false, pending: 0, ownPlan: 0, sinceHumanMs: 9e9 }) });
  b.start();
  for (let i = 0; i < 5; i++) b.step();
  eq(b.stats().skipped, 5, 'D1 连抽五拍一次模型都没叫');
  eq(b.stats().beat, 0, 'D2 也没偷偷给空时刻');
}

console.log('\nE. 出处：源码里不该再有那套衰减曲线');

{
  const page = read('预览-66.html');
  ok(!/createDrives|DRV\.satisfy|__STEP_DRIVES|__DRIVES/.test(page), 'E1 66 里没有 drive 的任何残留');
  ok(!existsSync(join(ROOT, 'js/brain/drives.mjs')), 'E2 运行路径里没有 drives.mjs（那份已作废，在 _未接/）');
  ok(!existsSync(join(ROOT, 'js/brain/beat.mjs')), 'E2b 也没有 beat.mjs（并进 clock.mjs 了，不留两份）');

  const rules = JSON.parse(read('rules/room.json'));
  const driveRules = rules.rules.filter(r => String(r.id || '').startsWith('drive_'));
  eq(driveRules, [], 'E3 规则表里没有 drive_*（"你有点渴了"这类事件不存在了）');

  /* 页面自己不许再开定时器：所有节奏集中在 beat.mjs 一处，才查得清。 */
  eq((page.match(/setInterval\s*\(/g) || []).length, 0, 'E4 66 里一个 setInterval 都没有（节奏不散在页面里）');
  ok(/startClock\(clockPort\)/.test(page), 'E5 页面只挂一次 startClock');
  ok(/\?clock=/.test(page), 'E5b 页面能用 URL 换钟（换钟不用改代码）');
  /* 全项目第二个定时器是心跳（heartbeat.mjs）。它是个例外，所以单独验它"只做一件事"：
   * 只 POST /api/alive，不叫醒谁、不读记忆、不碰世界。它要是开始"顺手做点什么"，
   * 那就变回了一个页面级的节奏，这条规矩就白定了。 */
  const clockSrc = read('js/brain/clock.mjs');
  eq((clockSrc.match(/setInterval\s*\(/g) || []).length, 1, 'E5c 钟那个定时器在 clock.mjs 里（就一个）');
  const beatSrc = read('js/brain/heartbeat.mjs');
  ok(/api\/alive/.test(beatSrc), 'E5d 心跳只上报 /api/alive');
  ok(!/wake\(|loop\.|memory\.|registry\./.test(beatSrc), 'E5e 心跳不叫醒谁、不读记忆、不碰世界（它没有主张）');
  eq((page.match(/setInterval\s*\(/g) || []).length, 0, 'E5f 66 自己一个定时器都没有（心跳也是引模块）');

  /* 钟的**代码**里不许出现"具体感觉"的词。出现了，就是我们的主张混进来了。
   * 注释里讲历史可以（那段历史必须留着，不然下一个人会把 drives 接回来）。 */
  const stripComments = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const clockCode = stripComments(read('js/brain/clock.mjs'));
  const forbidden = ['渴', '饿', '累', '闷', '孤独', '想说话', '难受', '欲望'];
  const hits = forbidden.filter(w => clockCode.includes(w));
  eq(hits, [], 'E6 钟的代码里一个感觉词都没有（注释里讲历史可以，代码里不行）');

  const promptSrc = read('js/brain/prompt.mjs');
  const i = promptSrc.indexOf('if (item?.beat)');
  ok(i > 0, 'E7 提示词里给空时刻单独留了一段');
  const block = promptSrc.slice(i, promptSrc.indexOf("'## 这次没人跟你说话'", i));
  ok(!/你(有点|应该|该)/.test(block), 'E8 那一段不替她下判断（没有"你有点…""你该…"）');
  ok(/do":\[\].*say":""/.test(block), 'E9 明说了"不想做也可以回空"');
  ok(!/candidates/.test(block), 'E10 空时刻不给候选清单（给了就是我们在指使她）');
}

console.log('\nF. 真跑一次空时刻（不连网）');

{
  const m = new Map([['identity.md', '你叫小鱼。\n一句一行。']]);
  const store = {
    read: n => m.get(n) ?? '',
    write: (n, t) => { m.set(n, t); },
    append: (n, t) => { m.set(n, (m.get(n) || '') + t); },
  };
  const memory = createMemory({ store, charId: 'fish' });
  memory.load();
  const R = createRegistry();
  R.registerAll([{ name: 'look_at', description: '看某样东西', intent: '看一眼', schema: { target: { type: 'entity', kinds: ['window'] } }, run: async () => ({ ok: true, effect: '看了一眼' }) }]);
  const seen = [];
  const chat = async ({ system }) => { seen.push(system); return { content: '{"say":"","do":[],"plan":["把窗台上的杯子收掉"]}', usage: { total_tokens: 50 } }; };
  const loop = createLoop({ memory, registry: R, chat });

  const r = await loop.wake({ world: {}, beat: true });
  ok(r.ok, 'F1 空时刻能跑通（没有议程也不早退）');
  eq(r.beat, true, 'F2 回执标明这是空时刻，不是某件事');
  const sys = seen[0];
  ok(sys.includes('没有任何事在等你'), 'F3 提示词说的是"手上没事"，不是"你难受了"');
  ok(!/你(有点|应该|该)(渴|累|闷|孤独)/.test(sys), 'F4 提示词里没有一条是替她写的欲望');
  ok(/不想做，就回/.test(sys), 'F5 允许什么都不做');
  eq(r.acted, false, 'F6 她选了什么都不做 → acted:false（这是合法的沉默）');
  eq(Object.keys(r).filter(k => /drive|need|urge|mood/i.test(k)), [], 'F7 回执里没有"动力/需求"这类字段（钟不产生感受）');
  eq(memory.openAgenda().map(a => a.text), ['把窗台上的杯子收掉'], 'F8 计划真落进了她自己的账本（下一次是从这里来，不是从曲线来）');

  /* 没有 beat 的旧行为必须原样：没人说话、没事，就别动。
   * 用一份干净的账本——上一段她刚给自己写了一条计划，那一份有活干是对的。 */
  const m2 = new Map([['identity.md', '你叫小鱼。']]);
  const store2 = {
    read: n => m2.get(n) ?? '',
    write: (n, t) => { m2.set(n, t); },
    append: (n, t) => { m2.set(n, (m2.get(n) || '') + t); },
  };
  const mem2 = createMemory({ store: store2, charId: 'fish' });
  mem2.load();
  let called = 0;
  const loop2 = createLoop({ memory: mem2, registry: R, chat: async () => { called++; return { content: '{"say":"","do":[]}' }; } });
  const r2 = await loop2.wake({ world: {} });
  eq(r2.reason, 'nothing_pending', 'F9 不是空时刻的时候，没议程就一个字节都不发');
  eq(called, 0, 'F10 而且模型一次都没被叫（省钱是顺带的，主要是别替她找事）');
}

console.log('\nG. 这个接口真的能换');

{
  eq(listClocks().sort(), ['beat', 'manual', 'quiet'], 'G1 内置三个钟（少了就是别人没法选）');
  const desc = describeClocks();
  ok(desc.every(d => d.text && d.text.length > 4), 'G2 每个钟都有一句人话，换的人知道自己换的是什么');

  /* quiet：永不主动 */
  {
    const b = createClock({ kind: 'quiet', now: () => 0, wake: () => { throw new Error('不该被叫'); }, state: () => ({ busy: false, pending: 0, ownPlan: 0, sinceHumanMs: 9e9 }) });
    b.start();
    for (let i = 0; i < 5; i++) b.step();
    eq(b.stats().beat, 0, 'G3 quiet 钟永远不会自己醒（想省钱/想先看别的用这个）');
  }

  /* manual：只在外面叫的时候动 */
  {
    let t = 0; const calls = [];
    const b = createClock({ kind: 'manual', now: () => t, wake: o => { calls.push(o); return Promise.resolve(); }, state: () => ({ busy: false, pending: 0, ownPlan: 0, sinceHumanMs: 9e9 }) });
    b.start();
    t += 3600e3;
    eq(b.step().why, 'not_yet', 'G4 manual 钟过一小时也不自己醒');
    eq(b.poke().why, 'beat', 'G5 外面叫一次才动（脚本/按键/别的程序）');
    eq(calls.length, 1, 'G6 而且只动一次，不会连着来');
  }

  /* 别人注册一个自己的钟 */
  {
    registerClock({
      id: 'test-cron', zh: '测试用的整点', caps: ['timing'],
      describe: () => '每整十分钟一次。',
      decide: ctx => ctx.sinceIdleMs >= 600e3,
    });
    ok(listClocks().includes('test-cron'), 'G7 registerClock 能把别人的钟挂上来');
    let t = 0; const calls = [];
    const b = createClock({ kind: 'test-cron', now: () => t, wake: o => { calls.push(o); return Promise.resolve(); }, state: () => ({ busy: false, pending: 0, ownPlan: 0, sinceHumanMs: 9e9 }) });
    b.start();
    t += 601e3;
    eq(b.step().why, 'beat', 'G8 挂上来的钟真能决定节奏');
  }

  /* 换钟换不掉底线：有事优先 / 不打断对话 */
  {
    registerClock({ id: 'test-greedy', zh: '永远想醒', decide: () => true });
    const b = createClock({ kind: 'test-greedy', now: () => 0, wake: () => Promise.resolve(), state: () => ({ busy: false, pending: 0, ownPlan: 0, sinceHumanMs: 5e3 }) });
    b.start();
    eq(b.step().why, 'talking', 'G9 再贪的钟也打断不了正在进行的对话（底线是框架的，不是钟的）');

    const b2 = createClock({ kind: 'test-greedy', now: () => 0, wake: () => Promise.resolve(), state: () => ({ busy: false, pending: 2, ownPlan: 0, sinceHumanMs: 9e9 }) });
    b2.start();
    eq(b2.step().why, 'world', 'G10 有事实待处理时，钟说了不算');
  }

  /* 别人写的钟炸了，不能把她整条命拖下水 */
  {
    registerClock({ id: 'test-broken', zh: '会炸的钟', decide: () => { throw new Error('我的钟写错了'); } });
    const b = createClock({ kind: 'test-broken', now: () => 0, wake: () => { throw new Error('不该被叫'); }, state: () => ({ busy: false, pending: 0, ownPlan: 0, sinceHumanMs: 9e9 }) });
    b.start();
    const r = b.step();
    eq(r.why, 'failed', 'G11 坏钟只让这一拍不动，不往外抛');
    eq(b.stats().failed, 1, 'G12 并且留下痕迹（查得出是谁的钟坏了）');
    ok('beat' in BUILTIN_CLOCKS && Object.keys(BUILTIN_CLOCKS).length === 3, 'G13 内置表没被测试污染（注册只加不改）');
  }

  /* 写错名字要当场报错，不要静默降级 */
  {
    let msg = null;
    try { createClock({ kind: '没这个钟', wake: () => {}, state: () => ({}) }); }
    catch (e) { msg = e.message; }
    ok(msg && msg.includes('没有这个钟'), 'G14 写错钟名当场报错，并列出有哪些');
    let msg2 = null;
    try { registerClock({ id: 'x' }); } catch (e) { msg2 = e.message; }
    ok(msg2 && msg2.includes('decide'), 'G15 注册一个没有 decide 的钟要当场报错');
  }
}

console.log(`\n${fail === 0 ? '全过' : '有失败'}：${pass} 过，${fail} 不过\n`);
process.exit(fail ? 1 : 0);
