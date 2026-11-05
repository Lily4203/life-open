/* 表现层（P5）：手势、情绪落款、待机、镜头
 * ------------------------------------------------------------
 * 这一组守的是"做不好比不做更糟"那条线。分四段：
 *
 *   A  手势的词本身（gestures.mjs）：进场出场归零、不碰头、不超幅度、名字对得上
 *   B  端口（avatar.mjs）：没有这个能力的身体要明确说不会，不许假装演过
 *   C  情绪落款（prompt + loop）：只是"脸色"，不是第四个动作通道
 *   D  源码契约（读文件）：手势表只此一份、头归视线、推镜不超过 5%
 *   E  拆出来的模块（perf.mjs）：给一副假骨头就能验"坐着不演、演完归零"。
 *      这一组是 P11 拆文件的直接收益——以前这些只能打开页面看。
 *
 * 为什么 A 要在 node 里验而不是"打开页面看一眼"：
 *   骨骼名打错一个字母不会报错，只会少动一只胳膊；幅度写过头手臂会翻到背后。
 *   这两种错**人眼很难当场发现**，但在采样表里一眼就看出来。
 *
 * 跑：node tools/brain-test/perform-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAvatar, CAPS, GESTURES as PORT_GESTURES, EMOTION_TO_GESTURE, CALLABLE } from '../../js/brain/avatar.mjs';
import { GESTURES, GEST_BONES, GEST_LIMIT, NEAREST, sample } from '../../js/brain/gestures.mjs';
import { createLoop } from '../../js/brain/loop.mjs';
import { createMemory } from '../../js/brain/memory.mjs';
import { createRegistry } from '../../js/brain/actions.mjs';
import { parseOut, MOODS } from '../../js/brain/prompt.mjs';
import { createPerf } from '../../js/room/perf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIFE = path.resolve(HERE, '../..');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

const KINDS = Object.keys(GESTURES);
const ZERO = v => (v[0] === 0 && v[1] === 0 && v[2] === 0);

/* ================= A. 手势的词 ================= */
console.log('\nA. 手势的词（演法本身）');

