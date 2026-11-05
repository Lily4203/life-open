/* 动作插槽：她"怎么动"可以整个换掉，屋子只认一个接口
 * ============================================================
 * 为什么要有这一层：现在的动作是**散在 world.mjs 里的一堆赋值**——
 * 呼吸写 chest、走路靠 position 平移、坐下靠 applyPose 拧角度。
 * 结果就是"腿不动，人滑过去"。想换一套动作，只能改 world.mjs 那一千多行。
 *
 * 这一层只定形状，不管实现：
 *   id      必填，小写蛇形，唯一
 *   label   人看的名字
 *   clips   它会哪些（'idle' / 'walk' / 'sit' / 'lie' / 'desk'）。屋子按这个名字问它。
 *   mount(host)  拿骨头。host = { bone(name), three?, root?, state? }
 *   update(dt, ctx)  每帧。ctx = { speed, pose, t }
 *                返回 { bob } —— 整个人要上下沉多少（走路落脚那一下）。
 *                骨头的事归它，位置和朝向归屋子：这是"演"和"走"的分界。
 *   forget() 可选。屋子重设姿势（applyPose）之后调它，清掉"这一帧加了哪些偏移"的账。
 *   unmount() 可选。
 *   state() 可选，调试用。
 *
 * 三条硬规矩（写在这里，不靠自觉）：
 *   ① **只加偏移，不写绝对值。** 姿势是 applyPose 摆的（坐着/躺着/手放桌上），
 *      每帧直接赋值会把它冲掉。所以 update 里只能 add(骨头, 增量)，
 *      由这一层记住"上一帧加了多少"，下一帧先减掉再加新的。
 *   ② **相位跟着走过的距离走，不跟着时间走。** 时间驱动的话，
 *      走得慢时腿摆得比人快，看起来像在冰上滑——这是程序化走路最常见的一种假。
 *   ③ **权重过渡，不硬切。** 起步/停步时 w 从 0 渐到 1，否则第一帧腿就"啪"地甩出去。
 *
 * 换一版：写一个同样形状的文件，在页面里 register 一下，?anim=你的id。
 * 想接 VRMA / glTF 剪辑的，见 clip.mjs。
 */

/* 1–24 字。一开始写的是"至少两个字符"，结果单字符 id 在测试里当场炸——
 * 这个限制没有一条理由撑得住（id 是拿来认的，不是给人读的）。 */
const ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
export const CLIPS = ['idle', 'walk', 'run', 'sit', 'lie', 'desk'];

export function defineAnimator(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('animator 必须是一个对象');
  const id = String(spec.id || '');
  if (!ID_RE.test(id)) throw new Error(`animator 的 id 不合格：'${id}'（小写蛇形，1–24 字）`);
  if (typeof spec.mount !== 'function') throw new Error(`animator ${id} 缺 mount(host)`);
  if (typeof spec.update !== 'function') throw new Error(`animator ${id} 缺 update(dt, ctx)`);
  const clips = Array.isArray(spec.clips) ? spec.clips.map(String) : [];
  if (!clips.length) throw new Error(`animator ${id} 要声明 clips（它会哪几种动作）`);
  const bad = clips.filter(c => !CLIPS.includes(c));
  if (bad.length) throw new Error(`animator ${id} 声明了不认识的动作：${bad.join('、')}（只允许 ${CLIPS.join('/')}）`);
  return {
    id,
    label: String(spec.label || id),
    clips,
    mount: spec.mount,
    update: spec.update,
    forget: typeof spec.forget === 'function' ? spec.forget : null,
    unmount: typeof spec.unmount === 'function' ? spec.unmount : null,
    state: typeof spec.state === 'function' ? spec.state : null,
  };
}

/* 注册表：和动作表同一个思路——枚举、可换、一次只用一个。
 * 不做"多套同时跑"：两套程序化动作同时写同一根骨头，只会打架。 */
export function createAnimatorSet() {
  const list = new Map();

  function register(spec) {
    const a = defineAnimator(spec);
    list.set(a.id, a);      // 重名覆盖：房间热重载会再注册一遍，抛错等于刷新就崩
    return a;
  }

  /* 挑一个来用。要的那个不在就退回第一个，并且**把这件事说出来**——
   * 悄悄换掉的话，用户会以为自己的 animator 生效了。 */
  function create(id, host) {
    const want = id && list.get(id);
    const a = want || list.values().next().value;
    if (!a) throw new Error('一个 animator 都没注册');
    const inst = a.mount(host || {}) || {};
    return {
      id: a.id,
      label: a.label,
      clips: a.clips.slice(),
      fallback: !want,
      update: (dt, ctx) => a.update(dt, ctx || {}, inst) ?? null,
      forget: () => a.forget?.(inst),
      unmount: () => a.unmount?.(inst),
      state: () => a.state?.(inst) ?? null,
      raw: inst,
    };
  }

  return {
    register,
    create,
    has: id => list.has(id),
    ids: () => [...list.keys()],
    get: id => list.get(id) || null,
    size: () => list.size,
  };
}
