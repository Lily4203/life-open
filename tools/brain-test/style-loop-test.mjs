/* 重问那条路：确定性验证
 * ============================================================
 * 真实对话里很难稳定复现"她一字不差重复"，所以这里用一个假模型：
 *   第一次回「好，灯关了。」（和记忆里撞），
 *   第二次回「灯灭了，黑着吧。」（换过说法）。
 * 断言五件事，缺一条这条路就是假通的：
 *   ① 提示词里真的有"你刚才说话的样子"
 *   ② 第一次那句被换掉了（不是拼在一起）
 *   ③ reprompted 记下了原话和新话（事后查得到）
 *   ④ 只重问一次（第二次还重复也认了，不许死循环）
 *   ⑤ 动作/记忆不跟着被改（重问只针对嘴）
 *
 * 跑：node tools/brain-test/style-loop-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemory } from '../../js/brain/memory.mjs';
import { createLoop } from '../../js/brain/loop.mjs';
import { nodeStore } from '../../js/brain/store-node.mjs';

const DIR = path.join(process.cwd(), '_tmp', 'e2e-rep');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
/* 同 quiet-test：私人数据可以不在，示例一定要在。 */
const IDENT = path.join(process.cwd(), 'data', 'identity.md');
fs.copyFileSync(fs.existsSync(IDENT) ? IDENT : path.join(process.cwd(), 'data.example', 'identity.md'),
  path.join(DIR, 'identity.md'));

const store = nodeStore(DIR);
const memory = createMemory({ store, charId: 'fish' });

const registry = {
  describeAll: () => '（只有说话）',
  windowInfo: () => null,
  has: () => false,
  get: () => null,
  names: () => [],
  call: async () => ({ ok: false, reason: 'no_action' }),
};

/* 历史里塞三句"好"开头 + 一句和待会要撞的原话。
 * 为什么要塞：审计看的是 memory，不是"这一轮"。不塞就等于在测一个空窗口。 */
for (const t of ['好，灯关了。', '好，这就关。', '好，关上了。', '灯是灭的。']) {
  memory.record({ who: 'fish', kind: 'said', text: t, salience: 0.5 });
}

let pass = 0, fail = 0;
const ok = (v, n, d = '') => { if (v) pass += 1; else { fail += 1; console.log(`  ✗ ${n}${d ? '：' + d : ''}`); } };

const seenSystems = [];
let callNo = 0;

async function chat({ system, messages }) {
  callNo += 1;
  seenSystems.push(system);
  if (callNo === 1) {
    return { content: JSON.stringify({ say: '好，灯关了。', mood: null, read: [], remember: [{ id: null, desc: '他今晚一直让关灯', body: '他连着让关了几次灯。' }], forget: [], plan: [], done: [], do: [] }) };
  }
  return { content: JSON.stringify({ say: '灯灭了。你要黑着就黑着吧。', mood: null, read: [], remember: [], forget: [], plan: [], done: [], do: [] }) };
}

const loop = createLoop({ memory, registry, chat });
const r = await loop.turn({ text: '把灯关了' });

console.log('模型被问了几次：', callNo);
console.log('她最后说：', r.say);
console.log('换过说法：', JSON.stringify(r.reprompted));

ok(callNo === 2, '① 撞了就再问一次', String(callNo));
ok(String(seenSystems[0]).includes('你刚才说话的样子'), '② 提示词里有"她刚才的样子"');
ok(String(seenSystems[0]).includes('「好」开头用了 3 次'), '③ 点名了用滥的开头', String(seenSystems[0]).slice(-300));
ok(r.say === '灯灭了。你要黑着就黑着吧。', '④ 用的是换过的那句，不是原来那句', r.say);
ok(r.reprompted && r.reprompted.from === '好，灯关了。' && r.reprompted.to === '灯灭了。你要黑着就黑着吧。',
  '⑤ reprompted 里留着原话和新话（事后查得到）', JSON.stringify(r.reprompted));
/* 这句是边界：重问只换嘴。她要记的事没跟着被换掉，否则就是借查重改了她的判断。 */
ok(Array.isArray(r.memory?.remembered) && r.memory.remembered.length >= 1,
  '⑥ 她要记的事还在（没被重问吃掉）', JSON.stringify(r.memory));

/* ---- 第二次还重复：必须认了，不许再问第三遍 ---- */
callNo = 0;
seenSystems.length = 0;
const loop2 = createLoop({ memory, registry, chat: async ({ system, messages }) => {
  callNo += 1;
  seenSystems.push(system);
  return { content: JSON.stringify({ say: '好，灯关了。', mood: null, read: [], remember: [], forget: [], plan: [], done: [], do: [] }) };
} });
const r2 = await loop2.turn({ text: '把灯关了' });
ok(callNo === 2, '⑦ 第二次还重复也只问两遍（不是三遍、不是死循环）', String(callNo));
ok(r2.say === '好，灯关了。', '⑧ 宁可重复一句，也不许一个字都不说', r2.say);

console.log(fail ? `\n${fail} 条不过，${pass} 条通过` : `\n全部通过：${pass} 条`);
process.exit(fail ? 1 : 0);
