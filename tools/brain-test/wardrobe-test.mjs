/* 衣柜：分层、能穿、穿不上要说清楚
 * ------------------------------------------------------------
 * 这组断言不测"好不好看"，测四件事：
 *   A  装不上的件当场拦住（缺图、缺骨名、骨架不对）
 *   B  一个槽一件、饰品有上限、换就是替换不是叠加
 *   C  交出去的只有"穿什么"，没有渲染细节；不会换的身体如实说
 *   D  从一张图生成的那条路，默认值能直接穿上
 *
 * 跑：node tools/brain-test/wardrobe-test.mjs
 */

import { createWardrobe, fromImage, validateManifest, loadWardrobe,
         SLOTS, SLOT_DEFAULTS, MAX_ACCESSORIES } from '../../js/brain/wardrobe.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name,
  `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

const item = (over = {}) => ({
  schemaVersion: 1, id: 'tee', name: '白T', slot: 'top', mode: 'overlay',
  files: { image: 'layer.png' },
  anchor: { bone: 'chest', offset: [0, 0, 0.1], scale: [0.4, 0.4, 1] },
  z: 8, author: 'a', license: 'CC0', source: 'image',
  ...over,
});

console.log('\nA. 装不上的，当场拦住');

{
  const v = validateManifest(item());
  ok(v.ok, 'A1 一份完整的 overlay 能过');
  eq(v.warns, [], 'A2 授权和作者都写了，就没有提醒');
}

{
  const v = validateManifest(item({ name: '' }));
  ok(!v.ok && v.errs.some(e => e.includes('name')), 'A3 没名字不行（提示词里要用）');
  const v2 = validateManifest(item({ slot: 'hat' }));
  ok(!v2.ok && v2.errs.some(e => e.includes('slot')), 'A4 槽位只能是那六个');
  const v3 = validateManifest(item({ files: {} }));
  ok(!v3.ok && v3.errs.some(e => e.includes('files.image')), 'A5 overlay 没图不行');
  const v4 = validateManifest(item({ anchor: { scale: [1, 1, 1] } }));
  ok(!v4.ok && v4.errs.some(e => e.includes('anchor.bone')), 'A6 overlay 不知道挂哪根骨头不行');
  const v5 = validateManifest(item({ mode: 'mesh', files: {} }));
  ok(!v5.ok && v5.errs.some(e => e.includes('files.mesh')), 'A7 mesh 没网格不行');
  const v6 = validateManifest(item({ mode: 'texture', files: { texture: 'a.png' }, target: '' }));
  ok(!v6.ok && v6.errs.some(e => e.includes('target')), 'A8 texture 不知道换哪块材质不行');
}

{
  const v = validateManifest(item({ files: { image: 'layer.jpg' } }));
  ok(v.ok, 'A9 jpg 能装（不是硬错）');
  ok(v.warns.some(w => w.includes('透明')), 'A10 但要提醒它没有透明通道');
  const v2 = validateManifest(item({ license: '', author: '' }));
  ok(v2.ok, 'A11 没写授权也能装');
  ok(v2.warns.length >= 2, 'A12 但两条都要提醒');
}

console.log('\nB. 一个槽一件，饰品有上限');

{
  const w = createWardrobe({ skeleton: 'fish-vrm', kind: 'vrm' });
  w.add(item());
  w.add(item({ id: 'shirt2', name: '蓝衬衫', slot: 'top' }));
  w.add(item({ id: 'jeans', name: '牛仔裤', slot: 'bottom' }));
  eq(w.list('top').length, 2, 'B1 同一个槽可以有好几件备选');
  eq(w.wearing().length, 0, 'B2 注册不等于穿上');

  eq(w.equip('tee').ok, true, 'B3 能穿');
  eq(w.equip('shirt2').ok, true, 'B4 换一件同槽的');
  eq(w.wearing().map(m => m.id), ['shirt2'], 'B5 换就是替换，不是叠两件');
  eq(w.equipped('top').map(m => m.id), ['shirt2'], 'B6 槽里只剩新的');
}

{
  const w = createWardrobe({ skeleton: 'fish-vrm', kind: 'vrm' });
  for (let i = 0; i < MAX_ACCESSORIES; i++) {
    w.add(item({ id: 'a' + i, name: '饰品' + i, slot: 'accessory' }));
    eq(w.equip('a' + i).ok, true, `B7 第 ${i + 1} 件饰品能戴`);
  }
  w.add(item({ id: 'a9', name: '戴不下的', slot: 'accessory' }));
  const r = w.equip('a9');
  eq(r.ok, false, 'B8 第五件戴不上');
  eq(r.reason, 'too_many_accessories', 'B9 原因写清楚');
}

{
  const w = createWardrobe({ skeleton: 'fish-vrm', kind: 'vrm' });
  w.add(item({ requires: { skeleton: 'other-rig' } }));
  const r = w.equip('tee');
  eq(r.ok, false, 'B10 骨架不对不让穿');
  eq(r.reason, 'skeleton_mismatch', 'B11 不是"没有这件"，是骨架不对');
  ok(/other-rig/.test(r.message) && /fish-vrm/.test(r.message), 'B12 两个骨架都点名，能查');
}

{
  const w = createWardrobe({ skeleton: 'fish-vrm', kind: 'vrm' });
  w.add(item({ requires: { skeleton: 'fish-vrm' } }));
  w.equip('tee');
  w.setSkeleton('robot-rig', 'mmd');
  eq(w.wearing().length, 0, 'B13 换骨架后，要求旧骨架的件自己脱下来');
  ok(w.log().some(x => x.op === 'unequip'), 'B14 脱下来要留痕，不静默');
}

console.log('\nC. 交出去的只有"穿什么"');

{
  const w = createWardrobe({ skeleton: 'fish-vrm', kind: 'vrm' });
  w.add(item());
  w.add(item({ id: 'scarf', name: '红围巾', slot: 'accessory' }));
  w.equip('tee'); w.equip('scarf');
  const c = w.compose();
  eq(c.skeleton, 'fish-vrm', 'C1 组合里带骨架 id（后端要换身体时用）');
  eq(c.items.map(i => i.id), ['tee', 'scarf'], 'C2 顺序按槽位固定');
  ok(c.key.includes('top:tee') && c.key.includes('accessory:scarf'), 'C3 key 稳定，能当缓存键');
  ok(!('canvas' in c), 'C4 组合里没有渲染对象');
  ok(c.items[0].anchor && c.items[0].anchor.bone === 'chest', 'C5 挂点参数跟着走（这是内容，不是大脑协议）');
}

{
  const w = createWardrobe({ skeleton: 'fish-vrm', kind: 'vrm' });
  w.add(item());
  const a = w.applyTo(null);
  eq(a.ok, false, 'C6 没有身体就不能换装');
  eq(a.reason, 'no_backend', 'C7 如实说，不假装换过');

  const noCap = { can: () => false, setOutfit: () => { throw new Error('不该被调到'); } };
  const b = w.applyTo(noCap);
  eq(b.reason, 'unsupported', 'C8 身体声明不会换装，就不硬调');

  let got = null;
  const av = { can: () => true, setOutfit: (key, opt) => { got = { key, opt }; return { ok: true, via: 'vrm' }; } };
  w.equip('tee');
  const c = w.applyTo(av);
  eq(c.ok, true, 'C9 会换装的身体收到组合');
  eq(got.key, w.compose().key, 'C10 传的是 key');
  eq(got.opt.layers.map(x => x.id), ['tee'], 'C11 传的是层，不是一句话');
}

{
  const w = createWardrobe({ skeleton: 'fish-vrm', kind: 'vrm' });
  w.add(item());
  eq(w.entities(), [{ id: 'outfit:tee', kind: 'outfit', label: '白T（上衣）' }], 'C12 可穿的件能进实体表（id 带 outfit:）');
  eq(w.describe(), '你现在穿的是身体自带的那套。还能换：上衣。', 'C13 没穿时说得清楚，只列真有的槽');
  w.equip('tee');
  ok(w.describe().includes('白T'), 'C14 穿了什么会说');
}

{
  const w = createWardrobe({ skeleton: 'fish-vrm', kind: 'vrm' });
  w.add(item());
  w.equip('tee');
  w.remove('tee');
  eq(w.wearing().length, 0, 'C15 删掉一件，身上也不会留着一个空槽');
}

console.log('\nD. 有图就能生成');

{
  const m = fromImage({ name: '我的围巾', slot: 'accessory', image: 'layer.png', skeleton: 'fish-vrm' });
  eq(m.mode, 'overlay', 'D1 默认是最便宜的 overlay');
  eq(m.anchor.bone, SLOT_DEFAULTS.accessory.bone, 'D2 骨名有默认值');
  ok(validateManifest(m).ok, 'D3 默认值直接能过校验');
  const w = createWardrobe({ skeleton: 'fish-vrm', kind: 'vrm' });
  w.add(m);
  eq(w.equip(m.id).ok, true, 'D4 生成完就能穿');
}

{
  const m = fromImage({ name: '头发', slot: 'hair', image: 'hair.png', scale: [0.3, 0.3, 1] });
  eq(m.anchor.bone, 'head', 'D5 发型默认挂头');
  eq(m.z, 20, 'D6 发型在最外层（不然会被上衣盖住）');
}

console.log('\nE. 读目录：坏一件不拖垮全部');

{
  const files = {
    'assets/wardrobe/index.json': JSON.stringify({ schemaVersion: 1, skeleton: 'fish-vrm', kind: 'vrm', items: ['items/tee/manifest.json', 'items/bad/manifest.json'] }),
    'assets/wardrobe/items/tee/manifest.json': JSON.stringify(item()),
    'assets/wardrobe/items/bad/manifest.json': JSON.stringify({ id: 'bad' }),
  };
  const fetchImpl = async (url) => {
    const key = String(url).replace(/^\.?\//, '');
    if (!(key in files)) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => JSON.parse(files[key]) };
  };
  const r = await loadWardrobe({ base: 'assets/wardrobe/', fetchImpl });
  eq(r.loaded, 1, 'E1 好的那件读进来了');
  eq(r.problems.length, 1, 'E2 坏的那件被记下来，不是整体失败');
  ok(r.problems[0].file.includes('bad'), 'E3 问题指到具体文件，能修');
  eq(r.wardrobe.ids(), ['tee'], 'E4 衣柜里只有能用的');
  eq(r.wardrobe.skeleton.id, 'fish-vrm', 'E5 骨架从目录里读到');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
