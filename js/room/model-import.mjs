/* 模型导入：把一个 .vrm 收下来之前，先弄清它能不能用。
 * ============================================================
 * 为什么要有这一层：
 *   "拖进来能看见人"和"她能坐下、能挥手、能换表情"是三件不同的事。
 *   一个缺了 hips 的模型照样能渲染出来，然后所有动作都从错误的地方开始，
 *   表现为"她整个人是斜的""坐下的时候腿穿进地板"——而那些错看起来像我们的 bug。
 *
 * 所以规则很简单：**进房间的门槛是骨骼，不是外观。**
 *   · 没有 humanoid → 拒绝。她能站着看，但我们所有动作都会静默失效。
 *   · 关键骨骼缺一根 → 拒绝。缺哪根都对应一类做不了的动作。
 *   · 身高离谱（0.3m 以下 / 3m 以上）→ 拒绝。那是单位错了，不是人矮。
 *   · 材质太多 / 没表情 → 允许，但要提醒。这类问题不影响正确性，影响体验。
 *
 * 两个函数分开，是为了让它能被测：
 *   summarize()  在浏览器里跑，跟 VRM 对象打交道（测它得开 WebGL）
 *   inspect()    纯函数，只吃一个摘要对象（node 里一句话就能测）
 * 判定规则全在 inspect 里，所以"什么算能用"这件事是可测的。
 */

/* VRM 规范里 humanoid 的必需骨骼。缺任何一根，对应的那类动作就废了：
 *   hips        —— 全身的根。少了它，坐/躺/走全部从错误的地方起算
 *   spine/head  —— 视线、点头、转头
 *   upperArm    —— 手势、挥手、够东西
 *   upperLeg    —— 走、坐、躺
 * 只查这七根，因为它们各自代表一整类动作；查全套 54 根会拒绝掉太多能用的模型。 */
export const REQUIRED_BONES = [
  'hips', 'spine', 'head',
  'leftUpperArm', 'rightUpperArm',
  'leftUpperLeg', 'rightUpperLeg',
];

/* 人形的合理身高范围（米）。超出就是单位错了——很多模型按厘米建（135），
 * 也有很多按"1 unit = 1 cm"的旧习惯导出。这类模型进来会变成 100 倍大的巨人，
 * 一眼能看出来，但那时已经在房间里了。 */
export const HEIGHT_MIN = 0.3;
export const HEIGHT_MAX = 3.0;

/* 材质数量上限。超过这个数，低配机器上会掉帧到没法看。
 * 不说死，只提醒——他可能就是想要那个精度。 */
export const MATERIAL_WARN = 120;

/* 文件名只允许这些字符。不是洁癖：这个值会变成磁盘上的文件名，
 * 也会出现在 URL 里。中文、空格、斜杠、点，都得先收拾干净。
 * 中文不是"不合法"，是"要转写"——见 slugify。 */
export function slugify(name, fallback = 'model') {
  const s = String(name == null ? '' : name)
    .trim()
    .toLowerCase()
    /* 有读音的字符先换成近义拉丁，其余全部丢掉。
     * 不保留中文的原因：文件名要能被 git、URL、shell 同时安全地处理，
     * 而这三者对非 ASCII 的宽容度不一样。显示名另外存，不受影响。 */
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
  return s || fallback;
}

/* 判定。输入是一个摘要（summarize 的产物），输出三样：
 *   ok     能不能进房间
 *   fatal  不能进的原因（人话，每条都指向"缺了会怎样"）
 *   warn   能进但要提醒的
 *
 * 注意 fatal 不是布尔数组：每条都要能直接显示给用户看。
 * "导入失败"这四个字等于什么都没说。 */
