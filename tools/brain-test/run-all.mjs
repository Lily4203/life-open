// 一次跑完全部断言。
//
// 为什么要有这个文件：十六组测试散在十六个文件里，靠手打文件名去跑，
// 早晚会漏一组。漏掉的那组就是"以为过了其实没跑"——这正是维护能力流失的方式。
//
// 它只做三件事：按固定顺序跑、从输出里读通过数、把总数加起来。
// 它不重试、不吞失败、不解释失败原因——失败就原样把子进程的输出端上来。
//
// 用法：
//   node run-all.mjs          跑全部
//   node run-all.mjs hear     只跑名字里带 hear 的
//
// 退出码：全过 0；任何一个文件非 0 或者"不过"不为 0，退出码 1。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 顺序有意义：从最底层往最上面排。
// 底下挂了，上面的失败往往是假象——先看第一个红。
const FILES = [
  ['test.mjs',              '基础工具'],
  ['memory-test.mjs',       '记忆'],
  ['loop-test.mjs',         '一轮'],
  ['perception-test.mjs',   '感知'],
  ['window-test.mjs',       '动作窗口'],
  ['avatar-test.mjs',       '身体'],
  ['executor-test.mjs',     '执行层'],
  ['wardrobe-test.mjs',     '衣柜'],
  ['game-test.mjs',         '游戏'],
  ['senses-test.mjs',       '感官'],
  ['vision-test.mjs',       '看图'],
  ['eyes-test.mjs',         '看一眼'],
  ['clock-test.mjs',        '时钟端口'],
  ['voice-test.mjs',        '声音'],
  ['tts-test.mjs',          '合成'],
  ['stream-test.mjs',       '流式'],
  ['jsonout-test.mjs',      '结构化输出'],
  ['stop-test.mjs',         '动作中止'],
  ['perform-test.mjs',      '表现层'],
  ['hear-test.mjs',         '听见与打断'],
  ['chat-in-test.mjs',      '外部消息入口'],
  ['adapters-test.mjs',     '外线插槽'],
  ['anim-test.mjs',         '动作插槽'],
  ['asr-test.mjs',          '听见（ASR）'],
  ['update-test.mjs',       '更新检查'],
  ['model-test.mjs',        '模型导入'],
  ['heartbeat-test.mjs',    '心跳'],
  ['voice-profile-test.mjs', '声音像不像人'],
  ['style-test.mjs',        '说话的样子'],
  ['style-loop-test.mjs',   '换掉重复的那句'],
  ['quiet-test.mjs',        '可以不接'],
  ['percept-count-test.mjs', '同一件事第几次'],
];

// 两种收尾格式都要认：
//   "全部通过：23 条"        （多数文件）
//   "全过：64 过，0 不过"     （clock/voice/tts）
function readCount(out, re) {
  const m = out.match(re);
  return m ? Number(m[1]) : null;
}
function parse(out) {
  let pass =
    readCount(out, /全过：\s*(\d+)\s*过/) ??
    readCount(out, /全部通过[：:]\s*(\d+)/) ??
    readCount(out, /通过[ ]*(\d+)/) ??
    readCount(out, /(\d+)[ ]*通过/);
  let fail = readCount(out, /，\s*(\d+)\s*不过/) ?? 0;
  if (fail === 0) fail = readCount(out, /(?:失败|不过)[ ]*(\d+)/) ?? 0;
  return { pass, fail };
}

// 以 -- 开头的是开关，不是过滤器（否则 `run-all --no-page` 会去找叫 --no-page 的测试）。
const filter = process.argv.slice(2).find((a) => !a.startsWith('--')) || '';

// 按"词"匹配，不按子串：`hear` 不该把 `heartbeat` 也捞进来。
// 认三种：整名相等（loop）、前缀加横线（chat-in）、用横线切开后的某一段（in）。
const hit = (file) => {
  if (!filter) return true;
  const base = file.replace(/\.mjs$/, '').replace(/-test$/, '');
  return base === filter
    || base.startsWith(`${filter}-`)
    || base.split(/[-_]/).includes(filter);
};
const list = FILES.filter(([f]) => hit(f));

if (!list.length) {
  console.error(`没有名字对得上 "${filter}" 的测试。跑 node run-all.mjs 看全部。`);
  process.exit(2);
}

let total = 0;
let failTotal = 0;
let bad = [];

