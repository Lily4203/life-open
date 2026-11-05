/* 手势词表与演法 —— 身体的词汇，不是大脑的选项
 * ------------------------------------------------------------
 * 为什么单独一个文件：
 *   这套东西是**数据**，页面只是播放器。写在页面里就只能靠"打开看一眼"来验；
 *   抽出来，node 就能验它守不守规矩（见 tools/brain-test/perform-test.mjs）：
 *
 *     ① u=0 和 u=1 必须全零 —— 不然进场出场会"啪"地跳一下
 *     ② 只能动白名单里的骨骼 —— 名字打错一个字母，人不会报错，
 *        只会少动一只胳膊；这种错必须被机器抓住，不能靠眼睛
 *     ③ 幅度有上限 —— 叠过头手臂会翻到背后，像脱臼
 *     ④ **头（head / eyes）永远不许碰** —— 头归视线。页面每帧都在把
 *        head.rotation 往鼠标上拽，这里再叠偏移，两边互相拉锯，看起来是发抖
 *
 * 每个手势是 (u ∈ [0,1]) → { 骨骼名: [rx, ry, rz] }，用 sin(πu) 做进出场。
 * 不用关键帧文件：九个手势、每个两行，比拉一个 .fbx 便宜得多，也不会因为
 * 换一具骨长不同的身体就错位——所有量都是相对角度。
 *
 * 名字必须和 avatar.mjs 的 GESTURES 一致：那边是"这个词存在"，这里是"怎么演"。
 */

/* 允许动的骨骼。手和手臂是主力，躯干只能配合；腿和头都不在里面。 */
export const GEST_BONES = [
  'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm',
  'leftLowerArm', 'rightLowerArm',
  'leftHand', 'rightHand',
  'spine', 'chest', 'upperChest', 'neck',
];

/* 单轴弧度上限。人的肘弯不到 1.6（约 92°），超过就是脱臼。 */
export const GEST_LIMIT = 1.6;

export const GESTURES = {
  /* 强调：两只小臂往上抬一点，配合重音。所有手势里最轻的一个，可以高频用。 */
  emphasize: { dur: 0.9, at: u => { const e = Math.sin(Math.PI * u); return {
    leftLowerArm: [0, 0, -0.60 * e], rightLowerArm: [0, 0, 0.60 * e],
    leftUpperArm: [0, 0, -0.16 * e], rightUpperArm: [0, 0, 0.16 * e],
    chest: [-0.05 * e, 0, 0] }; } },

  /* 指：右臂抬到肩高往前指，脖子跟着偏一点。她说"你看那个"时才用得上。 */
  point: { dur: 1.3, at: u => { const e = Math.sin(Math.PI * Math.min(1, u * 1.2)); return {
    rightUpperArm: [-0.85 * e, 0, 0.30 * e], rightLowerArm: [-0.20 * e, 0, 0.10 * e],
    chest: [0, -0.10 * e, 0], neck: [0, -0.14 * e, 0] }; } },

  /* 摆手：抬起来摇两下。用在"不用了 / 再见"这类。 */
  wave: { dur: 1.5, at: u => {
    const e = Math.sin(Math.PI * u); const w = Math.sin(u * Math.PI * 6) * e;
    return { rightUpperArm: [-0.55 * e, 0, 0.40 * e],
             rightLowerArm: [0, 0, 1.05 * e + 0.30 * w], neck: [0, 0.06 * e, 0] }; } },

  /* 耸肩：两边肩一起抬，手臂往外翻，脖子略歪。承认不知道时的标准动作。 */
  shrug: { dur: 1.0, at: u => { const e = Math.sin(Math.PI * u); return {
    leftShoulder: [0, 0, -0.20 * e], rightShoulder: [0, 0, 0.20 * e],
    leftUpperArm: [0, 0, -0.26 * e], rightUpperArm: [0, 0, 0.26 * e],
    neck: [0.06 * e, 0, 0.12 * e] }; } },

  /* 点头：neck 俯仰两次。只动脖子，头还给视线。 */
  nod: { dur: 0.85, at: u => {
    const e = Math.sin(Math.PI * u); const k = Math.sin(u * Math.PI * 4);
    return { neck: [0.14 * k * e, 0, 0] }; } },

  /* 歪头：疑惑 / 心软。幅度小，时间长，是最不打扰的一个。 */
  tilt: { dur: 1.1, at: u => { const e = Math.sin(Math.PI * u); return {
    neck: [0, 0, 0.18 * e], chest: [0, 0, 0.04 * e] }; } },

  /* 换重心（待机）：脊柱左右晃一下，脚不动。看起来像"站累了换个脚"。 */
  shift: { dur: 2.4, at: u => {
    const e = Math.sin(Math.PI * u); const s = Math.sin(u * Math.PI * 2) * e;
    return { spine: [0, 0, 0.06 * s], chest: [0, 0, -0.05 * s], neck: [0, 0, 0.05 * s],
             leftUpperArm: [0, 0, 0.10 * s], rightUpperArm: [0, 0, -0.10 * s] }; } },

  /* 整理衣服（待机）：两只手抬到领口，一秒半。 */
  tidy: { dur: 1.6, at: u => { const e = Math.sin(Math.PI * Math.min(1, u * 1.25)); return {
    leftUpperArm: [-0.42 * e, 0, -0.62 * e], rightUpperArm: [-0.42 * e, 0, 0.62 * e],
    leftLowerArm: [-0.55 * e, 0, -0.60 * e], rightLowerArm: [-0.55 * e, 0, 0.60 * e],
    neck: [0.10 * e, 0, 0] }; } },

  /* 看一眼别处（待机）：脖子转开再回来。不是"看鼠标"，是走神。 */
  glance: { dur: 1.9, at: u => { const e = Math.sin(Math.PI * u); return {
    neck: [0, -0.32 * e, 0], chest: [0, -0.08 * e, 0] }; } },
};

/* 连着两次同一个会被一眼看穿，所以备一个"换一个最接近的"。
 * 不是随机——随机会跳到不搭的动作上（刚点头突然整理衣服）。 */
export const NEAREST = {
  emphasize: 'nod', nod: 'tilt', tilt: 'nod', glance: 'shift', shift: 'glance',
  tidy: 'shift', point: 'emphasize', wave: 'emphasize', shrug: 'emphasize',
};

/* 取某一帧的偏移。u 会被夹到 [0,1]；不认识的手势返回 null（调用方据此报错，不猜）。 */
export function sample(kind, u) {
  const g = GESTURES[kind];
  if (!g) return null;
  const t = Math.max(0, Math.min(1, Number(u) || 0));
  const raw = g.at(t) || {};
  const out = {};
  for (const name in raw) {
    if (!GEST_BONES.includes(name)) continue;         // 白名单外的直接丢，宁可不演
    const v = raw[name];
    /* 近零就归零：sin(π) 在浮点里是 1.2e-16，不是 0。
     * 不归零的话，每演一次都会在骨头上留下一点粉尘，几十次之后手臂就歪了。 */
    const fix = x => {
      const n = Math.max(-GEST_LIMIT, Math.min(GEST_LIMIT, Number(x) || 0));
      return Math.abs(n) < 1e-6 ? 0 : n;
    };
    out[name] = [fix(v[0]), fix(v[1]), fix(v[2])];
  }
  return out;
}
