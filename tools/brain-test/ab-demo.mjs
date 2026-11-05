/* 同一段会话，两条投影各打一遍 —— 这是给 #3 用的"证据"，不是判据。
 * 不做"谁更好"的结论，只把字数、块数、被丢的块、逐块差异摆出来。
 * 运行：node ab-demo.mjs [--write]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createContext } from '../../js/brain/context.mjs';

const ctx = createContext({ budget: 1400 });
const at = (s) => `第 ${s} 秒`;

ctx.writer('sys.rule',   { authority: 'system',    order: 1,  weight: 99, title: '规则' })
   .set('你是阿蓝。不解释情绪，不总结对方的话，一次最多两句。');
ctx.writer('room.now',   { authority: 'context',   order: 10, weight: 8,  title: '此刻' });
ctx.writer('room.event', { authority: 'context',   order: 20, weight: 5,  mode: 'append', maxItems: 10, title: '刚发生' });
ctx.writer('user.said',  { authority: 'context',   order: 30, weight: 6,  mode: 'append', maxItems: 6,  title: '他说的' });

/* 模拟 30 秒：她的状态每帧都在变（高频），事件零散（低频） */
for (let s = 0; s <= 30; s++) {
  ctx.ingest('room.now', `${at(s)}她${s < 8 ? '站在门口' : s < 20 ? '坐在椅子边缘' : '把腿收到椅子上'}`);
  if (s === 3) ctx.ingest('user.said', '你今天怎么这么安静', { kind: 'event' });
  if (s === 5) ctx.ingest('room.event', '他把台灯拧亮了一格', { kind: 'event' });
  if (s === 12) ctx.ingest('room.event', '窗外有辆车开过去', { kind: 'event' });
  if (s === 21) ctx.ingest('room.event', '她把抱枕抱起来了', { kind: 'event' });
}

const c = ctx.compare({ limit: 1400 });
const pad = (s, n) => String(s).padEnd(n);
console.log('写者            replace  append   差');
for (const w of c.perWriter) console.log(`${pad(w.id, 15)} ${pad(w.r, 8)} ${pad(w.a, 8)} ${w.a - w.r}`);
console.log(`\n合计            ${pad(c.replace.chars, 8)} ${pad(c.append.chars, 8)} ${c.deltaChars}`);
console.log(`块数            ${pad(c.replace.blocks, 8)} ${pad(c.append.blocks, 8)}`);
console.log(`被丢的块        ${c.replace.dropped.length}        ${c.append.dropped.length}`);
console.log(`\n只在 append 里出现的写者：${c.onlyInAppend.join(', ') || '（无）'}`);
console.log(`只在 replace 里出现的写者：${c.onlyInReplace.join(', ') || '（无）'}`);

const show = m => console.log(`\n──── ${m} ────\n` + ctx.assemble({ mode: m, limit: 1400 }).text);
show('replace');
show('append');

if (process.argv.includes('--write')) {
  mkdirSync(new URL('../../logs/', import.meta.url), { recursive: true });
  // 用本地日期，不用 toISOString（它是 UTC，凌晨两点会记成昨天）
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const f = new URL(`../../logs/ctx-ab-${day}.jsonl`, import.meta.url);
  writeFileSync(f, JSON.stringify({ at: Date.now(), compare: c, dump: ctx.dump() }) + '\n', { flag: 'a' });
  console.log(`\n已写入 ${f.pathname}`);
}
