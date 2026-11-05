/* 她说话的样子：会不会重复自己
 * ============================================================
 * 这一组验的不是"说话好不好听"（那个只能耳朵判断），是**八股是从哪来的**这几个具体来源：
 *
 *   ① 开头扎堆：303 句里 19% 以"好"开头——这不是风格，是没得选；
 *   ② 原话重复：13% 的句子一字不差地说过——她看得见历史，但历史是"跟着像"不是"注意避开"；
 *   ③ 停顿标记：写了【停】就真该停，不是让 TTS 把这两个字念出来。
 *
 * 三个地方最容易写错，所以每条都有对照：
 *   · 判重复的阈值：太松会把"灯关了"和"窗帘也拉了"判成一句，她会不敢说话；
 *   · 短句豁免："在。"被叫十次答十次"在"是正常的，真人也是这样；
 *   · 重问只能一次：松手就是死循环，那一轮她一个字都说不出来。
 *
 * 跑：node tools/brain-test/style-test.mjs
 */
import { audit, brief, similarity, isRepeat, createStyle, bare, stripMarks, MARKS } from '../../js/brain/style.mjs';
import { splitScript, stripScript } from '../../js/brain/say-stream.mjs';

let pass = 0, fail = 0;
const ok = (v, name, detail = '') => {
  if (v) { pass += 1; }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? '：' + detail : ''}`); }
};
const eq = (a, b, name) => {
  const good = JSON.stringify(a) === JSON.stringify(b);
  if (good) { pass += 1; }
  else { fail += 1; console.log(`  ✗ ${name}：要 ${JSON.stringify(b)}，得到 ${JSON.stringify(a)}`); }
};

/* ---------------- A. 先把它说的话和它的标记分开 ---------------- */

console.log('A. 标记不是话');

{
  eq(stripMarks('好。【停】灯关了。'), '好。灯关了。', 'A1 【停】摘掉之后是干净的');
  eq(stripMarks('没有标记的一句。'), '没有标记的一句。', 'A2 没标记就原样');
  eq(bare('好，灯关了。'), '好灯关了', 'A3 归一只留字');
  eq(bare('好 灯关了！'), bare('好，灯关了。'), 'A4 标点和空格不影响归一');
  /* 这条是实质的：标记出现在话里，不改变"这是同一句话"的判断 */
  ok(isRepeat('好。【停】灯关了。', '好，灯关了。'), 'A5 带标记和不带标记算同一句');
  eq(MARKS, ['停'], 'A6 标记只有【停】（笑和叹气 TTS 做不出来，不假装）');
}

/* ---------------- B. 两句像不像 ---------------- */

console.log('\nB. 像不像的判据');

{
  eq(similarity('好，灯关了。', '好，灯关了。'), 1, 'B1 同一句是 1');
  ok(similarity('好，灯关了。', '好，灯关掉了。') < 0.8, 'B2 多一个字就不该算同一句',
    String(similarity('好，灯关了。', '好，灯关掉了。')));
  ok(similarity('灯是灭的。', '窗帘拉上了。') < 0.3, 'B3 不相干的两句分数要低',
    String(similarity('灯是灭的。', '窗帘拉上了。')));
  ok(!isRepeat('在。', '在。'), 'B4 短应答不算重复（真人被叫十次也应十次）');
  ok(!isRepeat('好。', '嗯。'), 'B5 两个字的不同应答不算重复');
  ok(isRepeat('好，灯关了。', '好，灯关了。'), 'B6 四个字以上的原话算重复');
  ok(!isRepeat('灯关了。', '灯关了，窗帘也拉了，屋里现在一点光都没有。'), 'B7 长度差太多不判（后半句是新信息）');
}

/* ---------------- C. 开头扎堆 ---------------- */

console.log('\nC. 开头两个字用滥了没有');

{
  const a = audit(['好，灯关了。', '好，这就去。', '好，我去拉。', '灯是灭的。']);
  ok(a.opener && a.opener.word === '好', 'C1 三句"好"开头要被认出来', JSON.stringify(a.opener));
  eq(a.opener && a.opener.count, 3, 'C2 数对');

  const b = audit(['好，灯关了。', '灯是灭的。', '窗帘拉上了。']);
  eq(b.opener, null, 'C3 只出现一次不报（报了她也没办法改）');

  const c = audit(['有点冷。', '有点累。', '窗开着。', '灯亮着。']);
  ok(!c.opener, 'C4 两次（占一半但不到三次）也不报', JSON.stringify(c.opener));

  const d = audit([]);
  eq(d.n, 0, 'C5 空列表不崩');
  eq(brief(d), '', 'C6 没话可说时提示词块是空的');

  const e = audit(['在。', '好。', '嗯。']);
  eq(e.opener, null, 'C7 单字应答没有"开头两个字"，不构成扎堆');
}

/* ---------------- D. 撞了前面的 ---------------- */

console.log('\nD. 这句刚说过');

{
  const a = audit(['好，灯关了。', '灯是灭的。', '好，灯关了。']);
  eq(a.repeats.length, 1, 'D1 撞一句报一次');
  eq(a.repeats[0].same, '好，灯关了。', 'D2 报的是原话（不是去了标点的版本，那个念不出来）');

  const b = audit(['好，灯关了。', '好，灯关了。', '好，灯关了。', '好，灯关了。']);
  ok(b.repeats.length <= 1, 'D3 同一句说四遍也只占一行（提示词只有两行位置）',
    String(b.repeats.length));

  const c = audit(['在。', '在。', '在。']);
  eq(c.repeats.length, 0, 'D4 短应答不进撞车名单');

  const d = audit(['好，关了。\n这下真黑了。', '好，关了。\n这下真黑了。']);
  eq(d.repeats.length, 1, 'D5 带换行的两句也算撞（她会分两行说）');
}

/* ---------------- E. 递给她的那段话 ---------------- */

console.log('\nE. 提示词块');

{
  eq(brief(audit(['灯亮着。', '窗帘拉上了。', '今天三点。'])), '', 'E1 没毛病就一个字都不说');

  const a = audit(['好，灯关了。', '好，这就去。', '好，我去拉。']);
  const t = brief(a);
  ok(t.includes('## 你刚才说话的样子'), 'E2 有标题');
  ok(t.includes('「好」开头用了 3 次'), 'E3 点名具体是哪两个字、几次', t);
  ok(t.includes('好，灯关了。'), 'E4 把她自己的原话给她看');

  const b = audit(['行，我去拉。', '行，我去拉。']);
  ok(brief(b).includes('前面已经说过'), 'E5 撞车要说清是哪句');

  /* 措辞上不能出现的两样东西，各验一次：
   *   "请不要重复"——变成规则，她会开始自我检查，越说越僵；
   *   "太单调了"——变成判决，她会去演一个不单调的人。 */
  const all = brief(audit(['好，灯关了。', '好，这就去。', '好，我去拉。'])) + brief(b);
  ok(!/不要重复|别重复|太单调|过于单调/.test(all), 'E6 不写成规则，也不写成判决', all);
}

/* ---------------- F. 挂在大脑上那一层 ---------------- */

console.log('\nF. 查重与重问');

{
  const evs = [
    { who: 'fish', kind: 'said', text: '好，灯关了。' },
    { who: 'him', kind: 'said', text: '把灯关了' },
  ];
  const mem = { charId: 'fish', events: () => evs.slice() };
  const st = createStyle({ memory: mem, window: 10 });

  ok(st.check('好，灯关了。').dup, 'F1 原话说一遍就认得出来');
  ok(!st.check('灯是灭的。').dup, 'F2 没说过的不算');
  ok(!st.check('').dup, 'F3 空话不查');

  /* 他的话说得一模一样不算重复：她可以说"把灯关了"以外的话，
   * 但重复**他**的话是另一回事（复读他的话本身是正常的）。 */
  ok(!st.check('把灯关了').dup, 'F4 只和她自己的话比，不和他比');

  const note = st.repromptFor('好，灯关了。', '好，灯关了。');
  ok(typeof note === 'string' && note.includes('换一种说法'), 'F5 重问会告诉她怎么办', String(note));
  ok(!/重复/.test(note), 'F6 重问里不出现"重复"两个字（写了等于递到她嘴边）', String(note));

  eq(st.repromptFor('好，灯关了。', '好，灯关了。'), null, 'F7 一轮只重问一次（松手就是死循环）');
  st.begin();
  ok(st.repromptFor('好，灯关了。', '好，灯关了。') !== null, 'F8 新一轮重新可以问');

  evs.push({ who: 'fish', kind: 'said', text: '灯是灭的。' });
  ok(st.recent().includes('灯是灭的。'), 'F9 记住的是最新那句');
  ok(!st.recent().includes('把灯关了'), 'F10 他的不进她的原话池');

  ok(st.describe().includes('平均'), 'F11 describe 能说清现状', st.describe());
}

/* ---------------- G. 把话切段 ---------------- */

console.log('\nG. 停顿真的停');

{
  eq(splitScript('好。【停】不过你怕黑。'), [
    { text: '好。', pauseBefore: 0 },
    { text: '不过你怕黑。', pauseBefore: 600 },
  ], 'G1 标记处切开，后面那段带着停顿');

  eq(splitScript('平常一句。'), [{ text: '平常一句。', pauseBefore: 0 }], 'G2 没标记还是一段');
  eq(splitScript(''), [], 'G3 空话不产生段');
  eq(splitScript('【停】'), [], 'G4 只有标记不产生段（否则她会安静地张一下嘴）');

  eq(splitScript('【停】我记着呢。')[0].pauseBefore, 600, 'G5 开头就停也认');
  eq(splitScript('说完了。【停】')[0].pauseBefore, 0, 'G6 结尾的标记不占时间（后面没话了）');
  eq(splitScript('说完了。【停】').length, 1, 'G7 结尾的标记不该多出一段空的');

  const two = splitScript('a。【停】【停】b。');
  eq(two[1].pauseBefore, 1200, 'G8 连着两个标记就停两倍（不是只认一个）');

  eq(stripScript('好。【停】灯关了。'), '好。灯关了。', 'G9 字幕上不出现标记');

  /* 字幕和声音必须同源：切出来的段拼回去要等于原来的话（只差标记）。 */
  const t = '一。【停】二。【停】三。';
  eq(splitScript(t).map(p => p.text).join(''), stripScript(t), 'G10 切段不吞字');
}

console.log(fail ? `\n${fail} 条不过，${pass} 条通过` : `\n全部通过：${pass} 条`);
process.exit(fail ? 1 : 0);
