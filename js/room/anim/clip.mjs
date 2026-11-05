/* 剪辑动作（glTF / VRMA）：把她"演的"交给一段现成的动画
 * ============================================================
 * 为什么先写这一版而不是直接接 VRMA：
 *   接口是不是真的能换，不看文档，看有没有第二个实现。
 *   这一版就是那第二个——它和 procedural 长得一模一样，只是"动从哪来"不同。
 *
 * ⚠ 诚实说明：**这一版没有真资源验过。** 项目里现在没有 .vrma/.glb 动作文件，
 *   跑起来会是"什么都没播"（state 里写着 no_clips）。要用它得先有素材：
 *
 *     ?anim=clip&clips=assets/anim/walk.glb
 *
 *   那份 glb 里要有名为 idle / walk / sit / lie / desk 的 AnimationClip
 *   （名字对不上就退到 idle，别指望它猜）。VRMA 要先转成 glb——
 *   这一版的 GLTFLoader 没装 VRMAnimation 插件。
 *
 * 和 procedural 的分界（别混）：
 *   procedural：没有资源也能动，幅度靠参数，永远能用。
 *   clip：有资源才好看，没资源什么都不发生，但动作是真人的。
 *   两版都只管"骨头怎么动"，位置、朝向、速度还是屋子的事。
 */

export function clip() {
  return {
    id: 'clip',
    label: '动画剪辑（glTF）',
    clips: ['idle', 'walk', 'sit', 'lie', 'desk'],

    mount(host = {}) {
      const three = host.three;
      const root = host.root;
      if (!three || !root) throw new Error('剪辑动画要 host.three 和 host.root（角色根节点）');
      const mixer = new three.AnimationMixer(root);
      const inst = {
        three, mixer,
        actions: new Map(),      // name -> AnimationAction
        current: null,
        fadeMs: 220,
        note: 'no_clips',        // 有素材之后变成 ready
        speedOf: new Map(),      // clip 名 -> 播放速率（走路要跟着实际速度）
      };

      /* 素材从两处来，先来的算：
       *   ① host.clips —— [{ name, clip }] 已经加载好的
       *   ② host.clipUrl —— 一个 glb 的地址，自己用 loader 取 */
      if (Array.isArray(host.clips) && host.clips.length) bindClips(inst, host.clips);
      else if (host.clipUrl && host.loader) {
        try {
          host.loader.load(host.clipUrl, g => {
            bindClips(inst, (g.animations || []).map(c => ({ name: c.name, clip: c })));
            console.log('[anim] 剪辑读进来了：' + [...inst.actions.keys()].join('/'));
          }, undefined, e => {
            inst.note = 'load_failed';
            console.warn('[anim] 剪辑没读进来：' + (e?.message || e));
          });
        } catch (e) {
          inst.note = 'load_failed: ' + (e.message || e);
        }
      } else {
        inst.note = 'no_clips（没给 clips 也没给 clipUrl，这一版只会站着）';
      }
      return inst;
    },

    /* 剪辑自己在动，不需要"先减上一帧"——但屋子重摆姿势之后要停下正在播的，
     * 否则 applyPose 刚把她按下，剪辑下一帧又把她拎起来。 */
    forget(inst) {
      for (const a of inst.actions.values()) a.stop();
      inst.current = null;
    },

    update(dt, ctx, inst) {
      /* 播哪一个：只看她自己现在的姿态和速度，不看"上一轮演了什么"。
       * 剪辑名对不上就退回 idle，不猜（猜错会播成躺下）。 */
      const speed = Number(ctx.speed) || 0;
      const pose = String(ctx.pose || 'stand');
      let want = 'idle';
      if (pose === 'sit') want = 'sit';
      else if (pose === 'lie') want = 'lie';
      else if (pose === 'desk') want = 'desk';
      else if (speed > 0.06) want = 'walk';
      if (!inst.actions.has(want)) want = inst.actions.has('idle') ? 'idle' : null;

      if (want !== inst.current) {
        const next = want ? inst.actions.get(want) : null;
        const prev = inst.current ? inst.actions.get(inst.current) : null;
        if (next) {
          next.reset();
          next.setEffectiveWeight(1);
          next.play();
          if (prev && prev !== next) prev.crossFadeTo(next, inst.fadeMs / 1000, false);
        } else if (prev) prev.fadeOut(inst.fadeMs / 1000);
        inst.current = want;
      }

      /* 走路剪辑按真实速度放：走得慢就播得慢。
       * 这一步不做，剪辑和位移会各走各的——脚在原地踩，人被推着走。 */
      const walk = inst.actions.get('walk');
      if (walk && inst.current === 'walk') {
        const base = inst.speedOf.get('walk') || 0.9;      // 素材按 0.9 m/s 做的
        walk.timeScale = Math.max(0.4, Math.min(2.0, speed / base));
      }

      inst.mixer.update(dt);
      return { bob: 0 };
    },

    unmount(inst) {
      try { inst.mixer.stopAllAction(); } catch { /* 停不下来也只能算了 */ }
    },

    state(inst) {
      return { note: inst.note, current: inst.current, clips: [...inst.actions.keys()] };
    },
  };
}

function bindClips(inst, list) {
  for (const { name, clip: c } of list) {
    if (!name || !c) continue;
    const a = inst.mixer.clipAction(c);
    /* 循环只在"一直在做的事"上（站着、走着）；坐/躺/桌前是走到就算完，播一遍停住。 */
    a.loop = (name === 'idle' || name === 'walk') ? inst.three.LoopRepeat : inst.three.LoopOnce;
    inst.actions.set(String(name), a);
  }
  if (inst.actions.size) inst.note = 'ready';
}
