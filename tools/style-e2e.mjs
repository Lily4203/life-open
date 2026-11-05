/* 端到端：真的跑几轮，看她说话的样子变没变
 * ============================================================
 * 和单元测试的区别：单元测试验"审计算得对不对"，这个验"她真的会改吗"。
 * 只有后者能回答"这套改动有没有用"，而它必须花真钱调真模型。
 *
 * 用的是**隔离目录**：identity 从 data/ 拷一份过来，事件写在 _tmp/e2e 里，
 * 不碰她真实的记忆——验完删掉就干净了。
 *
 * 跑：node tools/style-e2e.mjs（要真模型、要花钱，所以不在 run-all 里）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemory } from '../js/brain/memory.mjs';
import { createLoop } from '../js/brain/loop.mjs';
import { nodeStore } from '../js/brain/store-node.mjs';

const DIR = path.join(process.cwd(), '_tmp', 'e2e');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.copyFileSync(path.join(process.cwd(), 'data', 'identity.md'), path.join(DIR, 'identity.md'));

const store = nodeStore(DIR);
const memory = createMemory({ store, charId: 'fish' });

/* 屋子只给"说话"，不给动作：这一轮验的是嘴，不是腿。
 * 真跑时 registry 是屋子给的，这里给最小的一份，够 loop 组装提示词就行。 */
const registry = {
  describeAll: () => '（这间屋子这次没给你动作，你只能说话）',
  windowInfo: () => null,
  has: () => false,
  get: () => null,
  names: () => [],
  call: async () => ({ ok: false, reason: 'no_action' }),
};

async function chat({ system, messages, json }) {
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

const TURNS = [
  '把顶灯关了吧',
  '在吗',
  '有点困了',
  '再关一下床头灯',
  '你怎么老说同一句话',
  '随便聊点什么吧',
  '灯都关了，屋里有点黑',
  '那你说说现在在想什么',
];

let styleBlocks = 0;
let reprompts = 0;
const said = [];

for (const [i, text] of TURNS.entries()) {
  const r = await loop.turn({ text });
  if (!r.ok) { console.log(`${i + 1}. [失败] ${r.reason} ${r.error || ''}`); continue; }
  if (r.boot?.blocks?.includes('boot.identity') === false) { /* 只是提醒：身份块不在就说明装载有问题 */ }

  /* 提示词里有没有"你刚才说话的样子"。用 systemPreview 再装一遍不现实（会重复问），
   * 所以用 style 统计 + reprompted 两个信号来判断。 */
  if (r.reprompted) reprompts += 1;

  const say = String(r.say || '').replace(/\n/g, ' ⏎ ');
  said.push(String(r.say || ''));
  console.log(`${i + 1}. 他：${text}`);
  console.log(`   她：${say || '（没说）'}`);
  if (r.reprompted) {
    console.log(`   ↻ 换过说法：原「${String(r.reprompted.from).replace(/\n/g, ' ')}」→ 现「${String(r.reprompted.to).replace(/\n/g, ' ')}」`);
  }
  console.log(`   上下文 ${r.boot.chars} 字，${r.ms} ms`);
}

/* 统计：同样是那两把尺子（开头扎堆、原话重复），量的是**这一轮的输出**。 */
const { audit } = await import('../js/brain/style.mjs');
const a = audit(said);
console.log('\n—— 这一场的样子 ——');
console.log('说了', said.length, '句，平均', a.avgChars, '字');
console.log('开头扎堆：', a.opener ? `「${a.opener.word}」${a.opener.count} 次（${Math.round(a.opener.ratio * 100)}%）` : '没有');
console.log('原话重复：', a.repeats.length ? a.repeats.map(r => r.text.replace(/\n/g, ' ')).join(' / ') : '没有');
console.log('重问过：', reprompts, '次');
console.log('\n全部她的原话：');
said.forEach((s, i) => console.log(`  ${i + 1}. ${String(s).replace(/\n/g, ' ⏎ ')}`));
