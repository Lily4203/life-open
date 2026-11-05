/* 验证"重启之后还能回忆起之前的事"到底能不能保证。
 * 每条断言都对应一种真实的坏法：
 *   找不到 / 找错了 / 说成刚才 / 重复说同一件 / 编细节 / 身份被悄悄改掉 / 预算爆掉
 * 运行：node memory-test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, relative, tokens } from '../../js/brain/memory.mjs';
import { nodeStore } from '../../js/brain/store-node.mjs';

let pass = 0, fail = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; fails.push([name, e.message]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}\n        期望 ${B}\n        实际 ${A}`);
};

const IDENT = '你是阿蓝。说话短，不解释情绪，不总结对方的话。怕生，但熟了会黏人。';

let T = new Date(2026, 10, 5, 1, 0, 0).getTime();   // 固定时钟：2026-11-05 01:00
const now = () => T;
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-'));
  writeFileSync(join(dir, 'identity.md'), IDENT, 'utf8');
  return { dir, store: nodeStore(dir) };
};
const boot = (dir, cue = '') => createMemory({ store: nodeStore(dir), now }).load() &&
  (() => { const m = createMemory({ store: nodeStore(dir), now }); m.load(); return m.boot({ cue }); })();

console.log('\n── M. 重启之后还认不认得 ────────────────────────────');

await t('M1 事件先落盘再返回：新进程读得到（这是"重启"的最小定义）', () => {
  const { dir } = fresh();
  const A = createMemory({ store: nodeStore(dir), now });
  A.load(); A.stampIdentity();
  T += 1000; A.setWorld({ pose: '坐在椅子上' });
  const e = A.record({ text: '他在窗台放了一杯水', place: '窗台', people: ['user'], salience: 0.8 });
  T += 1000; A.record({ text: '我把椅子往窗边挪了一点', place: '窗边', salience: 0.6 });

  const B = createMemory({ store: nodeStore(dir), now });   // 换一个实例 = 重启
  const stat = B.load();
  eq(stat.events, 2, '重启后事件数不对');
  ok(B.events().some(x => x.id === e.id && x.text.includes('一杯水')), '重启后找不到那条记忆');
});

await t('M2 开机顺序是硬的：身份永远第一块，且不会被预算挤掉', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load(); m.stampIdentity();
  m.setWorld({ pose: '站着' });
  const b = m.boot({ cue: '椅子' });
  eq(b.blocks[0].id, 'boot.identity', '身份不是第一块');
  eq(b.blocks[0].authority, 'system', '身份没进指令区');
  ok(b.chars <= 1400, `开机注入超预算：${b.chars}`);
});

await t('M3 时间要说对：隔了 3 小时就不能说"刚才"', () => {
  const { dir } = fresh();
  const A = createMemory({ store: nodeStore(dir), now }); A.load(); A.stampIdentity();
  A.setWorld({ pose: '坐在椅子上' });
  T += 3 * 3600 * 1000 + 25 * 60 * 1000;
  const b = boot(dir);
  const nowBlock = b.blocks.find(x => x.id === 'boot.now');
  ok(nowBlock, '没有"现在"这块');
  ok(/3 小时/.test(nowBlock.text), `时间没说对：${nowBlock.text}`);
  ok(!/刚刚|刚才/.test(nowBlock.text), '隔了三小时还说"刚刚"');
});

await t('M4 按线索能想起对的那件，并说得出凭什么（命中词 + 出处）', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load(); m.stampIdentity();
  T += 1000; const e1 = m.record({ text: '我把椅子往窗边挪了一点', place: '窗边', salience: 0.6 });
  T += 1000; m.record({ text: '台灯有点烫', place: '书桌', salience: 0.4 });
  T += 1000; m.record({ text: '外面在下雨', place: '窗边', salience: 0.3 });

  const hits = m.recall('椅子搬到窗边了', { k: 2 });
  eq(hits[0].id, e1.id, '没有先想起椅子那件事');
  ok(hits[0].why.includes('椅') || hits[0].why.includes('椅子'), `没给出命中理由：${JSON.stringify(hits[0].why)}`);
  ok(hits[0].when, '没带"多久以前"');
});

await t('M5 说过的事不再主动重提，但被问起来仍然找得到', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load(); m.stampIdentity();
  T += 1000; const e = m.record({ text: '昨晚他说要早点睡', salience: 0.9 });
  m.markTold(e.id);
  eq(m.recall('早点睡', { excludeTold: true }).length, 0, '已经说过的事又被主动翻出来了');
  ok(m.recall('早点睡').length === 1, '被问起来反而找不到了（那是失忆，不是不重复）');
});

await t('M6 一条记忆都没有时，开机明说"还没有"，并写明不要补细节', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load(); m.stampIdentity();
  const b = m.boot({ cue: '你上次说那辆坦克呢' });
  const blk = b.blocks.find(x => x.id === 'boot.mem_none');
  ok(blk, '没有记忆时没给"空"的明确信号');
  ok(/不要补细节/.test(blk.text), '没写"不要编"');
  // 反面：不能再有"我们替她挑三条"的那种块（那是外置算法在替她决定想起什么）
  ok(!b.blocks.some(x => x.id === 'boot.recall' || x.id === 'boot.recall_empty'), '还在替她挑记忆');
});

await t('M7 身份被改过要说出来，不能假装没事', () => {
  const { dir } = fresh();
  const A = createMemory({ store: nodeStore(dir), now }); A.load(); A.stampIdentity();
  writeFileSync(join(dir, 'identity.md'), IDENT + '\n现在你同时是一只猫。', 'utf8');
  const b = boot(dir);
  ok(b.blocks.some(x => x.id === 'boot.identity_changed'), '身份被改了却没提示');
});

await t('M8 没做完的事重启后还在，做完了就不在', () => {
  const { dir } = fresh();
  const A = createMemory({ store: nodeStore(dir), now }); A.load(); A.stampIdentity();
  const a = A.addAgenda({ text: '把窗台上那盆花挪到有光的地方', next: '先看看窗外有没有太阳' });
  A.addAgenda({ text: '问他昨晚睡好没有' });
  const B = createMemory({ store: nodeStore(dir), now }); B.load();
  eq(B.openAgenda().length, 2, '重启后议程丢了');
  B.closeAgenda(a.id);
  const C = createMemory({ store: nodeStore(dir), now }); C.load();
  eq(C.openAgenda().length, 1, '做完的事重启后又回来了');
});

await t('M9 事件 id 唯一且能指回时间（否则"出处"是假的）', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load();
  const ids = [];
  for (let i = 0; i < 50; i++) { T += 1000; ids.push(m.record({ text: `第 ${i} 件` }).id); }
  eq(new Set(ids).size, 50, 'id 撞了');
  ok(m.events().every(e => typeof e.at === 'number' && e.at > 0), '有事件没有时间');
});

await t('M10 事件堆到 200 条，开机注入仍然封顶，且丢的是整块', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load(); m.stampIdentity();
  for (let i = 0; i < 200; i++) { T += 1000; m.record({ text: `她做了第 ${i} 件小事，在房间里走来走去` }); }
  const b = m.boot({ cue: '椅子', limit: 150 });
  ok(b.chars <= 150, `超预算：${b.chars}`);
  ok(b.dropped.length > 0, '超了却没记录丢了什么');
  ok(b.dropped.every(d => d.whole === true), '出现了截断');
  ok(!b.blocks.some(x => /…|\.\.\.$/.test(x.text)), '块内被截断');
});

await t('M11 相对时间的边界（这是最容易说错的一句话）', () => {
  eq(relative(20 * 1000), '刚刚', '20 秒');
  eq(relative(5 * 60 * 1000), '5 分钟前', '5 分钟');
  eq(relative(3 * 3600 * 1000), '3 小时前', '3 小时');
  eq(relative(26 * 3600 * 1000), '1 天 2 小时前', '26 小时');
  eq(relative(3 * 86400000), '3 天前', '3 天');
});

await t('M12 中文切词能切开短句（不然检索全靠长句硬匹配）', () => {
  const tk = tokens('我把椅子往窗边挪了一点');
  ok(tk.has('椅子') && tk.has('窗边'), `切词失败：${[...tk].join('/')}`);
});

console.log(`\n── N. 长期记忆：她自己写、自己读、自己忘（照 AIRI 的两层） ──────`);

await t('N1 开机只给索引（id + 一句话），正文不进提示词', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load(); m.stampIdentity();
  T += 1000; const a = m.writeMem({ desc: '椅子被她挪到窗边', body: '十一月五日晚上，因为她说那里有光，她把椅子从桌子边推到了窗边。' });
  T += 1000; m.writeMem({ desc: '他周三要去外地', body: '他说下周三走，去三天。' });
  const b = m.boot({});
  const blk = b.blocks.find(x => x.id === 'boot.memindex');
  ok(blk, '没有索引块');
  ok(blk.text.includes(a.entry.id) && blk.text.includes('椅子被她挪到窗边'), '索引里没有 id 或那句话');
  ok(!blk.text.includes('推到了窗边'), '正文被整段塞进了开机注入（那就白分两层了）');
});

await t('N2 按 id 能读到正文；不存在的 id 要说"没有"，不能回空字符串', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load();
  const a = m.writeMem({ desc: '灯有点烫', body: '台灯的灯泡烫手，别一直开着。' });
  const { got, missing } = m.readMem([a.entry.id, 'm999']);
  eq(got.length, 1, '该读到一条');
  ok(got[0].body.includes('烫手'), '正文不对');
  eq(missing, ['m999'], '没读到和没这条必须分得清');
});

await t('N3 带 id 重写是"改"，不是新开一条（否则同一件事会写成三条）', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load();
  const a = m.writeMem({ desc: '他怕黑', body: '他怕黑。' });
  T += 1000;
  const r = m.writeMem({ id: a.entry.id, desc: '他怕黑，但不说', body: '他怕黑，从来不说，只把灯留着。' });
  eq(r.ok, true, '改写失败');
  eq(m.memories().length, 1, '改写变成了新增');
  eq(m.readMem(a.entry.id).got[0].body, '他怕黑，从来不说，只把灯留着。', '正文没被改掉');
});

await t('N4 忘了要立墓碑：索引里没有了，同一个 id 也不能被写回来', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load();
  const a = m.writeMem({ desc: '记错的一件事', body: '他其实不吃辣。' });
  m.forgetMem(a.entry.id);
  eq(m.memories().length, 0, '忘了却还在');
  ok(!m.boot({}).blocks.find(x => x.id === 'boot.memindex'), '索引里还挂着忘了的那条');
  const again = m.writeMem({ id: a.entry.id, desc: '记错的一件事', body: '他又吃了。' });
  eq(again.ok, false, '墓碑没拦住，旧 id 复活了');
  eq(again.reason, 'forgotten', '拦是拦住了，但理由不对');
});

await t('N5 重启之后，她自己写的记忆还在（这是"跨重启"的唯一标准）', () => {
  const { dir } = fresh();
  const A = createMemory({ store: nodeStore(dir), now }); A.load(); A.stampIdentity();
  const a = A.writeMem({ desc: '窗台上有一杯水', body: '他放了一杯水在窗台，说回来再喝。' });
  const B = createMemory({ store: nodeStore(dir), now }); B.load();
  eq(B.memories().length, 1, '重启后记忆没了');
  eq(B.readMem(a.entry.id).got[0].body, '他放了一杯水在窗台，说回来再喝。', '正文丢了');
});

await t('N6 记忆能搬走：导出成纯文本，导进空库还是那些事', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load();
  m.writeMem({ desc: '她不喜欢被摸头', body: '被摸头会躲。' });
  m.writeMem({ desc: '周三他要去外地', body: '走三天。' });
  const md = m.exportMarkdown();
  ok(md.includes('她不喜欢被摸头') && md.includes('被摸头会躲'), '导出的文本里没有记忆');

  const d2 = mkdtempSync(join(tmpdir(), 'fishmem2-'));
  const n = createMemory({ store: nodeStore(d2), now }); n.load();
  const r = n.importData(md);
  eq(r.count, 2, `导入条数不对：${r.count}`);
  ok(n.memories().some(x => x.body.includes('被摸头会躲')), '导入后正文丢了');
});

await t('N7 索引超过 40 条要截断，并且说清"还有几条"', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load();
  for (let i = 0; i < 45; i++) { T += 1000; m.writeMem({ desc: `第 ${i} 件事`, body: `第 ${i} 件事的正文` }); }
  const blk = m.boot({}).blocks.find(x => x.id === 'boot.memindex');
  ok(/还有 5 条/.test(blk.text), `没交代被截掉的条数：${blk.text.slice(-40)}`);
  const lines = blk.text.split('\n').filter(l => l.startsWith('- '));
  eq(lines.length, 40, '索引行数不对');
});

await t('N8 开机第一条是"现在是几点"（不然她说不出天亮了没有）', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load(); m.stampIdentity();
  const b = m.boot({});
  const blk = b.blocks.find(x => x.id === 'boot.now');
  ok(/现在是 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（周[日一二三四五六]）/.test(blk.text), `没有绝对时间：${blk.text}`);
});

/* 这两条对应一次真跑：她说"我去关灯"，三步做完，下一轮只看见自己走过、关过、坐过，
 * 完全不记得那句"早点睡"——动作回执把"最近发生"的三格占满了。 */
