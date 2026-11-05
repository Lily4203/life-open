/* 衣柜：骨架是骨架，身体是身体，穿在身上的又是一层
 * ------------------------------------------------------------
 * 为什么单独一个文件：
 *   换装不是"再加载一个模型"。它是一个**分层**问题：
 *     骨架（skeleton）—— 骨头、朝向、动画，换一次整套都要重新绑
 *     身体（body）    —— 皮肤、体型、脸，挂在骨架上
 *     穿戴（wear）    —— 发型、上衣、下装、鞋、饰品，挂在身体外面
 *   三层混在一起，就会出现"换件衣服要把骨骼也重导一遍"。
 *
 * 两条路，门槛不一样：
 *   ① 有图就能生成 —— 一张去底的图 + 一个骨名 + 大小，挂上去就是一件（mode: overlay）。
 *      这条是给"会画但不会建模"的人走的，也是她自己换装最便宜的一条。
 *   ② 会做的人直接导入 —— GLB 网格 / 贴图（mode: mesh / texture），带自己的绑定。
 *
 * 这个文件里允许出现几何量（bone / offset / scale）——**只在这一层允许**。
 * 理由：这是内容的美术参数，不是大脑的协议。大脑永远只说"换 outfit:scarf-red"，
 * 它不知道也不该知道围巾挂在胸骨前 6 厘米。
 *
 * 这个文件不碰渲染、不碰 canvas、不碰网络。怎么把层贴到模型上是显示后端的事。
 */

export const SCHEMA_VERSION = 1;

/* 六个槽。除了饰品，每个槽同时只能穿一件（换 = 替换，不是叠加）。
 * body 也在里面：身体是可以换的，但骨架不跟着换。 */
export const SLOTS = ['body', 'hair', 'top', 'bottom', 'shoes', 'accessory'];

export const SLOT_ZH = {
  body: '身体', hair: '发型', top: '上衣', bottom: '下装', shoes: '鞋', accessory: '饰品',
};

export const MODES = ['overlay', 'mesh', 'texture'];

export const MAX_ACCESSORIES = 4;

/* 每个槽的默认挂点。这些值不是标准，是"先能用"：
 * 有图的人拖一下滑块就能改；会做的人自己写 anchor。
 * 单位是米（和 VRM 的世界单位一致），scale 是图片贴在平面上的宽高。 */
export const SLOT_DEFAULTS = {
  hair:      { bone: 'head',  offset: [0, 0.10, 0.015], scale: [0.26, 0.24, 1] },
  top:       { bone: 'chest', offset: [0, 0.10, 0.075], scale: [0.40, 0.34, 1] },
  bottom:    { bone: 'hips',  offset: [0, -0.04, 0.055], scale: [0.34, 0.30, 1] },
  shoes:     { bone: 'hips',  offset: [0, -0.45, 0.03], scale: [0.30, 0.14, 1] },
  accessory: { bone: 'chest', offset: [0, 0.12, 0.07], scale: [0.30, 0.16, 1] },
  body:      { bone: 'hips',  offset: [0, 0, 0], scale: [0.5, 0.9, 1] },
};

/* 头像/封面那种 2D 后端没有骨名，用 slot 当锚点。 */
export const ANCHOR_2D = {
  hair: { name: 'head', x: 0.5, y: 0.16, w: 0.5, h: 0.34 },
  top: { name: 'chest', x: 0.5, y: 0.45, w: 0.56, h: 0.32 },
  bottom: { name: 'hips', x: 0.5, y: 0.66, w: 0.5, h: 0.24 },
  shoes: { name: 'feet', x: 0.5, y: 0.90, w: 0.44, h: 0.12 },
  accessory: { name: 'chest', x: 0.5, y: 0.40, w: 0.4, h: 0.2 },
  body: { name: 'body', x: 0.5, y: 0.5, w: 0.8, h: 0.9 },
};

const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const arr3 = v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(Number(n)));

/* 校验只做两件事：拦住"装上去一定出错"的，记下"能装但可能不好看"的。
 * 后者不抛错——美术参数没有对错，只有试出来的好看。 */
