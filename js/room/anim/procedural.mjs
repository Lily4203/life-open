/* 程序化动作（第一版）：不用动画资源，纯靠骨头转
 * ============================================================
 * 这一版解决的是最刺眼的那件事：**走路是平移，腿一动不动**。
 *
 * 做法（也是以后接 VRMA 时要对上的东西）：
 *   相位 phase 跟着**走过的距离**走，不跟时间。一个完整步态周期（左右各一步）
 *   走 STRIDE 米。走得慢，腿自然摆得慢；停下来，相位就不再前进。
 *   用时间驱动的话，人会一边滑一边原地蹬腿——程序化走路最常见的假。
 *
 * 左右的相位差半个周期（π）：
 *   左腿在前时右腿在后，左臂向后时右臂向前。少这一个 π，走起来像在跳。
 *
 * 只加偏移，不写绝对值（见 index.mjs 规矩①）。姿势该是什么样由 applyPose 决定，
 * 这里只在她已有的姿势上叠加"正在走"的那份。
 */

export const STRIDE = 1.15;     // 一个完整周期走的距离（米）。坐下/起身用不到，走路才用

/* 各段幅度。为什么这么小：她 1.36 m，腿本来就短；幅度一大就成了"高抬腿"。
 * 这几个数是照着真人慢走量的（大腿前后 ~28°、膝盖屈 ~45°、摆臂 ~15°）。 */
const A_THIGH = 0.50;           // 大腿前后摆（弧度）
const A_KNEE  = 0.78;           // 膝盖屈（只在一个方向弯）
const A_ARM   = 0.28;           // 上臂前后摆
const A_ELBOW = 0.20;           // 小臂跟一点
const BOB     = 0.017;          // 每步落地下沉（米）

const ZERO = [0, 0, 0];

export function procedural() {
  return {
    id: 'procedural',
    label: '程序化（不用动画资源）',
    clips: ['idle', 'walk', 'sit', 'lie', 'desk'],

    mount(host = {}) {
      if (typeof host.bone !== 'function')
        throw new Error('程序化动作要 host.bone(name)——没有骨头就没法动');
      return { bone: host.bone, applied: new Map(), phase: 0, w: 0, t: 0, speed: 0 };
    },

    /* applyPose 重摆了姿势之后调：账本清空，但**不动骨头**——
     * 那时候骨头已经是绝对姿势，再按旧账减一遍会把它减坏。 */
    forget(inst) {
      inst.applied.clear();
    },

    update(dt, ctx, inst) {
      const speed = Math.max(0, Math.min(2.6, Number(ctx.speed) || 0));
      const pose = String(ctx.pose || 'stand');
      inst.t += dt;
      inst.speed = speed;

      /* 只有站着（或走着）才走。坐着/躺着的时候位置也会变（从椅子挪到床边），
       * 那是"换了个地方"，不是"走了两步"——腿不能跟着摆。 */
      const mayWalk = pose === 'stand' || pose === 'walking';
      const want = mayWalk && speed > 0.06 ? 1 : 0;
      inst.w += (want - inst.w) * Math.min(1, dt * 7);
      if (want === 0 && inst.w < 0.002) inst.w = 0;
      const w = inst.w;

      if (speed > 0.01) {
        inst.phase += (speed * dt) * (Math.PI * 2 / STRIDE);
        if (inst.phase >= Math.PI * 2) inst.phase -= Math.PI * 2;
      }

      const p = inst.phase, s = Math.sin(p), c = Math.cos(p);

      /* 先把这一帧要对每根骨头做的偏移算成一张表，最后统一写。
       * 为什么不能边算边写：同一根骨头被算两次的话，第二次会盖掉第一次的记账，
       * 下一帧"先减掉上一帧"就减错了，几十帧之后骨头会歪到一个再也回不来的角度。 */
      const d = new Map();
      const put = (name, dx = 0, dy = 0, dz = 0) => {
        const a = d.get(name) || [0, 0, 0];
        a[0] += dx; a[1] += dy; a[2] += dz;
        d.set(name, a);
      };

      if (w > 0) {
        /* 腿：左腿相位，右腿反相。
         * 负的 x 是**抬腿向前**——这是坐姿搜出来的（applyPose 里 THIGH=-1.75 让大腿抬平）。 */
        put('leftUpperLeg',  -s * A_THIGH * w);
        put('rightUpperLeg',  s * A_THIGH * w);
        /* 膝盖只往一个方向弯（正 x）。什么时候弯：腿往前扫的那半个周期。
         * 用 cos 的符号挑出来，不是"一直弯"——一直弯就是蹲着走。 */
        put('leftLowerLeg',  Math.max(0,  c) * A_KNEE * w);
        put('rightLowerLeg', Math.max(0, -c) * A_KNEE * w);
        /* 脚踝反向补一点：不补的话脚尖一路朝下，像踮着脚。 */
        put('leftFoot',  -Math.max(0,  c) * A_KNEE * 0.35 * w);
        put('rightFoot', -Math.max(0, -c) * A_KNEE * 0.35 * w);

        /* 手：和同侧的腿反相。左腿在前时左手在后。 */
        put('leftUpperArm',   s * A_ARM * w);
        put('rightUpperArm', -s * A_ARM * w);
        put('leftLowerArm',  Math.max(0,  s) * A_ELBOW * w);
        put('rightLowerArm', Math.max(0, -s) * A_ELBOW * w);

        /* 上身：走起来会微微前倾、随步子扭一点。幅度小，但少了就像个木板。 */
        put('spine', 0.035 * w,  s * 0.045 * w, 0);
        put('chest', 0.015 * w, -s * 0.025 * w, 0);
      }

      /* 呼吸：一直都在，走路时弱一点（走路时人不会明显地"胸口起伏"）。 */
      const br = Math.sin(inst.t * 1.6) * 0.012 * (1 - w * 0.75);
      put('chest', br * 0.9, 0, 0);
      put('spine', -br * 0.5, 0, 0);

      /* 待机时重心慢慢左右挪。周期 9 秒，幅度小到几乎看不出——
       * 看出来了就成了"站着发抖"。 */
      if (w < 0.3) {
        const sway = Math.sin(inst.t * 0.7) * 0.006 * (1 - w);
        put('spine', 0, 0, sway);
      }

      for (const [name, v] of d) {
        const b = inst.bone(name);
        if (!b) continue;
        const prev = inst.applied.get(name) || ZERO;
        b.rotation.x += v[0] - prev[0];
        b.rotation.y += v[1] - prev[1];
        b.rotation.z += v[2] - prev[2];
        inst.applied.set(name, v);
      }

      /* 落脚那一下整个人往下沉。走的时候身体不是平的，是每步"咚"一下；
       * 少了这个，腿在动，人还是像被一根线吊着滑过去。 */
      const bob = -Math.abs(Math.sin(p)) * BOB * w;
      return { bob };
    },

    state(inst) {
      return {
        phase: +inst.phase.toFixed(2),
        weight: +inst.w.toFixed(2),
        speed: +inst.speed.toFixed(2),
        bones: inst.applied.size,
      };
    },
  };
}
