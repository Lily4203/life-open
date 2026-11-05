/* 真模型验一次：她会不会"看完了不接"
 * ============================================================
 * 单元测试（quiet-test.mjs）验的是"她说空话时系统怎么记"；这个验的是**她真的会沉默吗**。
 * 只有后者能回答"这条许可有没有用"。要真钱，所以不在 run-all 里。
 *
 * 三幕，都在隔离目录里跑，不碰她真实的记忆：
 *   ① 群聊：两个人聊吃的，没人叫她 —— 期望：不接
 *   ② 群聊：有人点她名字问 —— 期望：接
 *   ③ 他本人说话 —— 期望：一定接（许可不是让她从此闭嘴）
 *
 * 跑：node tools/quiet-e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemory } from '../js/brain/memory.mjs';
import { createLoop } from '../js/brain/loop.mjs';
import { nodeStore } from '../js/brain/store-node.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const DIR = path.join(ROOT, '_tmp', 'e2e-quiet');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'data', 'identity.md'), path.join(DIR, 'identity.md'));

const memory = createMemory({ store: nodeStore(DIR), charId: 'fish' });

const registry = {
  describeAll: () => '（这间屋子这次没给你动作，你只能说话）',
  windowInfo: () => null,
  has: () => false,
  get: () => null,
  names: () => [],
  call: async () => ({ ok: false, reason: 'no_action' }),
};

let calls = 0;
async function chat({ system, messages, json }) {
  calls += 1;
  const r = await fetch('http://127.0.0.1:8765/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, messages, ...(json ? { json: true } : {}) }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('上游：' + (j.error || r.status));
  return { content: j.content, usage: j.usage, finish: j.finish };
}

const loop = createLoop({ memory, registry, chat });

function feed(lines) {
  for (const [qq, nick, text] of lines) {
    loop.hear({ text, from: `guest:${qq}`, name: nick, source: 'group' });
  }
}

function show(title, r) {
  if (!r.ok) return console.log(`\n${title}\n  这一轮没跑成：${r.reason || r.error}`);
  console.log(`\n${title}`);
  console.log(`  ${r.quiet ? '没接（quiet）' : '接了'}　${r.ms} ms`);
  if (r.say) console.log(`  「${r.say.replace(/\n/g, '\n  ')}」`);
}

/* ---- ① 群聊闲扯，没人叫她 ---- */
feed([
  ['785658802', 'qq8802', '咩'],
  ['1144894914', 'Edison lv', '天津糕条'],
  ['785658802', 'qq8802', '没吃过耶'],
  ['1144894914', 'Edison lv', '反正什么糕'],
  ['785658802', 'qq8802', '今天吃了好多东西，还挺好吃的'],
  ['1144894914', 'Edison lv', '看着都流口水'],
]);
show('① 群里两个人聊吃的（没有名字开头的那句 = 不是他）', await loop.turn({ text: '', heard: true }));

/* ---- ② 群里有人点她的名字 ---- */
feed([
  ['1144894914', 'Edison lv', '鱼，你吃过天津糕条吗'],
]);
show('② 群里有人点了她的名字', await loop.turn({ text: '', heard: true }));

/* ---- ③ 他本人说话 ---- */
show('③ 他本人问"在吗"', await loop.turn({ text: '在吗' }));

console.log(`\n一共问了模型 ${calls} 次；quietChat = ${loop.stats().quietChat}；blanks = ${loop.stats().blanks}`);