export function validateManifest(m) {
  const errs = [], warns = [];
  if (!isObj(m)) return { ok: false, errs: ['manifest 必须是一个对象'], warns };
  if (Number(m.schemaVersion) !== SCHEMA_VERSION) errs.push(`schemaVersion 必须是 ${SCHEMA_VERSION}`);
  if (!m.id || !SLUG.test(String(m.id))) errs.push('id 只能是 a-z 0-9 _ -，最长 48（它要进动作参数）');
  if (!m.name || !String(m.name).trim()) errs.push('name 不能空（提示词里用的是这个名字）');
  if (!SLOTS.includes(m.slot)) errs.push(`slot 只能是 ${SLOTS.join('/')}`);
  if (!MODES.includes(m.mode)) errs.push(`mode 只能是 ${MODES.join('/')}`);

  const files = isObj(m.files) ? m.files : {};
  if (m.mode === 'overlay') {
    if (!files.image) errs.push('overlay 需要 files.image（一张去底的图）');
    if (!isObj(m.anchor) || !String(m.anchor.bone || '').trim())
      errs.push('overlay 需要 anchor.bone（挂在哪根骨头上；不知道就填 chest）');
    if (m.anchor && !arr3(m.anchor.scale)) errs.push('anchor.scale 是 [宽,高,1]，单位米');
    if (m.anchor && m.anchor.offset != null && !arr3(m.anchor.offset)) errs.push('anchor.offset 是 [x,y,z]');
    if (m.anchor && m.anchor.rotation != null && !arr3(m.anchor.rotation)) errs.push('anchor.rotation 是 [x,y,z]（弧度）');
  }
  if (m.mode === 'mesh') {
    if (!files.mesh) errs.push('mesh 需要 files.mesh（.glb / .gltf）');
  }
  if (m.mode === 'texture') {
    if (!files.texture) errs.push('texture 需要 files.texture（贴图）');
    if (!m.target || !String(m.target).trim()) errs.push('texture 需要 target：换哪块材质的贴图（材质名）');
  }

  if (m.requires && !isObj(m.requires)) errs.push('requires 必须是对象');
  if (m.requires?.skeleton && !String(m.requires.skeleton).trim()) errs.push('requires.skeleton 不能空');
  if (m.z != null && !Number.isFinite(Number(m.z))) errs.push('z 必须是数字（同一层内的前后顺序）');

  if (!m.license) warns.push('没写 license：别人拿到这份内容时不知道能不能用');
  if (!m.author) warns.push('没写 author：三个月后没人知道这是谁做的');
  if (m.mode === 'overlay' && files.image && /\.jpe?g$/i.test(files.image))
    warns.push('jpg 没有透明通道，贴上去会是一块方图；建议 PNG/WebP');
  if (m.slot === 'accessory' && !m.cover) warns.push('饰品没写 cover（front/back）：2D 后端只能挂正面');

  return { ok: errs.length === 0, errs, warns };
}