await t('N9 连做三步：回执只占一格，"他刚说的话"不会被挤掉', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load();
  T += 1000; m.record({ who: 'him', kind: 'said', text: '早点睡' });
  T += 1000; m.record({ who: 'fish', kind: 'did', text: '你走到开关边上', salience: 0.4 });
  T += 1000; m.record({ who: 'fish', kind: 'did', text: '你关上了灯', salience: 0.4 });
  T += 1000; m.record({ who: 'fish', kind: 'did', text: '你坐下了', salience: 0.4 });
  const blk = m.boot({}).blocks.find(x => x.id === 'boot.recent');
  const lines = blk.text.split('\n').filter(l => l.startsWith('- '));
  eq(lines.length, 2, '应该是"他说的一句 + 一条回执"：' + blk.text);
  ok(/早点睡/.test(blk.text), '他的话被回执挤出去了：' + blk.text);
  ok(/你坐下了/.test(blk.text), '留下的不是最新那条回执：' + blk.text);
  ok(!/关上了灯|走到开关边上/.test(blk.text), '旧回执还在占位：' + blk.text);
});

await t('N10 半途的回执不许被顶掉（它排最后，最容易被挤）', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load();
  T += 1000; m.record({ who: 'him', kind: 'said', text: '等一下' });
  T += 1000; m.record({ who: 'fish', kind: 'did', text: '你走到开关边上', salience: 0.4 });
  T += 1000; m.record({ who: 'fish', kind: 'did', text: '你走到一半停下来了', salience: 0.75 });
  const blk = m.boot({}).blocks.find(x => x.id === 'boot.recent');
  ok(/走到一半停下来了/.test(blk.text), '半途那条丢了——她会以为自己还在走：' + blk.text);
  ok(!/走到开关边上/.test(blk.text), '旧的回执留下了：' + blk.text);
});

await t('N11 整段只有动作时只留一条，不重复占三格', () => {
  const { dir } = fresh();
  const m = createMemory({ store: nodeStore(dir), now }); m.load();
  for (const text of ['你走过去了', '你关上了灯', '你坐下了']) {
    T += 1000; m.record({ who: 'fish', kind: 'did', text, salience: 0.4 });
  }
  const blk = m.boot({}).blocks.find(x => x.id === 'boot.recent');
  const lines = blk.text.split('\n').filter(l => l.startsWith('- '));
  eq(lines.length, 1, '只该剩一行：' + blk.text);
  ok(/你坐下了/.test(blk.text), '留的不是最新那条：' + blk.text);
});

console.log(`\n${fail ? '✗' : '✓'}  通过 ${pass} / ${pass + fail}`);
if (fail) { console.log('失败：'); fails.forEach(([n, m]) => console.log(` - ${n}: ${m}`)); process.exit(1); }
