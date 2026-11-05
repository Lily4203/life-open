/* 真模型验一次：同一件事被报第四次，她还说同一句吗
 * ============================================================
 * percept-count-test.mjs 验的是"次数有没有进提示词"；这个验的是**她拿到次数会不会换说法**。
 * 只有后者能回答"这一行有没有用"。要真钱，不在 run-all 里。
 *
 * 一幕：他反复开关顶灯（这是他真会做的事——灯就那么几个，一晚上能拨七八下）。
 * 每一轮都照真路子走：感知投一条 → 发起层派发 → 她醒一次 → 说或不说。
 *
 * 判据不是"她必须换说法"，而是"她**有可能**不重复"：
 *   - 四轮里至少有一轮，她的说法和前面几轮**不一样**（不是原话，也不是只换一个字）
 *   - 或者她干脆不开口
 * 以前四轮几乎一定是同一句，因为没有次数，四次看起来是同一件事。
 *
 * 跑：node tools/count-e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemory } from '../js/brain/memory.mjs';
import { createLoop } from '../js/brain/loop.mjs';
import { createInitiative } from '../js/brain/initiative.mjs';
import { createPerception } from '../js/brain/perception.mjs';
import { nodeStore } from '../js/brain/store-node.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const DIR = path.join(ROOT, '_tmp', 'e2e-count');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'data', 'identity.md'), path.join(DIR, 'identity.md'));

const memory = createMemory({ store: nodeStore(DIR), charId: 'fish' });

/* 屋子这一侧：给一份**像真页面会给的**最小处境。
 * 少给就会出现假结论——第一版这个脚本什么都没给，她四轮都不作声，
 * 看着像"她学会不重复了"，其实是"她既看不见屋子、也没有动作可做"，
 * 沉默是唯一合理的选择。要验的是"次数有没有改变她的话"，不是"她会不会闭嘴"。 */
const ROOM = '屋子里：顶灯、台灯、落地灯三盏，现在只剩台灯亮着；'
  + '窗帘拉着，门关着。你站在床边，离顶灯的开关两步远。';

const registry = {
  describeAll: () => '- toggle(target: 顶灯|台灯|落地灯|窗帘) — 开关屋子里的一样东西\n'
    + '- go_to(where) — 走到某样东西旁边\n- look_at(target) — 看向某样东西',
  windowInfo: () => null,
  has: n => ['toggle', 'go_to', 'look_at'].includes(n),
  get: () => null,
  names: () => ['toggle', 'go_to', 'look_at'],
  openWindow: () => null,
  closeWindow: () => null,
  call: async () => ({ ok: true, say: '好了' }),
};

let calls = 0;
const raw = [];
async function chat({ system, messages, json }) {
  calls += 1;
  const r = await fetch('http://127.0.0.1:8765/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, messages, ...(json ? { json: true } : {}) }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('上游：' + (j.error || r.status));
  raw.push({ content: j.content, counted: /第 \d+ 次/.test(system || ''), system });
  return { content: j.content, usage: j.usage, finish: j.finish };
}

/* 给一点前情：醒来这一轮只带最近 4 条消息，没有前情她手上就只有"顶灯刚被关掉"一句，
 * 说什么都像无中生有（实测：她四轮全都一个字不说）。真屋里她总有前情。 */
memory.record({ who: 'him', kind: 'said', text: '我去冲个澡，台灯给你留着。', place: '床边', salience: 0.6 });
memory.record({ who: 'fish', kind: 'said', text: '嗯，水别开太烫。', place: '床边', salience: 0.5 });

const initiative = createInitiative();
/* 这一层小夹子只改一件事：把 probe 关掉。
 * 第一次看到一件事时，提示词会多说一句"先做最轻的那个，别一上来就开口"——
 * 那是**另一条**纪律（第一次先走过去看看），它会把这一场实验里的话全掐掉。
 * 我们要量的是"次数有没有改变她的话"，所以把"第一次别开口"这条按住。 */
const shim = {
  ...initiative,
  dispatch: opts => { const it = initiative.dispatch(opts); if (it) it.probe = false; return it; },
};
const loop = createLoop({ memory, registry, chat, initiative: shim, extra: () => ROOM });

/* 走真路：不是手写一条 signal，而是照 rules/room.json 的规则、用真快照拨灯。
 * 手写会让"次数从哪来"这件事被绕过去——那正是这一版要验的东西。 */
const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules', 'room.json'), 'utf8'));
const P = createPerception({ rules, raise: payload => initiative.raise(payload) });

let lights = { 顶灯: true, 台灯: true, 落地灯: false };
P.observe({ pose: 'stand', lights, near: '床边', present: true }, { by: 'him' });   // 立基线

const says = [];
for (let i = 1; i <= 4; i++) {
  const before = raw.length;
  lights = { ...lights, 顶灯: !lights.顶灯 };
  const seen = P.observe({ pose: 'stand', lights, near: '床边', present: true }, { by: 'him' });
  const hit = seen.raised && seen.raised[0];
  const r = await loop.wake({});
  const say = (r.say || '').replace(/\n/g, ' ').trim();
  says.push(say);
  console.log(`\n第 ${i} 次` + (hit ? `（规则 ${hit.rule}，她被告知是第 ${hit.occurrences} 次）` : '（没命中规则）'));
  console.log(`  ${r.ok ? (say ? '说了' : '没开口') : '没跑成：' + (r.reason || r.error)}　${r.ms ?? '—'} ms`);
  if (say) console.log(`  「${say}」`);
  /* 这一轮**新增的**请求，不是"最后一条"：有的轮次不问模型（没有事就不花钱），
   * 那时候最后一条属于上一轮，照着打会张冠李戴。 */
  const mine = raw.slice(before);
  if (!mine.length) console.log('  （这一轮没问模型）');
  for (const m of mine) {
    if (process.env.RAW) console.log(`  模型原文：${m.content.slice(0, 160)}`
      + `　（提示词里有次数：${m.counted ? '有' : '没有'}）`);
  }
  if (process.env.DUMP && mine.length) {
    fs.writeFileSync(path.join(ROOT, '_tmp', `count-system-${i}.txt`), mine[mine.length - 1].system || '');
  }
  await new Promise(res => setTimeout(res, 1200));   // 别把上游打太快
}

/* ---- 结论 ---- */
const said = says.filter(Boolean);
const uniq = new Set(said.map(s => s.replace(/[\s，。、！？~…—]/g, '')));
const quiet = says.length - said.length;
console.log('\n---- 结论 ----');
console.log(`说了 ${said.length} 次，其中不同的话 ${uniq.size} 种；没开口 ${quiet} 次`);
if (!said.length) console.log('四轮都没开口：次数到了她手上，她选择不再提。');
else if (uniq.size === said.length) console.log('四句都不一样：她看得见"又是这盏灯"，于是换了说法。');
else console.log('出现了重复：这一次次数还不够用，或者她就是想说同一句。');
console.log(`一共问了模型 ${calls} 次；quietChat = ${loop.stats().quietChat}`);