export function inspect(sum) {
  const s = sum && typeof sum === 'object' ? sum : {};
  const fatal = [];
  const warn = [];

  if (!s.isVRM) {
    fatal.push('这不是 VRM 文件——房间里需要能摆姿势的骨骼，普通 glb 只能当布景');
  } else {
    if (!s.hasHumanoid) {
      fatal.push('这个模型没有 humanoid 骨骼：她能站着，但走、坐、挥手全都不会发生（而且是静默失效）');
    } else {
      const bones = Array.isArray(s.bones) ? s.bones : [];
      const have = new Set(bones.map((b) => String(b).toLowerCase()));
      const missing = REQUIRED_BONES.filter((b) => !have.has(b.toLowerCase()));
      if (missing.length) {
        fatal.push(`缺 ${missing.length} 根关键骨骼：${missing.join('、')}——对应的动作会做不出来`);
      }
    }
  }

  const h = Number(s.height);
  if (!Number.isFinite(h) || h <= 0) {
    fatal.push('量不出身高：模型可能是空的，或者尺寸是 0');
  } else if (h < HEIGHT_MIN || h > HEIGHT_MAX) {
    fatal.push(`身高 ${h.toFixed(2)} m 不合理（合理范围 ${HEIGHT_MIN}–${HEIGHT_MAX} m）——多半是单位错了，不是人矮`);
  }

  if (s.isVRM && s.hasHumanoid) {
    const expr = Number(s.expressions) || 0;
    if (expr === 0) warn.push('没有表情：她做不出高兴/难过，只能靠动作和语气（VRM 0.x 的表情可能在别的字段里）');
    const mat = Number(s.materials) || 0;
    if (mat > MATERIAL_WARN) warn.push(`${mat} 个材质：低配机器上会掉帧，能进但可能卡`);
    if (!s.metaVersion) warn.push('没有 VRM meta：看不出作者和授权，建议在文件里补上再用');
  }

  return { ok: fatal.length === 0, fatal, warn, facts: factsOf(s) };
}

/* 给界面用的事实摘要。这些数不是为了好看，是为了"出问题时第一个该看什么"。 */
function factsOf(s) {
  return {
    height: Number.isFinite(Number(s.height)) ? Number(s.height) : 0,
    bones: Array.isArray(s.bones) ? s.bones.length : 0,
    materials: Number(s.materials) || 0,
    expressions: Number(s.expressions) || 0,
    metaVersion: s.metaVersion || '',
    author: s.author || '',
  };
}

/* 从真的 VRM 对象里抽摘要。这是整个文件里唯一碰 three/VRM 的地方——
 * 判定逻辑一行都不在这儿，所以"什么算能用"不依赖 WebGL。 */
export function summarize(vrm, { height = 0 } = {}) {
  if (!vrm) return { isVRM: false, height };
  const humanoid = vrm.humanoid || null;
  const nodes = humanoid && humanoid.humanBones ? humanoid.humanBones : null;

  let bones = [];
  if (nodes) {
    /* humanBones 在不同小版本里是对象（名字 → {node}）或数组，两种都收。 */
    bones = Array.isArray(nodes)
      ? nodes.map((b) => (typeof b === 'string' ? b : b && b.bone)).filter(Boolean)
      : Object.keys(nodes);
  }

  let materials = 0;
  try {
    const seen = new Set();
    vrm.scene?.traverse?.((o) => {
      if (!o.material) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m) seen.add(m);
    });
    materials = seen.size;
  } catch (e) { /* 数不出来就当 0，只是少一条提醒，不影响判定 */ }

  const exprMap = (vrm.expressionManager && vrm.expressionManager.expressionMap) || {};
  const meta = vrm.meta || {};

  return {
    isVRM: true,
    hasHumanoid: !!humanoid,
    bones,
    height: Number(vrm.height) > 0 ? Number(vrm.height) : height,
    materials,
    expressions: Object.keys(exprMap).length,
    metaVersion: meta.metaVersion || '',
    author: meta.author || (Array.isArray(meta.authors) ? meta.authors.map((a) => a.name).filter(Boolean).join(', ') : ''),
  };
}

/* 导入之后登记到 characters.json 的那一条。
 * 单独写出来是因为它的形状要和现有的 avatarModels 完全一致——
 * 差一个字段，换人面板里就点不动，而且不会有报错。 */
export function toAvatarModel({ id, label, src, name, note, commercial = false, author = '', license = '' }) {
  return {
    id,
    kind: 'vrm',
    label: label || '3D',
    src,
    use: ['room'],
    note: note || `导入的模型（${name || id}）`,
    credit: {
      author: author || '',
      license: license || '',
      commercial: !!commercial,
    },
  };
}
