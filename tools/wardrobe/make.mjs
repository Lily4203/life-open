/* 有图就能生成：把一张去底的图变成一件能穿的东西
 * ------------------------------------------------------------
 * 用法：
 *   node tools/wardrobe/make.mjs --image 我的围巾.png --slot accessory --name 红围巾
 *   node tools/wardrobe/make.mjs --image tee.png --slot top --name 白T \
 *        --bone chest --scale 0.42,0.467 --offset 0,0.03,0.075
 *
 * 它只做四件事：拷图 → 生成 manifest → 校验 → 写进 index.json。
 * 不抠图、不改图——抠背景是 衣柜-导入.html 干的（那边有画布）。
 *
 * 为什么不用 npm 包：这个项目零依赖。一个换装工具不值得为它引一棵依赖树。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWardrobe, fromImage, validateManifest, SLOTS, SLOT_DEFAULTS } from '../../js/brain/wardrobe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const WARDROBE = path.join(ROOT, 'assets', 'wardrobe');
const INDEX = path.join(WARDROBE, 'index.json');

function usage() {
  console.log(`衣柜导入：把一张图变成一件能穿的东西

  --image <路径>        必填。去底的 PNG / WebP（复杂背景请先自己抠）
  --slot <槽>           必填。${SLOTS.join(' / ')}
  --name <名字>         必填。提示词里用的名字
  --id <id>             可选。小写字母/数字/_/-；不填就从名字或时间生成
  --bone <骨名>         可选。默认按槽位（见下表）
  --offset x,y,z        可选。相对骨头的偏移，单位米
  --scale  w,h          可选。图在身上的实际宽高，单位米
  --skeleton <id>       可选。默认 fish-vrm
  --kind <vrm|live2d>   可选。默认 vrm
  --author / --license  可选，但强烈建议写
  --dry                 只打印，不写文件

默认挂点：
${Object.entries(SLOT_DEFAULTS).map(([k, v]) =>
  `  ${k.padEnd(10)} bone=${v.bone.padEnd(7)} offset=${v.offset.join(',')}  scale=${v.scale.slice(0, 2).join(',')}`
).join('\n')}

例：
  node tools/wardrobe/make.mjs --image ~/Desktop/scarf.png --slot accessory --name 红围巾
`);
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (k === 'help' || k === 'dry') { out[k] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { out[k] = true; continue; }
    out[k] = v; i++;
  }
  return out;
}

const num3 = (s, name) => {
  if (!s) return null;
  const a = String(s).split(',').map(x => Number(x.trim()));
  if (a.length !== 3 || a.some(n => !Number.isFinite(n))) {
    console.error(`--${name} 要三个数字，用逗号隔开，比如 0,0.1,0.05。收到：${s}`);
    process.exit(2);
  }
  return a;
};

const slugify = (s) => String(s || '').toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const a = args(process.argv.slice(2));
if (a.help || (!a.image && !a.slot)) { usage(); process.exit(a.help ? 0 : 2); }

if (!a.image) { console.error('缺 --image'); process.exit(2); }
if (!SLOTS.includes(a.slot)) { console.error(`--slot 只能是 ${SLOTS.join('/')}，收到：${a.slot}`); process.exit(2); }
if (!a.name) { console.error('缺 --name：名字会进提示词，不能不填'); process.exit(2); }

const src = path.resolve(String(a.image).replace(/^~(?=$|\/)/, process.env.HOME || process.env.USERPROFILE || '~'));
if (!fs.existsSync(src)) { console.error('找不到这张图：' + src); process.exit(2); }

const ext = path.extname(src).toLowerCase();
if (!['.png', '.webp', '.svg', '.jpg', '.jpeg'].includes(ext)) {
  console.error('只认 png / webp / svg / jpg。收到：' + ext);
  process.exit(2);
}
if (['.jpg', '.jpeg'].includes(ext)) console.warn('  ! JPG 没有透明通道，贴上去会是一块方图。建议先去底转 PNG。');

const id = a.id || slugify(a.name) || `item-${Date.now().toString(36)}`;
if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) {
  console.error(`--id 只能用 a-z 0-9 _ -，最长 48。收到：${id}`);
  process.exit(2);
}

const file = 'layer' + (ext === '.jpeg' ? '.jpg' : ext);
const dir = path.join(WARDROBE, 'items', id);

const m = fromImage({
  id, name: a.name, slot: a.slot,
  image: file,
  skeleton: a.skeleton === undefined ? 'fish-vrm' : (a.skeleton || null),
  kind: a.kind === undefined ? 'vrm' : (a.kind || null),
  bone: a.bone || null,
  offset: num3(a.offset, 'offset'),
  scale: num3(a.scale, 'scale'),
  author: a.author || '',
  license: a.license || '',
});
m.thumbnail = file;

const v = validateManifest(m);
if (!v.ok) {
  console.error('生成失败：\n  ' + v.errs.join('\n  '));
  process.exit(1);
}
if (v.warns.length) { console.log('提醒：'); for (const w of v.warns) console.log('  · ' + w); }

console.log('\n这件会是这样：');
console.log('  id      ' + m.id);
console.log('  名字    ' + m.name + '（' + m.slot + ' / ' + m.mode + '）');
console.log('  挂点    bone=' + m.anchor.bone + '  offset=' + m.anchor.offset.join(',') + '  scale=' + m.anchor.scale.slice(0, 2).join(','));
console.log('  文件    ' + path.join('items', id, file));
console.log('  骨架    ' + (m.requires.skeleton || '不限'));

if (a.dry) { console.log('\n--dry：什么都没写。\n'); process.exit(0); }

fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(src, path.join(dir, file));
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n', 'utf8');

/* 索引：保留原有的 _说明 和顺序，只追加没有的 */
let index = { schemaVersion: 1, skeleton: 'fish-vrm', kind: 'vrm', items: [] };
try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { /* 第一件 */ }
index.schemaVersion = index.schemaVersion || 1;
index.skeleton = index.skeleton || 'fish-vrm';
index.kind = index.kind || 'vrm';
index.items = Array.isArray(index.items) ? index.items : [];
const rel = `items/${id}/manifest.json`;
if (!index.items.includes(rel)) index.items.push(rel);
fs.writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n', 'utf8');

/* 用衣柜自己的校验再验一次：文件在不在、能不能穿上。
 * 只写文件不验证，等于把错误留给下次打开页面的人。 */
const w = createWardrobe({ skeleton: index.skeleton, kind: index.kind });
for (const p of index.items) {
  try {
    const mm = JSON.parse(fs.readFileSync(path.join(WARDROBE, p), 'utf8'));
    w.add(mm, { dir: path.dirname(path.join(WARDROBE, p)) + '/' });
  } catch (e) { console.warn('  ! 跳过 ' + p + '：' + e.message); }
}
const eq = w.equip(id);

console.log('\n写好了：');
console.log('  ' + path.join(dir, file));
console.log('  ' + path.join(dir, 'manifest.json'));
console.log('  ' + INDEX + '（已加入）');
console.log('\n能穿上吗：' + (eq.ok ? '能' : '不能——' + eq.message));
console.log('\n下一步：打开 预览-66.html，控制台敲');
console.log(`  __WARDROBE.equip('${id}')`);
console.log('位置不对就改 manifest 里的 anchor.offset / anchor.scale，不用重新导图。\n');