{
  ok(KINDS.length >= 8, 'A1 至少八个手势（少了不够用，会一直重复）', String(KINDS.length));
  ok(KINDS.every(k => typeof GESTURES[k].at === 'function'), 'A2 每个手势都是 (u)→偏移 的函数');

  const badDur = KINDS.filter(k => !(GESTURES[k].dur >= 0.5 && GESTURES[k].dur <= 3));
  eq(badDur, [], 'A3 时长都在 0.5–3 秒之间（更短像抽搐，更长像慢动作）');

  /* 进场出场归零：不归零的话，每演一次都会在骨头上"存"一点残角，十次之后就歪了 */
  const notZero = [];
  for (const k of KINDS) {
    for (const u of [0, 1]) {
      const off = sample(k, u) || {};
      for (const b in off) if (!ZERO(off[b])) notZero.push(`${k}@${u}:${b}`);
    }
  }
  eq(notZero, [], 'A4 u=0 和 u=1 时所有骨骼都归零（否则越演越歪）');

  /* 演到一半必须有动静，否则等于"声明了但什么都没演"。
   * 注意不能只看 u=0.5：点头和换重心是**往复**动作，正好在半程回到零位
   * （sin(2π)=0）——那不是没动，是动回来了。所以扫一遍再判。 */
  const still = KINDS.filter(k => {
    for (let i = 1; i < 20; i++) {
      const off = sample(k, i / 20) || {};
      if (Object.keys(off).some(b => !ZERO(off[b]))) return false;
    }
    return true;
  });
  eq(still, [], 'A5 每个手势整个过程里真的动过（不是空函数）');

  /* 只动白名单：这是"少动一只胳膊"那类错唯一能被机器抓住的地方 */
  const illegal = [];
  for (const k of KINDS) {
    for (let i = 0; i <= 20; i++) {
      const raw = GESTURES[k].at(i / 20) || {};
      for (const b in raw) if (!GEST_BONES.includes(b)) illegal.push(`${k}:${b}`);
    }
  }
  eq([...new Set(illegal)], [], 'A6 原始表里也没有白名单之外的骨头（写错名字不会报错，只会少动）');

  /* 头归视线：页面每帧把 head 往鼠标上拽，手势再叠就是互相拉锯（看起来像发抖） */
  const touchesHead = KINDS.filter(k => {
    for (let i = 0; i <= 10; i++) {
      const off = GESTURES[k].at(i / 10) || {};
      if ('head' in off || 'eyes' in off) return true;
    }
    return false;
  });
  eq(touchesHead, [], 'A7 谁都不许碰 head / eyes（头归视线，两处同时写会发抖）');

  /* 限幅：所有采样点的每个轴都不能超过 GEST_LIMIT，也不能是 NaN */
  let worst = 0, nan = [];
  for (const k of KINDS) {
    for (let i = 0; i <= 40; i++) {
      const off = sample(k, i / 40) || {};
      for (const b in off) for (const v of off[b]) {
        if (Number.isNaN(v)) nan.push(`${k}:${b}`);
        worst = Math.max(worst, Math.abs(v));
      }
    }
  }
  eq(nan, [], 'A8 采样不产生 NaN');
  ok(worst <= GEST_LIMIT + 1e-9, 'A9 幅度都在人的关节范围内', String(worst));

  eq(sample('没有这个手势', 0.5), null, 'A10 不认识的手势返回 null（调用方据此报错，不猜同义词）');
  eq(sample('nod', 5), sample('nod', 1), 'A11 u 超范围会被夹住（不会因为掉帧演到第二遍）');

  /* 两张表必须对得上：avatar.mjs 说"有这个词"，gestures.mjs 说"怎么演"。
   * 对不上时，实际表现是"她答应要挥手，人没动"——最坏的一种错。 */
  eq(KINDS.slice().sort(), PORT_GESTURES.slice().sort(), 'A12 端口词表和演法表完全一致');

  const badNearest = Object.entries(NEAREST)
    .filter(([k, v]) => !KINDS.includes(k) || !KINDS.includes(v) || k === v)
    .map(([k, v]) => `${k}→${v}`);
  eq(badNearest, [], 'A13 "换一个"的映射只指向真实存在的、并且是另一个手势');

  const badEmo = Object.entries(EMOTION_TO_GESTURE)
    .filter(([e, g]) => !MOODS.includes(e) || !KINDS.includes(g)).map(([e, g]) => `${e}→${g}`);
  eq(badEmo, [], 'A14 情绪→手势的搭配只用五种表情和已存在的手势');
}

/* ================= B. 端口 ================= */
console.log('\nB. 端口：不会就说不会');

function body(caps, opts = {}) {
  const log = [];
  const impl = { caps, say: t => log.push('say:' + t) };
  if (caps.includes('emotion')) impl.emotion = e => log.push('em:' + e);
  if (caps.includes('gesture')) impl.gesture = k => { log.push('gest:' + k); return { ok: true }; };
  return { impl, log, av: opts.noRegister ? null : null };
}

{
  ok(CAPS.includes('gesture'), 'B1 能力表里有 gesture');
  ok(CALLABLE.includes('gesture'), 'B2 声明了 gesture 就必须给实现（不许"声明了其实没有"）');

  const { impl, log } = body(['say', 'gesture']);
  const av = createAvatar();
  av.register('会演的', impl);
  const r = av.gesture('wave');
  eq(r.ok, true, 'B3 会演的身体，调用能到实现');
  eq(log, ['gest:wave'], 'B4 传下去的就是这个词本身');
  eq(av.stats().calls.gesture, 1, 'B5 调用有计数');

  const r2 = av.gesture('倒立');
  eq(r2.ok, false, 'B6 不认识的手势回失败');
  eq(r2.reason, 'unknown_gesture', 'B7 理由是"没这个词"，不是"身体不会"（两种要分开）');
  eq(log, ['gest:wave'], 'B8 没传下去的不会出现在后端日志里（不猜、不替换）');

  const av2 = createAvatar();
  av2.register('只会说话', { caps: ['say'], say() {} });
  const r3 = av2.gesture('nod');
  eq(r3.ok, false, 'B9 没有这个能力的身体回失败');
  eq(r3.reason, 'unsupported', 'B10 理由要能区分"身体不会"和"没这个词"');
  ok(/手势/.test(r3.message), 'B11 回执是人话（"这个身体不会做手势"）', r3.message);
  eq(r3.degraded, false, 'B12 手势不降级成表情（那会变成"一整晚都在换表情"）');

  const av3 = createAvatar();
  eq(av3.gesture('nod').reason, 'no_backend', 'B13 一具身体都没有时也说得出原因');
}