for (const [file, what] of list) {
  const t0 = Date.now();
  /* cwd 固定成仓库根：有的测试按 cwd 找 data/identity.md，
   * 而 README 教的是 `cd tools/brain-test && node run-all.mjs`——
   * 不固定的话，同一套断言换个目录敲就是一片红，红的还不是代码。 */
  const r = spawnSync(process.execPath, [path.join(HERE, file)], {
    encoding: 'utf8',
    timeout: 120e3,
    cwd: path.resolve(HERE, '../..'),
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ms = Date.now() - t0;
  const { pass, fail } = parse(out);

  // 读不出数字也是一种失败：宁可当场吵，也不许当它过了。
  // 光看数字不够——文件可能在打印汇总之后才炸，那时数字还是"全过"。
  // 所以退出码也算一票，而且这一票是否决票。
  const ok = r.status === 0 && fail === 0 && typeof pass === 'number';

  if (!ok) bad.push({ file, out });
  total += pass || 0;
  failTotal += fail || 0;

  const left = `${pass ?? '?'} 过`;
  const right = !ok
    ? (r.status !== 0 ? `退出码 ${r.status}` : '读不出数')
    : (fail ? `${fail} 不过` : '全过');
  console.log(
    `${ok ? '✓' : '✗'} ${file.padEnd(20)} ${String(left).padStart(7)}  ${right.padEnd(6)}  ${String(ms).padStart(5)}ms  ${what}`
  );
}

console.log('—'.repeat(64));

/* ---------------------------------------------------------------- 页面冒烟
 * 为什么在这里：1039 条断言全跑的是 loop.mjs 这些"被页面 import 的东西"，
 * 页面自己（顺序、作用域、DOM id、绑定时机）从来没被验过。上一版"填了表单
 * 没反应"就是这儿漏的。
 *
 * 但它是**可选组**，三个条件全满足才真跑：
 *   ① 机器上有 python（没有就明说跳过，不静默算绿）
 *   ② 8765 上有服务（页面靠它才有记忆和模型）
 *   ③ 不传 --no-page
 * 它慢（要起一次无头浏览器、加载 30MB 的 VRM），所以默认不跑"真发一句话"
 * 那两条——那两条要花钱、要等模型，留给 tools/smoke.py 手动跑。
 * 这里跑的是骨架 13 条：页面能开、十块齐、动作空间 12、输入四件齐、帧在推进。
 */
function hasPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    const r = spawnSync(cmd, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 8000 });
    if (r.status === 0) return cmd;
  }
  return null;
}

function serverUp() {
  const r = spawnSync(process.execPath, ['-e', `
    fetch('http://127.0.0.1:8765/api/health', { signal: AbortSignal.timeout(1500) })
      .then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
  `], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0;
}

let pageRan = false;
if (!process.argv.includes('--no-page')) {
  const py = hasPython();
  if (!py) {
    console.log('- 页面冒烟       跳过  （没找到 python）');
  } else if (!serverUp()) {
    console.log('- 页面冒烟       跳过  （8765 没起服务）');
  } else {
    const t0 = Date.now();
    const r = spawnSync(py, [path.join(HERE, '..', 'smoke.py'), '--no-turn', '--json'], {
      encoding: 'utf8', timeout: 180e3, cwd: path.join(HERE, '..', '..'),
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const line = out.trim().split('\n').filter(Boolean).pop() || '{}';
    let got = {};
    try { got = JSON.parse(line); } catch { /* 下面按失败处理 */ }
    const pass = Number.isInteger(got.pass) ? got.pass : 0;
    const fail = Number.isInteger(got.fail) ? got.fail : 1;
    const ok = r.status === 0 && fail === 0 && pass > 0;
    pageRan = true;
    if (!ok) bad.push({ file: 'smoke.py', out });
    total += pass;
    failTotal += fail;
    const ms = Date.now() - t0;
    console.log(
      `${ok ? '✓' : '✗'} ${'smoke.py'.padEnd(20)} ${String(`${pass} 过`).padStart(7)}  `
      + `${(fail ? `${fail} 不过` : '全过').padEnd(6)}  ${String(ms).padStart(5)}ms  页面冒烟（骨架）`
    );
    if (!ok) {
      console.log('  （完整版含真发一句话：python tools/smoke.py）');
    }
  }
}

console.log('—'.repeat(64));
console.log(`${list.length + (pageRan ? 1 : 0)} 组   ${total} 条断言   ${failTotal} 不过`
  + (pageRan ? '' : '   （页面冒烟没跑：见上面那行）'));

if (bad.length) {
  console.log('');
  for (const { file, out } of bad) {
    console.log(`==== ${file} 的输出 ====`);
    console.log(out.trimEnd());
    console.log('');
  }
  process.exit(1);
}
