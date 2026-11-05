/* 心跳：只证明"页面还活着"
 * ------------------------------------------------------------
 * 它是个例外，所以要验的是"克制"：
 *   一次启动就打一下、失败不重试不抛、停了就真停、不碰别的任何东西。
 *
 * 跑：node tools/brain-test/heartbeat-test.mjs
 */
import { startHeartbeat, BEAT_MS } from '../../js/brain/heartbeat.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(a === b, name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

const tick = () => new Promise(r => setTimeout(r, 10));

console.log('\nA. 打');
{
  const posts = [];
  let fire = null;
  const hb = startHeartbeat({
    fetchImpl: async (url, opt) => { posts.push({ url, opt }); return { ok: true, status: 200 }; },
    schedule: (fn) => { fire = fn; return 1; },
    cancel: () => { fire = null; },
  });
  hb.start();
  await tick();
  eq(posts.length, 1, 'A1 一开始就打一下（开机不能有 30 秒空窗）');
  eq(posts[0].url, '/api/alive', 'A2 打的是 /api/alive，不是别的');
  eq(posts[0].opt.method, 'POST', 'A3 用 POST（它要写一个时间，不是读）');
  eq(hb.stats().beats, 1, 'A4 成功次数记着');
  eq(BEAT_MS, 30000, 'A5 30 秒一次（比服务端 90 秒的判死线小三倍，漏两次也不算死）');

  fire();
  await tick();
  eq(posts.length, 2, 'A6 定时器到点会再打一下');
  eq(hb.stats().running, true, 'A7 跑着的时候有状态');

  hb.stop();
  eq(fire, null, 'A8 停了就把定时器真的清掉（不能只改一个标志位）');
}

console.log('\nB. 服务不在');
{
  const hb = startHeartbeat({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    schedule: () => 1, cancel: () => {},
  });
  hb.start();
  await tick();
  eq(hb.stats().fails, 1, 'B1 失败要计数');
  ok(hb.stats().lastError.includes('ECONNREFUSED'), 'B2 失败的原因留着');
  eq(hb.stats().beats, 0, 'B3 失败不算成功');
}

console.log('\nC. 它不该有别的作用');
{
  const hb = startHeartbeat({ fetchImpl: async () => ({ ok: true }), schedule: () => 1, cancel: () => {} });
  eq(Object.keys(hb).sort().join(','), 'once,start,stats,stop', 'C1 对外只有四个口（多一个就说明它开始干别的了）');
  const s = hb.stats();
  eq(Object.keys(s).sort().join(','), 'beats,fails,lastAt,lastError,ms,running', 'C2 统计里没有"她今天动了几次"这类东西');
}

console.log(`\n${fail ? '✗ ' : '✓ '} 通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