/* ================= C. 情绪落款 ================= */
console.log('\nC. 情绪落款：是脸色，不是动作');

{
  const p = parseOut('{"say":"太好了。","mood":"happy","do":[]}', {});
  eq(p.mood, 'happy', 'C1 合法的 mood 留下来');
  eq(p.mood && p.do.length, 0, 'C2 mood 不进 do（它不是她做的事）');

  const q = parseOut('{"say":"嗯。","mood":"心花怒放","do":[]}', {});
  eq(q.mood, null, 'C3 词表外的 mood 当没写');
  eq(q.parseError, null, 'C4 但不许因此判成坏格式（为了演得像而说得不像，不值）');
  eq(q.say, '嗯。', 'C5 话照常留下');

  const r = parseOut('{"say":"嗯。","do":[]}', {});
  eq(r.mood, null, 'C6 不写 mood 就是不改表情（默认不改，不是默认开心）');

  const s = parseOut('{"say":"嗯。","emotion":"sad","do":[]}', {});
  eq(s.mood, 'sad', 'C7 模型写成 emotion 也认（同一个意思，不为一个字段名重发）');
  eq(parseOut('这不是 json').mood, null, 'C8 整段解析失败时 mood 也是 null，不给默认值');
}

{
  /* loop 里：同一个 mood 连着两轮只演一次；换了才再演 */
  const store = new Map();
  const mem = createMemory({
    store: { read: n => store.get(n) ?? '', write: (n, t) => store.set(n, t), append: (n, t) => store.set(n, (store.get(n) || '') + t) },
    charId: 'fish',
  });
  const emotions = [];
  const avatar = { say() {}, setEmotion: e => { emotions.push(e); return { ok: true }; } };
  const replies = [
    '{"say":"高兴。","mood":"happy","do":[]}',
    '{"say":"还是高兴。","mood":"happy","do":[]}',
    '{"say":"有点难过。","mood":"sad","do":[]}',
    '{"say":"没事。","do":[]}',
  ];
  let i = 0;
  const loop = createLoop({ memory: mem, registry: createRegistry(), avatar, chat: async () => ({ content: replies[i++] }) });

  const r1 = await loop.turn({ text: '一' });
  eq(emotions, ['happy'], 'C9 第一次说了 mood 就演一次');
  eq(r1.mood, 'happy', 'C10 mood 跟着这一轮返回（页面/状态栏能看见）');
  eq(loop.stats().actions, 0, 'C11 mood 不算一步动作');

  await loop.turn({ text: '二' });
  eq(emotions, ['happy'], 'C12 同一个 mood 连着来不再演（否则表情每秒重设一次，会闪）');

  await loop.turn({ text: '三' });
  eq(emotions, ['happy', 'sad'], 'C13 换了 mood 才再演');

  await loop.turn({ text: '四' });
  eq(emotions, ['happy', 'sad'], 'C14 没写 mood 就什么都不动（表情保持原样）');
  eq(loop.stats().moods, 2, 'C15 演了几次单独记（和动作数分开）');
}

{
  /* 身体没有表情时：这一轮不能因此变成失败 */
  const store = new Map();
  const mem = createMemory({
    store: { read: n => store.get(n) ?? '', write: (n, t) => store.set(n, t), append: (n, t) => store.set(n, (store.get(n) || '') + t) },
    charId: 'fish',
  });
  const loop = createLoop({ memory: mem, registry: createRegistry(), avatar: { say() {} },
    chat: async () => ({ content: '{"say":"好。","mood":"happy","do":[]}' }) });
  const r = await loop.turn({ text: '在吗' });
  eq(r.ok, true, 'C16 身体不会表情时，这一轮照样成立');
  eq(r.say, '好。', 'C17 话一个字不少');
}

/* ================= D. 源码契约 ================= */
console.log('\nD. 源码契约（防以后有人图省事改回去）');

