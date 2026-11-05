/* 世界快照的契约：屋子写给大脑看的那一段"现在"
 * ------------------------------------------------------------
 * 为什么要有这个东西，而不是在页面里随手拼两行：
 *   ① 两个显示端（Live2D 封面 / 3D 房间）将来都要接同一套记忆，形状就必须一样，
 *      否则 67 接上大脑那天，她的记忆里会混进两套词（"我stand" 就是这么来的）；
 *   ② 感知是靠**前后两张快照做差**发现"世界变了"，没有固定形状就没法做差；
 *   ③ 快照里**不许出现坐标**。坐标一进来，模型就会开始算距离——这条和 actions.mjs
 *      拦 x/y/z 是同一条规矩，只是拦在了更早的地方：连"看"都不给它看数字。
 *
 * 字段（只增不改名，改名要同步 memory 与提示词）：
 *   pose    站/坐/躺/走 —— 中文，给模型直接读
 *   near    身边最近那件东西的中文名，没有就是 null
 *   lights  { 「台灯」: true, 「窗帘」: false } —— 键是中文名，值是开/关
 *   present 他在不在这间屋子里（true/false；null = 这一端不知道，别乱报）
 *   at      写入时刻（毫秒）。只用来算"多久以前"，不参与做差
 *
 * 故意没有的字段：位置、朝向、距离、血量、坐标、时间戳格式。都用不上，
 * 而且每一个都会把"怎么动"漏回给模型。
 */

export const WORLD_V = 1;

export const POSE_ZH = { stand: '站着', sit: '坐着', lie: '躺着', walking: '走着' };

/* 统一成一种形状：英文姿态变中文、lights 的值变布尔、未知键丢掉。
   丢掉未知键是有意的——留着它们，下一步就会有人开始读。 */
export function normalizeWorld(w = {}) {
  const poseRaw = w && w.pose != null ? String(w.pose) : '';
  const lights = {};
  for (const [k, v] of Object.entries((w && w.lights) || {})) {
    lights[String(k)] = Boolean(v);
  }
  return {
    v: WORLD_V,
    pose: poseRaw ? (POSE_ZH[poseRaw] || poseRaw) : null,
    near: w && w.near != null ? String(w.near) : null,
    lights,
    present: w && w.present != null ? Boolean(w.present) : null,
    at: Number(w && w.at) || 0,
  };
}

/* 做差：只报"变了什么"，不报"现在是什么"。
   顺序固定（姿态 → 身边 → 各处开关按名字排序），同样的变化永远产生同样的序列，
   这样规则命中和日志都能对得上。 */
export function diffWorld(prev, next) {
  const a = normalizeWorld(prev);
  const b = normalizeWorld(next);
  const out = [];

  if (a.pose !== b.pose) out.push({ type: 'pose', from: a.pose, to: b.pose });
  if (a.near !== b.near) out.push({ type: 'near', from: a.near, to: b.near });
  /* 他在不在。这是"屋子里还能发生什么"里最大的一件：他走了，屋里就只剩她，
   * 她能做的事和该说的话都不一样。判断交给屋子那端（页面焦点/可见性），
   * 大脑只做差——不许在这里猜"看起来像没人了"。 */
  /* 任一端是 null（这一端不知道他在不在）就不报。
   * 和"空快照不算所有灯都灭了"是同一条规矩：不知道，不等于没有。
   * 67 封面那种还没有焦点监听的一端，快照里就是没有 present。 */
  if (a.present !== b.present && a.present !== null && b.present !== null)
    out.push({ type: 'present', from: a.present, to: b.present });

  const keys = [...new Set([...Object.keys(a.lights), ...Object.keys(b.lights)])].sort();
  for (const k of keys) {
    const from = a.lights[k] === undefined ? null : a.lights[k];
    const to = b.lights[k] === undefined ? null : b.lights[k];
    if (from === to) continue;
    // label 就是键本身：规则里写「台灯」，不用知道它在队列里叫 lamp:2
    out.push({ type: 'light', label: k, from, to });
  }
  return out;
}

/* 签名：用来做"这一帧和上一帧是不是一样"的免费判断。
   at 不进签名，否则每帧都"变了"。 */
export function worldSignature(w) {
  const n = normalizeWorld(w);
  const lights = Object.keys(n.lights).sort().map(k => `${k}=${n.lights[k] ? 1 : 0}`).join(',');
  return `${n.pose}|${n.near}|${n.present}|${lights}`;
}
