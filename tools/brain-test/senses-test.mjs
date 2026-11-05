/* 感官：只报事实，不报推断
 * ------------------------------------------------------------
 * 这组断言只测三件：
 *   A  光标只在换区域时报（位置没变就不发）
 *   B  键盘一串只报一次（节流靠到达时间，不靠"等他不敲"）
 *   C  屏幕默认关，同意才看；而且只收"看懂的一句话"，不收图不收坐标
 *
 * 跑：node tools/brain-test/senses-test.mjs
 */

import fs from 'node:fs';
import { createSenses, regionOf, REGIONS } from '../../js/brain/senses.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name,
  `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

function harness(opts = {}) {
  let t = 1000;
  const seen = [];
  const s = createSenses({ emit: (type, detail) => { seen.push({ type, detail }); return { ok: true }; },
                           now: () => t, ...opts });
  return { s, seen, tick: ms => { t += ms; }, t: () => t };
}

console.log('\nA. 光标：换区域才报');

{
  eq(regionOf({ x: 0, y: 0, w: 900, h: 600 }), '左上', 'A1 左上角');
  eq(regionOf({ x: 899, y: 599, w: 900, h: 600 }), '右下', 'A2 右下角');
  eq(regionOf({ x: 450, y: 300, w: 900, h: 600 }), '中', 'A3 中间');
  eq(regionOf({ x: 1, y: 2 }), null, 'A4 不知道画面多大就不猜');
}

{
  const { s, seen } = harness();
  const r = s.cursor({ x: 10, y: 10, w: 900, h: 600 });
  eq(r.skipped, 'disabled', 'A5 默认不报光标（鼠标一直在动，报了全是噪音）');
  eq(seen.length, 0, 'A6 没发出去');
}

{
  const { s, seen, tick } = harness({ enabled: { pointer_region: true } });
  s.cursor({ x: 10, y: 10, w: 900, h: 600 });
  eq(seen.length, 1, 'A7 打开后第一次报');
  eq(seen[0].type, 'pointer_region', 'A8 事件类型对');
  ok(/左上/.test(seen[0].detail), 'A9 说人话，不说坐标', seen[0].detail);

  tick(100);
  for (let i = 0; i < 20; i++) s.cursor({ x: 20 + i, y: 20, w: 900, h: 600 });
  eq(seen.length, 1, 'A10 同一区域里怎么动都不报');

  tick(900);
  s.cursor({ x: 500, y: 300, w: 900, h: 600 });
  eq(seen.length, 2, 'A11 换到中间，报一次');

  tick(100);
  s.cursor({ x: 800, y: 500, w: 900, h: 600 });
  eq(seen.length, 2, 'A12 刚报完就在边界上来回蹭，不重复报');
  tick(900);
  s.cursor({ x: 100, y: 500, w: 900, h: 600 });
  eq(seen.length, 3, 'A13 过了 gate 再换区域，才再报');
}

console.log('\nB. 键盘：一串只报一次');

{
  const { s, seen, tick } = harness();
  s.key('a'); s.key('b'); s.key('c');
  eq(seen.length, 1, 'B1 连敲三下只报一次');
  eq(seen[0].type, 'typing', 'B2 类型是 typing');
  ok(/敲/.test(seen[0].detail), 'B3 说的是"敲了"，不是"正在打字"');
  tick(2000);
  s.key('d');
  eq(seen.length, 1, 'B4 gate 内还是同一串');
  tick(4000);
  s.key('e');
  eq(seen.length, 2, 'B5 过了 gate，新的一串');
}

{
  const { s, seen } = harness({ enabled: { typing: false } });
  s.key('a');
  eq(seen.length, 0, 'B6 关掉就一条都不发');
}

{
  const { s, seen } = harness();
  s.key('Enter');
  ok(!/Enter/.test(seen[0].detail), 'B7 事件里不带按键值（否则密码会进记忆）');
}

console.log('\nC. 屏幕：默认关，同意才看');

{
  const { s, seen } = harness();
  const r = s.screen({ summary: '他在写代码' });
  eq(r.ok, false, 'C1 默认不看');
  eq(r.reason, 'disabled', 'C2 原因是关着');
  eq(seen.length, 0, 'C3 没有事件');

  s.enable('screen');
  const r2 = s.screen({ summary: '他在写代码' });
  eq(r2.reason, 'no_consent', 'C4 开了屏幕，但没同意也不看');

  s.consent(true);
  const r3 = s.screen({ summary: '他在写代码' });
  eq(r3.ok, true, 'C5 同意后才看');
  eq(seen.length, 1, 'C6 看一次，报一次');
  ok(/他在写代码/.test(seen[0].detail), 'C7 报的是看懂的那句话');
  ok(!/[xy]=|坐标|像素/.test(seen[0].detail), 'C8 不带坐标');
}

{
  const { s, seen } = harness({ enabled: { screen: true } });
  s.consent(true);
  const r = s.screen({ summary: '' });
  eq(r.ok, false, 'C9 空的一句话不算看过');
  eq(seen.length, 0, 'C10 也不报');
  s.consent(false);
  eq(s.screen({ summary: 'x' }).reason, 'no_consent', 'C11 随时能收回同意');
}

console.log('\nD. 这层里没有定时器');

{
  const src = fs.readFileSync(new URL('../../js/brain/senses.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/setInterval|setTimeout/.test(src), 'D1 没有定时器（节流只看到达时间）');
  ok(!/requestAnimationFrame/.test(src), 'D2 没有帧循环');
  ok(!/\bfetch\s*\(/.test(src), 'D3 不截图、不请求');
  ok(!/canvas|getImageData|screenX|clientX/.test(src), 'D4 不碰画面（那是桌面壳的事）');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