{
  /* "页面"这份源码现在分在两地：66 剩下接线和界面，3D 那一整套搬到了
   * js/room/world.mjs（P11 拆文件）。契约断言验的是"这套实现还在不在"，
   * 不是"它在哪个文件里"——所以两份拼起来看。
   * 这样以后从 world.mjs 里再切出手势播放器，这里也不用跟着改。 */
  const page = fs.readFileSync(path.join(LIFE, '预览-66.html'), 'utf8')
    + '\n' + fs.readFileSync(path.join(LIFE, 'js/room/world.mjs'), 'utf8')
    + '\n' + fs.readFileSync(path.join(LIFE, 'js/room/perf.mjs'), 'utf8');
  const gest = fs.readFileSync(path.join(LIFE, 'js/brain/gestures.mjs'), 'utf8');
  const promptSrc = fs.readFileSync(path.join(LIFE, 'js/brain/prompt.mjs'), 'utf8');
  /* 只看"大脑"的文件。排除两个有正当理由知道骨骼名的：
   *   gestures.mjs —— 它是身体的语言，"怎么演"本来就写在这里
   *   wardrobe.mjs —— 衣服挂在哪根骨头上（袖子跟着 chest 走），换装层必须知道
   * 除了这两处，别的地方出现骨骼名就说明有人在隔层指挥身体。 */
  const brain = fs.readdirSync(path.join(LIFE, 'js/brain'))
    .filter(f => f.endsWith('.mjs') && !['gestures.mjs', 'wardrobe.mjs'].includes(f))
    .map(f => fs.readFileSync(path.join(LIFE, 'js/brain', f), 'utf8')).join('\n');

  /* 路径从 './js/brain/' 变成了 '../brain/'（模块下沉了一层），所以只锁
   * "从 gestures.mjs 拿"这件事，不锁具体的相对前缀。 */
  ok(/from '\.{1,2}\/[^']*brain\/gestures\.mjs'/.test(page), 'D1 用的是共享表，不是自己那份');
  ok(!/const GEST = \{/.test(page), 'D2 页面里没有第二份手势表（两份一定会走偏）');
  ok(/gestSample\(/.test(page), 'D3 取偏移必须走 sample()（夹 u / 白名单 / 限幅都在里面）');
  ok(!/'head'\s*:/.test(gest), 'D4 手势表里没有 head（头归视线）');
  ok(/GEST_BONES/.test(gest), 'D5 白名单在表里，不是散的');
  ok(/MOODS/.test(promptSrc) && MOODS.length === 5, 'D6 情绪词表就五个，和身体的表情数一致');
  /* 第一次写的是"可不填"，模型 8/8 全填了同一个值。所以要盯的不是"有没有说可选"，
   * 而是"有没有明说大多数时候别填"——这两句在模型那里完全不是一回事。 */
  ok(/大多数话是不写的/.test(promptSrc) && /不写不是没情绪/.test(promptSrc),
    'D7 提示词明说"大多数话不写"（只说"可不填"等于没说）');
  /* 大脑里不许出现骨骼名：出现一个就说明有人开始隔层指挥身体了。
   * 只排除 gestures.mjs —— 它是"身体的语言"，本来就该有骨骼名。 */
  const leaked = GEST_BONES.filter(b => brain.includes(`'${b}'`));
  eq(leaked, [], 'D8 大脑的文件里没有骨骼名（说了怎么做就等于替她演）');

  /* 推镜幅度：超过 5% 就不是"演出"而是"有人在拉变焦" */
  const m = /PERF\.speaking \? (0\.\d+) : 1/.exec(page);
  ok(!!m, 'D9 推镜系数是一个明确的数，不是随手写的');
  if (m) {
    const k = Number(m[1]);
    ok(k >= 0.92 && k <= 0.99, 'D10 推镜幅度在 1%–8% 之间', String(k));
  }

  ok(/state\.poseName === 'stand'/.test(page), 'D11 待机动作只在站着时演（坐/躺的骨架不一样，套上去会形变）');
  ok(/PERF\.last/.test(page), 'D12 同一条不连着演两次（人眼一秒就能看出循环）');
  /* 真跑踩过：后端调 window.__PERF.onSay，而 __PERF 上没导出它。
   * 异常被 try/catch 吞掉，表现是"一切正常，只是从来不带手势"——最贵的一种错。 */
  ok(/onSay:\s*perfOnSay/.test(page) && /onEmotion:\s*perfOnEmotion/.test(page),
    'D13 后端要调的两个回调真的挂在 __PERF 上（漏了会静默不生效）');
  ok(/perfNow\(\)/.test(page) && !/PERF\.g\.t \+= dt/.test(page),
    'D14 手势进度走墙钟，不走累计 dt（掉帧时不该演 30 秒）');
}


/* ================= E. 表现层能脱离页面跑 ================= */
console.log('\nE. 表现层能脱离页面跑（拆文件的收益）');

{
  /* 假骨头：只有 rotation，够 perfSpin 加减。真骨骼还多一堆东西，
   * 但这一层只碰 rotation——这也顺带证明了它真的只碰 rotation。 */
  const make = (pose = 'stand') => {
    const bones = new Map();
    const nbone = (name) => {
      if (!bones.has(name)) bones.set(name, { rotation: { x: 0, y: 0, z: 0 } });
      return bones.get(name);
    };
    const state = { poseName: pose, walking: false };
    const perf = createPerf({ nbone, state });
    return { perf, P: perf.PERF, nbone, state, bones };
  };

  {
    const { perf } = make();
    eq(perf.gesture('没有这个手势'), { ok: false, reason: 'unknown_gesture' },
      'E1 不认识的手势明确拒绝，不静默什么都不做');
  }

  {
    const { perf, P, nbone } = make();
    perf.gesture('wave');
    const arm = nbone('rightUpperArm');
    /* 不能空转 20 次 tick 就指望它动：进度算的是墙钟，一秒钟内跑一万次循环
     * 时间也只过了一毫秒（D14 那条教训的同一件事）。所以要手动把 t0 往回拨。 */
    for (let i = 0; i < 20; i++) { P.g.t0 -= 30; perf.tick(1 / 60); }
    const moved = Math.abs(arm.rotation.z) + Math.abs(arm.rotation.x) + Math.abs(arm.rotation.y);
    ok(moved > 0.05, 'E2 tick 真的推动了骨头', `偏移合计 ${moved.toFixed(3)}`);
    perf.clear();
    ok(arm.rotation.x === 0 && arm.rotation.y === 0 && arm.rotation.z === 0,
      'E3 clear() 把加过的偏移一分不剩地减回去');
  }

  {
    const { perf, P } = make();
    perf.gesture('nod');
    P.g.t0 = performance.now() - 5000;          // 假装已经演完了
    perf.tick(1 / 60);
    eq(P.g, null, 'E4 演完自己收手，不会一直挂着');
    ok(P.done.includes('nod'), 'E5 演过什么有记录（调试时要能查是哪一下）');
  }

  {
    const sit = make('sit');
    sit.perf.onEmotion('happy');
    eq(sit.P.g, null, 'E6 坐着时换表情不演站姿那套（套上去会形变）');
    const walk = make('stand');
    walk.state.walking = true;
    walk.perf.onEmotion('happy');
    eq(walk.P.g, null, 'E7 走路时也不演');
    const stand = make('stand');
    stand.perf.onEmotion('happy');
    ok(!!stand.P.g, 'E8 站着、没走的时候才演');
  }

  {
    const { perf, P } = make();
    perf.gesture('nod');
    perf.gesture('nod');          // 第二次：忙就等着
    perf.gesture('nod');          // 第三次：上一个演完 70% 才让位；这里直接 force
    const first = P.last;
    perf.clear(); P.g = null;
    perf.gesture('nod');
    ok(P.last !== first || first === null, 'E9 连着两次同一个会换成最接近的另一种');
  }

  {
    const { perf, P } = make();
    perf.onSay(); perf.onSay();
    for (let i = 0; i < 40; i++) perf.tick(0.05);
    ok(P.camK < 0.999 && P.camK >= 0.96, 'E10 说话时镜头慢慢推近，且不超过 4%',
      `camK=${P.camK.toFixed(3)}`);
    P.speakUntil = 0;
    for (let i = 0; i < 120; i++) perf.tick(0.05);
    ok(P.camK > 0.999, 'E11 说完了自己退回来（不靠页面记得关）', `camK=${P.camK.toFixed(3)}`);
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
