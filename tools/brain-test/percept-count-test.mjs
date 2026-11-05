/* 同一件事第几次了：次数要真的到她手上
 * ------------------------------------------------------------
 * 真跑抓到的病：灯一开一关她说一句，说的大半还是同一句
 *   （13:37:15「顶灯怎么灭了」13:37:30「顶灯怎么开着」13:38:39「灯还没关吗」）。
 *
 * 病因不在"她不会说别的话"，在**第四次和第一次在她眼里一模一样**：
 * 发起层明明记着 occurrences，派发时却没递出去；提示词里只有一句
 * "顶灯刚被关掉"，她只能把上次那句再说一遍。
 *
 * 这一组钉住三件事：
 *   A 派发要把次数和时间带出来（不是只留在队列里）
 *   B 次数要进提示词，第一次不许写成"第 1 次"（那是噪音，每件事都带一个 1）
 *   C 只报事实，不带判决（不许出现"别再提了""你已经说过"这类话）
 *
 * 跑：node tools/brain-test/percept-count-test.mjs
 */
import { createInitiative } from '../../js/brain/initiative.mjs';
import { createRegistry } from '../../js/brain/actions.mjs';
import { createPerception } from '../../js/brain/perception.mjs';
import { buildWakeSystem } from '../../js/brain/prompt.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(a === b, name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

function room() {
  const R = createRegistry();
  R.register({
    name: 'toggle', description: '开关某样东西',
    schema: { target: { type: 'entity', kinds: ['light'], required: true } },
    run: async () => ({ ok: true, say: '好了' }),
  });
  return R;
}

const boot = { blocks: [] };

/* ---- A. 派发要把"第几次"带出来 ---- */
console.log('\nA. 次数要跟着派发一起出来');
{
  let clock = 1000;
  const I = createInitiative({ now: () => clock });
  I.raise({ reason: 'signal', target: 'light:顶灯', detail: '顶灯刚被关掉' });
  const a = I.dispatch({ userPresent: false });
  eq(a.occurrences, 1, 'A1 第一次派发：次数是 1');
  eq(a.firstAt, 1000, 'A2 第一次就带"最早什么时候"（不然下次算不出来）');
  I.resolve(a.id, { outcome: 'ignored' });

  /* 同 target 再报三次：合并成一条，次数累加，最早那次不被覆盖 */
  for (const t of [2000, 3000, 4000]) { clock = t; I.raise({ reason: 'signal', target: 'light:顶灯', detail: '顶灯刚被关掉' }); }
  const b = I.dispatch({ userPresent: false });
  eq(b.occurrences, 4, 'A3 第四次派发：次数是 4（合并计数没丢）');
  eq(b.firstAt, 1000, 'A4 最早那次的时间没被覆盖');
  eq(b.lastAt, 4000, 'A5 上一次是最近那次');
}

/* ---- B. 次数进提示词；第一次一个字都不加 ---- */
console.log('\nB. 次数进提示词');
{
  const R = room();
  const sys1 = buildWakeSystem({
    boot, registry: R,
    item: { id: 'p1', reason: 'signal', target: 'light:顶灯', detail: '顶灯刚被关掉', occurrences: 1, firstAt: Date.now(), lastAt: Date.now() },
  });
  ok(sys1.includes('顶灯刚被关掉'), 'B1 事实本身在');
  ok(!sys1.includes('第 1 次'), 'B2 第一次不写"第 1 次"（每件事都带个 1 就是噪音）');
  ok(!sys1.includes('第 0 次'), 'B3 不会写出"第 0 次"这种数');

  const sys4 = buildWakeSystem({
    boot, registry: R,
    item: { id: 'p1', reason: 'repeat', target: 'light:顶灯', detail: '顶灯刚被关掉', occurrences: 4,
      firstAt: Date.now() - 130000, lastAt: Date.now() - 8000 },
  });
  ok(sys4.includes('第 4 次'), 'B4 第四次要说清楚是第四次');
  ok(/头一次在.{1,8}分钟前/.test(sys4), 'B5 头一次说成人话（分钟）', sys4.match(/头一次在[^，]*/)?.[0]);
  ok(/上一次在.{1,6}秒前/.test(sys4), 'B6 上一次说成人话（秒）', sys4.match(/上一次在[^。]*/)?.[0]);

  /* 刚发生的写"刚才"，不写"0 秒前" */
  const sysNow = buildWakeSystem({
    boot, registry: R,
    item: { reason: 'repeat', target: 'light:顶灯', detail: '顶灯刚被关掉', occurrences: 2,
      firstAt: Date.now(), lastAt: Date.now() },
  });
  ok(sysNow.includes('刚才'), 'B7 刚发生的说"刚才"');
  ok(!sysNow.includes('0 秒前'), 'B8 不出现"0 秒前"');
}