export function createWardrobe({ skeleton = null, kind = null, now = () => Date.now() } = {}) {
  const items = new Map();
  let skel = skeleton ? { id: String(skeleton), kind: kind || null } : null;
  const worn = new Map();          // slot -> id | id[]（只有 accessory 是数组）
  const log = [];

  const warn = (w, id) => log.push({ at: now(), op: 'warn', id, warns: w });

  /* 注册一件。重名覆盖（热重载会重复注册，抛错等于刷新就崩）。 */
  function add(m, { dir = '' } = {}) {
    const v = validateManifest(m);
    if (!v.ok) {
      const e = new Error(`这件「${m?.name || m?.id || '?'}」装不上：${v.errs.join('；')}`);
      e.code = 'bad_manifest';
      e.errs = v.errs;
      throw e;
    }
    if (v.warns.length) warn(v.warns, m.id);
    const existed = items.has(m.id);
    const item = { ...m, __dir: dir || m.__dir || '' };
    items.set(m.id, item);
    log.push({ at: now(), op: existed ? 'replace' : 'add', id: m.id, slot: m.slot });
    // 正在穿的被替换了：槽位保留，内容换成新的
    if (worn.get(m.slot) === m.id) worn.set(m.slot, m.id);
    return item;
  }

  function remove(id) {
    const it = items.get(id);
    if (!it) return false;
    items.delete(id);
    for (const [slot, v] of worn) {
      if (v === id) worn.delete(slot);
      else if (Array.isArray(v) && v.includes(id)) worn.set(slot, v.filter(x => x !== id));
    }
    log.push({ at: now(), op: 'remove', id });
    return true;
  }

  const get = id => items.get(id) || null;
  const list = slot => [...items.values()].filter(m => !slot || m.slot === slot);
  const ids = () => [...items.keys()];

  function setSkeleton(id, k = null) {
    skel = id ? { id: String(id), kind: k || skel?.kind || null } : null;
    // 骨架变了，之前那套要求别的骨架的就脱下来（不静默留着，会穿在错误的骨头上）
    for (const [slot, v] of [...worn]) {
      const arr = Array.isArray(v) ? v : [v];
      for (const id2 of arr) {
        const req = items.get(id2)?.requires?.skeleton;
        if (req && req !== skel?.id) unequip(id2);
      }
    }
    return skel;
  }

  /* 穿。返回 ok + 为什么不成，不抛——"这件配不上这具身体"是正常的失败，不是崩溃。 */
  function equip(id) {
    const m = items.get(id);
    if (!m) return { ok: false, reason: 'no_such_item', message: `没有「${id}」这件` };
    if (m.requires?.skeleton && skel?.id && m.requires.skeleton !== skel.id)
      return { ok: false, reason: 'skeleton_mismatch',
               message: `这是给「${m.requires.skeleton}」的，你现在这具身体是「${skel.id}」` };
    const reqKind = m.requires?.kind;
    if (reqKind && skel?.kind && reqKind !== skel.kind)
      return { ok: false, reason: 'kind_mismatch', message: `这是 ${reqKind} 用的，你这具身体是 ${skel.kind}` };

    if (m.slot === 'accessory') {
      const cur = Array.isArray(worn.get('accessory')) ? worn.get('accessory') : [];
      if (cur.includes(id)) return { ok: true, already: true, slot: 'accessory', id };
      if (cur.length >= MAX_ACCESSORIES)
        return { ok: false, reason: 'too_many_accessories', message: `最多同时戴 ${MAX_ACCESSORIES} 件饰品` };
      worn.set('accessory', [...cur, id]);
    } else {
      worn.set(m.slot, id);
    }
    log.push({ at: now(), op: 'equip', id, slot: m.slot });
    return { ok: true, slot: m.slot, id };
  }

  function unequip(slotOrId) {
    const m = items.get(slotOrId);
    const slot = m ? m.slot : slotOrId;
    if (!worn.has(slot)) {
      if (m) {
        const cur = Array.isArray(worn.get('accessory')) ? worn.get('accessory') : [];
        if (cur.includes(m.id)) { worn.set('accessory', cur.filter(x => x !== m.id)); return true; }
      }
      return false;
    }
    if (slot === 'accessory' && m) {
      const cur = Array.isArray(worn.get('accessory')) ? worn.get('accessory') : [];
      if (!cur.includes(m.id)) return false;
      worn.set('accessory', cur.filter(x => x !== m.id));
      return true;
    }
    worn.delete(slot);
    log.push({ at: now(), op: 'unequip', slot });
    return true;
  }

  const equipped = slot => {
    const v = worn.get(slot);
    if (!v) return [];
    return (Array.isArray(v) ? v : [v]).map(id => items.get(id)).filter(Boolean);
  };

  function wearing() {
    const out = [];
    for (const slot of SLOTS) for (const m of equipped(slot)) out.push(m);
    return out;
  }

  /* 组合：这是要交给显示后端的唯一东西。
   * key 稳定，后端可以拿它当缓存键；layers 带完整的挂点参数，后端不需要再读文件。 */
  function compose() {
    const w = wearing();
    return {
      skeleton: skel?.id || null,
      kind: skel?.kind || null,
      items: w.map(m => ({
        id: m.id, name: m.name, slot: m.slot, mode: m.mode,
        files: { ...(m.files || {}) }, dir: m.__dir || '',
        anchor: m.anchor ? { ...m.anchor } : null,
        target: m.target || null, z: Number(m.z) || 0,
      })),
      key: [skel?.id || 'no-skel', ...SLOTS.map(s => equipped(s).map(m => `${s}:${m.id}`).join('+')).filter(Boolean)].join('|'),
    };
  }

  /* 给提示词的一句话。只说"现在穿着什么、还能换什么"，
   * 不列参数——她不需要知道围巾挂在哪根骨头上。 */
  function describe() {
    const w = wearing();
    const parts = w.map(m => m.name);
    const can = SLOTS.filter(s => list(s).some(m => !wornIdSet().has(m.id)));
    const nowText = parts.length ? `你现在穿的是：${parts.join('、')}。` : '你现在穿的是身体自带的那套。';
    const canText = can.length ? `还能换：${can.map(s => SLOT_ZH[s]).join('、')}。` : '暂时没有别的可换。';
    return nowText + canText;
  }

  const wornIdSet = () => new Set(wearing().map(m => m.id));

  /* 把当前这套交给身体。不会换就如实说，不假装换过。 */
  function applyTo(avatar) {
    if (!avatar || typeof avatar.setOutfit !== 'function')
      return { ok: false, reason: 'no_backend', message: '这具身体不能换装' };
    if (avatar.can && !avatar.can('outfit'))
      return { ok: false, reason: 'unsupported', message: '这具身体不能换装' };
    const c = compose();
    return avatar.setOutfit(c.key, { layers: c.items, skeleton: c.skeleton, kind: c.kind });
  }

  /* 给提示词里的"这屋里现在有什么"用：id 形状必须能过实体校验。 */
  function entities() {
    return list().map(m => ({ id: `outfit:${m.id}`, kind: 'outfit', label: `${m.name}（${SLOT_ZH[m.slot] || m.slot}）` }));
  }

  function stats() {
    const bySlot = {};
    for (const s of SLOTS) bySlot[s] = { have: list(s).length, on: equipped(s).length };
    return { skeleton: skel, items: items.size, wearing: wearing().length, bySlot,
             warns: log.filter(x => x.op === 'warn').length };
  }

  return {
    add, remove, get, list, ids, setSkeleton, equip, unequip, equipped, wearing,
    compose, describe, applyTo, entities, stats, log: () => log.slice(),
    get skeleton() { return skel ? { ...skel } : null; },
  };
}

