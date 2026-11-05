/* 她可以不接（沉默是一种回法）
 * ============================================================
 * 起因：把 8 句真群聊灌进去，她合成一批、回了一轮。
 * 当时看着没问题，但再灌一次就露了——群里两个人聊吃的，她也要凑一句。
 * 不是她话多，是**没人告诉她这可以不说**：格式那一段写着"每一句都必须是 json"，
 * chat-in 又是每批都叫醒她，于是"有人说话 → 她开口"变成了默认。
 *
 * 这个文件钉五件事：
 *   ① 提示词里真的给了许可（不是我们以为给了）
 *   ② say 空 + do 空 = 成立的一轮（quiet），不是失败、不是 blank
 *   ③ 不接的时候，记忆里没有一条她说过的话（"没接"不能变成"她说了一句空话"）
 *   ④ 他本人说话时她照样能回（许可不是让她从此闭嘴）
 *   ⑤ 动了手但没说话，不算沉默（quiet 只看 say 和 do，不看别的）
 *
 * 跑：node tools/brain-test/quiet-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemory } from '../../js/brain/memory.mjs';
import { createLoop } from '../../js/brain/loop.mjs';
import { nodeStore } from '../../js/brain/store-node.mjs';

/* 路径从本文件算，不从 cwd 算：run-all 是在哪个目录被敲的不一定，
 * 上一版写 process.cwd()，从 tools/brain-test 里跑就直接找不到 identity.md。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const DIR = path.join(ROOT, '_tmp', 'quiet');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
/* 有她的数据就用她本人的，没有就用示例。
 * 开源版里没有 data/ —— 一个新人 clone 下来就红，红的不是代码，是他的目录还没建。 */
const IDENT = path.join(ROOT, 'data', 'identity.md');
fs.copyFileSync(fs.existsSync(IDENT) ? IDENT : path.join(ROOT, 'data.example', 'identity.md'),
  path.join(DIR, 'identity.md'));

let pass = 0, fail = 0;
const ok = (v, n, d = '') => { if (v) pass += 1; else { fail += 1; console.log(`  ✗ ${n}${d ? '：' + d : ''}`); } };

function rig(answer) {
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
  const box = { systems: [], calls: 0 };
  const chat = async ({ system }) => {
    box.calls += 1;
    box.systems.push(system);
    return { content: JSON.stringify(answer) };
  };
  return { memory, registry, loop: createLoop({ memory, registry, chat }), box };
}

/* ---- A. 提示词里有没有这句许可 ---- */
{
  const { loop, box } = rig({ say: '', do: [] });
  await loop.turn({ text: '随便看看' });
  const sys = String(box.systems[0] || '');
  ok(sys.includes('不是每句话都要接'), 'A1 提示词给了"可以不接"的许可');
  ok(sys.includes('那句要回'), 'A2 但明确了他本人说话要回（许可不是闭嘴）');
  ok(sys.includes('"say"'), 'A3 JSON 的格式要求还在（没被这句挤掉）');
}

/* ---- B. 群友说话，她选择不接 ---- */
{
  const { loop, memory, box } = rig({ say: '', do: [] });
  const heard = loop.hear({ text: '天津糕条', from: 'guest:1144894914', name: 'Edison lv', source: 'group' });
  ok(heard.heard, 'B1 话先落盘（收下 ≠ 要回，但一定要收下）');

  const r = await loop.turn({ text: '', heard: true });
  ok(r.ok === true, 'B2 这一轮是成立的，不是失败');
  ok(r.quiet === true, 'B3 标记成 quiet（页面能说"她听见了，没接"）', JSON.stringify(r.quiet));
  ok(r.say === '' && (r.do || []).length === 0, 'B4 没有说话也没有动作');
  ok(box.calls === 1, 'B5 没有重发、没有重问（沉默不是格式错）', String(box.calls));

  const mine = memory.events().filter(e => e.kind === 'said' && e.who === 'fish');
  ok(mine.length === 0, 'B6 记忆里没有一条她说的话（没接不该留一句空话）', String(mine.length));
  const guest = memory.events().filter(e => e.kind === 'said' && e.who === 'guest:1144894914');
  ok(guest.length === 1, 'B7 群友那句还在（她没接，但听见了）', String(guest.length));

  const st = loop.stats();
  ok(st.quietChat === 1, 'B8 记成 quietChat 一次', String(st.quietChat));
  /* 这条最容易错：空白被当成"上游把话吃了"，会去重发。
   * 但 {"say":""} 是拿到了、就是空的——两件事混在一起，她的沉默会被当成故障修。 */
  ok(st.blanks === 0, 'B9 沉默不算 blank（blank 是没拿到字）', String(st.blanks));
}

/* ---- C. 他说话，她照常回 ---- */
{
  const { loop, memory, box } = rig({ say: '在。', do: [] });
  const r = await loop.turn({ text: '在吗' });
  ok(r.ok && !r.quiet, 'C1 他说话时不接才是不正常，这里照常回');
  ok(r.say === '在。', 'C2 话原样出来', r.say);
  ok(box.calls === 1, 'C3 一次就成');
  const mine = memory.events().filter(e => e.kind === 'said' && e.who === 'fish');
  ok(mine.length === 1 && mine[0].text === '在。', 'C4 她说的话落了盘', JSON.stringify(mine.map(m => m.text)));
}

/* ---- D. 动了手但没说话：不算沉默 ---- */
{
  const { loop } = rig({ say: '', do: [{ do: 'nod', to: 'chair:1' }] });
  const r = await loop.turn({ text: '点个头' });
  ok(r.ok === true, 'D1 只有动作的一轮也成立');
  ok(r.quiet === false, 'D2 她动了，不算"没接"', String(r.quiet));
  ok(loop.stats().quietChat === 0, 'D3 不计入 quietChat');
}

console.log(fail ? `\n${fail} 条不过，${pass} 条通过` : `\n全部通过：${pass} 条`);
process.exit(fail ? 1 : 0);