/* ---- C. 只报事实，不下判决 ---- */
console.log('\nC. 只报事实，不下判决');
{
  const R = room();
  const sys = buildWakeSystem({
    boot, registry: R,
    item: { reason: 'repeat', target: 'light:顶灯', detail: '顶灯刚被关掉', occurrences: 5,
      firstAt: Date.now() - 600000, lastAt: Date.now() - 5000 },
  });
  for (const bad of ['别再提', '不要重复', '你已经说过', '重复太多', '换个话题']) {
    ok(!sys.includes(bad), `C1 不出现判决词「${bad}」`);
  }
  ok(sys.includes('要不要为它做点什么'), 'C2 最后仍然是问她自己要不要动');
}

/* ---- D. 次数不改变"可以不做" ---- */
console.log('\nD. 提第四次也一样可以不接');
{
  const R = room();
  const sys = buildWakeSystem({
    boot, registry: R,
    item: { reason: 'repeat', target: 'light:顶灯', detail: '顶灯刚被关掉', occurrences: 9,
      firstAt: Date.now() - 9e5, lastAt: Date.now() - 2000 },
  });
  ok(sys.includes('"do":[]'), 'D1 仍然明说可以什么都不做');
  ok(!/必须|一定要/.test(sys.split('## 这次没人跟你说话')[1] || ''), 'D2 没有把"必须"写进这一段的尾巴');
}

/* ---- E. 计数要活过"她走过去看了一眼" ---- */
console.log('\nE. 她每次都动了手，次数也不许从头数');
{
  /* 真跑里的病就是这么来的：灯一变 → 她 go_to 看一眼 → 这条记录被结案删掉 →
   * 下次灯再变，又是一条新记录、又从"第 1 次"开始。她于是把同一盏灯说了七八遍。
   * 计数放在感知层（按 target 记窗口），才活得比记录久。 */
  let clock = 1_000_000;
  const raised = [];
  const P = createPerception({
    now: () => clock,
    raise: p => { raised.push(p); return { id: 'x' }; },
    rules: [{
      id: 'light_off', when: { change: 'light', to: false, by: 'him' },
      emit: { reason: 'signal', target: 'light:{{label}}', detail: '{{label}}刚被关掉了。', candidates: ['toggle'] },
    }],
  });

  /* by:'him' —— 规则里写的就是"by him"。不传 by 默认 unknown，一条都命中不了，
   * 那不是代码坏了，是测试没照真页面的调用方式打。 */
  P.observe({ pose: 'stand', lights: { 顶灯: true } }, { by: 'him' });   // 立基线
  for (let i = 1; i <= 4; i++) {
    clock += 20_000;                                            // 每 20 秒拨一下
    P.observe({ pose: 'stand', lights: { 顶灯: i % 2 === 1 ? false : true } }, { by: 'him' });
  }
  const offs = raised.filter(x => x.detail === '顶灯刚被关掉了。');
  eq(offs.length, 2, 'E1 四次切换里关了两次');
  eq(offs[1].occurrences, 2, 'E2 第二次关灯：次数是 2');

  /* 再来一轮：中间"她动过手、结过案"（对感知层来说什么都没发生），次数照样接着数 */
  clock += 30_000; P.observe({ pose: 'stand', lights: { 顶灯: true } }, { by: 'him' });
  clock += 30_000; P.observe({ pose: 'stand', lights: { 顶灯: false } }, { by: 'him' });
  const last = raised[raised.length - 1];
  eq(last.occurrences, 3, 'E3 结案之后还是接着数（不是又从 1 开始）');
  ok(last.firstAt < last.lastAt, 'E4 最早那次留着，能算"头一次在多久前"');

  /* 窗口过了就归零：十分钟前那几下，已经不是"刚才"了 */
  clock += 11 * 60 * 1000;
  P.observe({ pose: 'stand', lights: { 顶灯: true } }, { by: 'him' });
  clock += 5_000; P.observe({ pose: 'stand', lights: { 顶灯: false } }, { by: 'him' });
  eq(raised[raised.length - 1].occurrences, 1, 'E5 过了窗口重新算第一次（不会变成"今天第 80 次"）');
}

console.log(`\n${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