/* ---- 从一张图生成一件（门槛最低的那条路）----
 * 这不是"AI 自动建模"，是"把图放到正确的位置上"：
 *   · 图本身要是去底的（工具页会帮你抠纯色背景）
 *   · 骨名决定它跟着哪块身体动
 *   · scale 决定它在屏幕上多大（米）
 * 对 3D 来说它是一张贴在骨头上的片；对 2D 来说它就是一层图。
 * 不完美，但"今天就能穿上一件自己画的"。 */
export function fromImage({ id, name, slot, image, skeleton = null, kind = null,
                            bone = null, offset = null, scale = null, author = '', license = '' } = {}) {
  if (!SLOTS.includes(slot)) throw new Error(`slot 只能是 ${SLOTS.join('/')}`);
  const d = SLOT_DEFAULTS[slot] || SLOT_DEFAULTS.accessory;
  const m = {
    schemaVersion: SCHEMA_VERSION,
    id: id || `img-${slot}-${Date.now().toString(36)}`,
    name: name || '一件新的',
    slot,
    mode: 'overlay',
    requires: skeleton ? { skeleton, ...(kind ? { kind } : {}) } : {},
    files: { image: image || 'layer.png' },
    anchor: {
      bone: bone || d.bone,
      offset: offset || d.offset.slice(),
      rotation: [0, 0, 0],
      scale: scale || d.scale.slice(),
    },
    z: slot === 'hair' ? 20 : slot === 'top' ? 10 : 5,
    author: author || '',
    license: license || '',
    source: 'image',
    note: '从一张图生成：图片挂在骨头上，不改变骨架和身体。',
  };
  return m;
}

/* ---- 读目录 ----
 * index.json 只列清单，一件一个 manifest（方便单独拷走、单独授权）。
 * 读不到某一件不整体失败：少一件不影响其余能穿。 */
export async function loadWardrobe({ base = 'assets/wardrobe/', fetchImpl = null, kind = null } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('loadWardrobe 需要一个 fetch');
  const w = createWardrobe({ kind });
  const problems = [];

  let index = null;
  try {
    const r = await f(base + 'index.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    index = await r.json();
  } catch (e) {
    problems.push({ file: 'index.json', error: String(e.message || e) });
    return { wardrobe: w, problems, loaded: 0 };
  }

  if (index.skeleton) w.setSkeleton(index.skeleton, index.kind || kind);
  for (const entry of (index.items || [])) {
    const path = typeof entry === 'string' ? entry : entry.manifest;
    if (!path) { problems.push({ file: '(index)', error: '这一项没有 manifest 路径' }); continue; }
    try {
      const r = await f(base + path, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const m = await r.json();
      const dir = base + path.replace(/\/[^/]+$/, '/');
      w.add(m, { dir });
    } catch (e) {
      problems.push({ file: path, error: String(e.message || e) });
    }
  }
  return { wardrobe: w, problems, loaded: w.ids().length, index };
}
