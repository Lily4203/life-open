/* 房间 → 动作注册表的桥
 * ------------------------------------------------------------
 * 这个文件只做一件事：把屋子里"已经有的东西"登记成 6 个枚举动作。
 * 它证明了拍定的那条分工：
 *   大脑递过来的是 `use_furniture(furn:bed)`，**不是**"走到 (0.4, 2.1)"。
 *   坐标、朝向、走多久、够不够得着，全部在这一层算完。
 *
 * 用法（房间页末尾）：
 *   import { attachRoom } from './js/brain/room-bridge.mjs';
 *   window.__BRAIN = attachRoom(window);
 *
 * 加一件新家具 = 在 furniture() 的 kind 表里加一行；接口不变。
 */

const KIND_BY_NAME = {
  '床': 'bed', '椅子': 'chair', '桌子': 'desk', '衣柜': 'wardrobe',
  '顶灯': 'lamp', '台灯': 'lamp', '落地灯': 'lamp', '窗帘': 'curtain',
};

export function attachRoom(win, { registry } = {}) {
  const { __state: state, __THREE: THREE, __apply: applyPose, __walk: walkTo,
          __FURN: FURN, __INTS: INTS, __near: nearestInt, __use: useInt } = win;
  const R = registry || win.__REGISTRY;
  if (!R) throw new Error('attachRoom 需要一个 registry（createRegistry()）');
  if (!state || !FURN || !INTS) throw new Error('房间没准备好：缺少 __state / __FURN / __INTS');

  /* ---- 屋子自己的账：实体、位置、可达性，都不外传 ---- */
  function entities() {
    const out = [], counters = {};
    for (const f of FURN) {
      const u = f.userData || {};
      const kind = KIND_BY_NAME[u.name];
      if (!kind) continue;                 // 没登记种类的家具不进动作空间（宁可少，不可猜）
      // id 形状必须是 `${kind}:${n}` —— 校验层靠冒号前那段认种类，不靠猜
      out.push({ id: `${kind}:${counters[kind] = (counters[kind] || 0) + 1}`, kind, label: u.name, action: u.action,
                 spot: u.spot.clone(), face: u.face ?? 0 });
    }
    /* 衣柜里的件也是"这屋里有的东西"：id 形状 outfit:<id>，
     * 但只有 change_clothes 认它；go_to / look_at 的 kinds 不含 outfit，进不来。 */
    if (win.__WARDROBE?.entities) out.push(...win.__WARDROBE.entities());
    for (const it of INTS) {
      const kind = KIND_BY_NAME[it.label];
      if (!kind) continue;
      const p = new THREE.Vector3(); it.obj.getWorldPosition(p);
      // 中文名过不了 slug，用"种类+序号"做稳定 id（顶灯/台灯/落地灯 都是 lamp，不加序号会撞）
      out.push({ id: `${kind}:${counters[kind] = (counters[kind] || 0) + 1}`, kind, label: it.label, int: it, at: p });
    }
    return out;
  }
  /* 只写种类不写序号时（chair），若这一类只有一件，就是它。
     这不是猜：屋子知道有几把椅子，只有一把的时候没有歧义。有两件以上仍然判失败。 */
  const byId = id => {
    const list = entities();
    const hit = list.find(e => e.id === id);
    if (hit) return hit;
    if (!String(id).includes(':')) {
      const same = list.filter(e => e.kind === id);
      if (same.length === 1) return same[0];
    }
    return null;
  };

  /* 停下来：脚站定，目标点收回。
   * 为什么必须收回 want —— tick 每帧朝 want 走，只把 walking 设 false 不够：
   * 鼠标一点家具 poke 一下就把 walking 又置回 true，她会自己接着走。
   * 停下是"停在这里"，不是"暂停一下继续"。 */
  function haltHere() {
    state.want.copy(state.pos);
    state.pending = null;
    state.walking = false;
    state.poseName = 'stand';
    applyPose('stand');
    win.__poke?.();
  }

  /* 等一个条件成立；中途被叫停就立刻站定。
   * 这个函数是"她走路"唯一会长时间挂着的地方，所以打断只需要盯这一个地方。
   * 注意 reject 带的是 {code:'stopped', effect}——不是 cannot_reach，两者的含义差得远：
   * cannot_reach 是"这个屋子到不了"，stopped 是"他喊了一声，我停了"。 */
  function await_(fn, ms = 8000, signal = null) {
    return new Promise((res, rej) => {
      const t0 = performance.now();
      const step = () => {
        if (signal?.aborted) {
          haltHere();
          return rej(Object.assign(new Error('停下了'), { code: 'stopped', effect: '走到一半停下来了' }));
        }
        if (fn()) return res(true);
        if (performance.now() - t0 > ms) return rej(Object.assign(new Error('无法到达'), { code: 'cannot_reach' }));
        requestAnimationFrame(step);
      };
      step();
    });
  }

  const distTo = e => Math.hypot(e.spot.x - state.pos.x, e.spot.z - state.pos.z);

  /* ---- 六个动作。参数里没有一个是"怎么动"，全是"对谁、做什么" ---- */
  const defs = [
    {
      name: 'go_to',
      description: '走到某件家具旁边',
      intent: '走过去',
      schema: { target: { type: 'entity', kinds: ['bed', 'chair', 'desk', 'wardrobe', 'lamp', 'curtain'] } },
      run: async (w, { target }, { signal } = {}) => {
        const e = byId(target);
        if (!e) return { ok: false, reason: 'no_such_thing' };
        // 开关类（灯/窗帘）没有"站位"，但也不等于"已经到了"：
        // 站在两米外说"我过去了"是假话（第一次真跑就是这样，她嘴上说过去了，人没动）
        if (e.at) {
          const d = Math.hypot(e.at.x - state.pos.x, e.at.z - state.pos.z);
          if (d <= 0.62) return { ok: true, effect: '本来就在那儿' };
          const dx = state.pos.x - e.at.x, dz = state.pos.z - e.at.z;
          const len = Math.hypot(dx, dz) || 1;
          walkTo(e.at.x + dx / len * 0.55, e.at.z + dz / len * 0.55);
          await await_(() => !state.walking, 8000, signal);
          return { ok: true, effect: '到了' };
        }
        if (distTo(e) < 0.28) return { ok: true, effect: '本来就在那儿' };
        walkTo(e.spot.x, e.spot.z);
        await await_(() => !state.walking, 8000, signal);
        return { ok: true, effect: '到了' };
      },
    },
    {
      name: 'use_furniture',
      description: '走到并躺上/坐下（床、椅子、桌前）。衣柜上坐不了，对它只会走过去站着看',
      intent: '坐下或躺下',
      schema: { target: { type: 'entity', kinds: ['bed', 'chair', 'desk', 'wardrobe'] } },
      run: async (w, { target }, { signal } = {}) => {
        const e = byId(target);
        if (!e) return { ok: false, reason: 'no_such_thing' };
        const want = e.action || 'stand';
        /* want==='stand' 的是"只能走过去看"的东西（衣柜）。
         * 原来这里回 `already_stand`——她说了"我上去"，回执是 already_stand，ok 还是 true。
         * 那句话就成了假的，她还以为上去了。现在实话实说：上不去。 */
        if (state.poseName === want) {
          return {
            ok: true,
            effect: want === 'stand' ? '已经在旁边站着（这件东西坐不上去）'
              : `本来就${({ lie: '躺着', sit: '坐着', desk: '坐在桌前' })[want] || '那样'}`,
          };
        }

        // 和鼠标点家具走的是同一条路（state.pending → tick 到位后执行），不另开一套
        state.pending = { at: e.spot.clone(), face: e.face, action: want };
        state.want.copy(e.spot);
        state.faceWant = e.face;
        state.poseName = 'walking';
        state.lift = 0; state.tiltX = 0;
        applyPose('stand');
        state.walking = true;
        win.__poke?.();

        await await_(() => !state.walking && state.poseName === want, 8000, signal);
        /* 回执要写成她能读的"发生了什么"，不是姿势码（sit/lie）。
         * 这是她能读到的"我做到了"；写成码，她只会照着历史继续猜。 */
        const DONE = { sit: '坐下了', lie: '躺下了', desk: '在桌前坐下了', stand: '站着了' };
        return { ok: true, effect: DONE[want] || '做好了' };
      },
    },
    {
      name: 'toggle',
      description: '把灯、窗帘打开或关掉（太远会先走过去）',
      intent: '去开关一下',
      // 只说"切换"是不够的：她开口说"开灯"，执行成"关灯"，话和事就反了。
      // 所以给一个显式的目标状态；不写才退化成切换。
      schema: {
        target: { type: 'entity', kinds: ['lamp', 'curtain'] },
        state: { type: 'enum', values: ['on', 'off'], required: false },
      },
      // 参数不能叫 state：这个函数里 state 是屋子的状态对象，同名就会把 state.pos 变成 "on".pos
      run: async (w, { target, state: wantState }, { signal } = {}) => {
        const e = byId(target);
        if (!e || !e.int) return { ok: false, reason: 'not_switchable' };
        const it = e.int;
        const d = Math.hypot(e.at.x - state.pos.x, e.at.z - state.pos.z);
        if (d > it.reach) {                          // 够不着 → 屋子自己走过去，大脑不管距离
          const dx = state.pos.x - e.at.x, dz = state.pos.z - e.at.z;
          const len = Math.hypot(dx, dz) || 1;
          walkTo(e.at.x + dx / len * 0.55, e.at.z + dz / len * 0.55);
          await await_(() => !state.walking, 8000, signal);
        }
        if (wantState) {
          const want = wantState === 'on';
          if (it.on !== want) useInt(it, 'her');   // 'her'：感知要知道这是她自己按的，别再报给她
          return { ok: true, effect: `把${it.label}${want ? '打开了' : '关掉了'}` };
        }
        const was = it.on;
        useInt(it, 'her');
        return { ok: true, effect: `把${it.label}${was ? '关掉了' : '打开了'}` };
      },
    },
    {
      name: 'stand_up',
      description: '站起来（从床上、椅子上、桌前）',
      intent: '站起来',
      run: () => {
        if (state.poseName === 'stand') return { ok: true, effect: '本来就站着' };
        state.pending = null;
        applyPose('stand');
        return { ok: true, effect: '站起来了' };
      },
    },
    {
      name: 'look_at',
      description: '转头看某个方向或某件东西（身体不动）',
      intent: '看一眼',
      schema: { target: { type: 'entity', kinds: ['bed', 'chair', 'desk', 'wardrobe', 'lamp', 'curtain'] } },
      run: (w, { target }) => {
        const e = byId(target);
        if (!e) return { ok: false, reason: 'no_such_thing' };
        const p = e.at || e.spot;
        state.faceWant = Math.atan2(p.x - state.pos.x, p.z - state.pos.z);
        return { ok: true, effect: '看过去了' };
      },
    },
    {
      name: 'idle_pose',
      description: '换个站/坐的姿势，不说话',
      intent: '换个姿势',
      schema: { pose: { type: 'enum', values: ['stand', 'sit', 'lie'], required: false } },
      run: (w, { pose }) => {
        const p = pose || 'stand';
        if (state.poseName === p) return { ok: true, effect: '姿势没变' };
        applyPose(p);
        return { ok: true, effect: ({ stand: '换成站着了', sit: '换成坐下了', lie: '换成躺着了' })[p] || '换了姿势' };
      },
    },
    {
      /* 表情走显示后端端口（js/brain/avatar.mjs），不走屋子。
       * 这条动作存在的理由：她能表达的东西不该只有"走过去、坐下、开关灯"。
       * 后端不会做表情时，回执要如实说"这具身体没有表情"，而不是装成功。
       * 页面没有接端口时（比如 67 还没接），这里回 unsupported，大脑照常往下走。 */
      name: 'set_emotion',
      description: '换个表情（开心/生气/难过/放松/惊讶）',
      intent: '换个表情',
      schema: { emotion: { type: 'enum', values: ['happy', 'angry', 'sad', 'relaxed', 'surprised'] } },
      run: (w, { emotion }) => {
        const av = win.__AVATAR;
        const ZH = { happy: '开心', angry: '生气', sad: '难过', relaxed: '放松', surprised: '惊讶' };
        if (!av) return { ok: false, reason: 'no_backend', by: 'room', message: '这具身体没有表情' };
        const r = av.setEmotion(emotion);
        if (!r.ok) return { ok: false, reason: r.reason || 'unsupported', by: 'room', message: r.message || '这个身体不会做表情' };
        return { ok: true, effect: `表情换成了${ZH[emotion] || emotion}` };
      },
    },
    {
      /* 换装：她只说"换 outfit:scarf-red"，挂点、尺寸、贴图全在这边。
       * 衣柜是可选的：没有 assets/wardrobe 的屋子不注册这两个动作，
       * 不是"有动作但一定失败"。 */
      name: 'change_clothes',
      description: '换上一件穿戴（发型、上衣、下装、鞋、饰品），只能从这屋里有的里面挑',
      intent: '换一件穿戴',
      schema: { item: { type: 'entity', kinds: ['outfit'] } },
      run: (w, { item }) => {
        const W = win.__WARDROBE;
        if (!W) return { ok: false, reason: 'no_wardrobe', by: 'room', message: '这屋里没有衣柜' };
        const id = String(item).replace(/^outfit:/, '');
        const m = W.get(id);
        if (!m) return { ok: false, reason: 'no_such_item', by: 'her', message: `衣柜里没有「${id}」` };
        const r = W.equip(id);
        if (!r.ok) return { ok: false, reason: r.reason, by: 'room', message: r.message };
        const ap = W.applyTo(win.__AVATAR);
        if (!ap.ok) {
          // 穿不上就退回去：衣柜说穿着、人身上没有，是最坏的一种不一致
          W.unequip(id);
          return { ok: false, reason: ap.reason || 'unsupported', by: 'room', message: ap.message || '这具身体换不了这件' };
        }
        return { ok: true, effect: `换上了${m.name}` };
      },
    },
    {
      name: 'take_off',
      description: '把身上某一件穿戴摘下来（发型、上衣、下装、鞋、饰品）',
      intent: '摘下一件穿戴',
      schema: { slot: { type: 'enum', values: ['hair', 'top', 'bottom', 'shoes', 'accessory'] } },
      run: (w, { slot }) => {
        const W = win.__WARDROBE;
        if (!W) return { ok: false, reason: 'no_wardrobe', by: 'room', message: '这屋里没有衣柜' };
        const had = W.equipped(slot).length > 0;
        W.unequip(slot);
        const ap = W.applyTo(win.__AVATAR);
        if (!ap.ok) return { ok: false, reason: ap.reason || 'unsupported', by: 'room', message: ap.message || '这具身体换不了' };
        const ZH = { hair: '发型', top: '上衣', bottom: '下装', shoes: '鞋', accessory: '饰品' };
        return { ok: true, effect: had ? `把${ZH[slot] || slot}摘下来了` : `本来就没穿戴${ZH[slot] || slot}` };
      },
    },
  ];

  R.registerAll(defs);

  /* ---- 窗口：这次允许做哪几件 ----
   * 屋子比任何提示词都清楚她现在的状态，所以窗口由屋子开，不由大脑猜。
   * 三条规矩，都是踩过的：
   *   ① 正在走：只给 look_at。给了别的她会一边走一边接新指令，状态机打架。
   *   ② 站着时不给 stand_up —— 一个"已经站着还说站起来"的动作，模型偶尔会选它，纯噪声。
   *   ③ 躺着/坐着时把 stand_up 放进来，因为起身是真实需要；
   *      但 use_furniture 仍然保留（人从椅子上直接走到床上躺下，不需要先"站起来"这一步）。 */
  const POSE_ZH = { stand: '站着', sit: '坐着', lie: '躺着', walking: '走着' };
  function windowFor() {
    /* 表情任何姿态都能换，走路时也能——它不碰身体的位置和骨骼姿势。
     * 只给"这个后端真的会做"的：没接显示端口时连 set_emotion 都不列，
     * 列了她就会选，选了又做不成，白白多一条失败。 */
    const emo = win.__AVATAR && win.__AVATAR.can && win.__AVATAR.can('emotion') ? ['set_emotion'] : [];
    if (state.walking) return { names: ['look_at', ...emo], note: '你正在走过去，先走完再说' };
    const names = ['go_to', 'use_furniture', 'toggle', 'look_at', 'idle_pose', ...emo];
    /* 别人加进来的活动（喝茶/看窗外/伸懒腰）只在没走路时放开。
     * 它们也是普通动作，走同一张表；这里只是把窗口算进去。 */
    if (win.__ACTIVITIES?.names) names.push(...win.__ACTIVITIES.names());
    /* 衣柜有东西、身体又真会换，才把换装放进窗口。
     * 列一个一定做不成的动作，等于骗她选。 */
    if (win.__WARDROBE?.ids?.().length && win.__AVATAR?.can?.('outfit')) names.push('change_clothes', 'take_off');
    if (state.poseName !== 'stand') names.push('stand_up');
    return {
      names,
      note: state.poseName === 'stand' ? '' : `你现在${POSE_ZH[state.poseName] || '待着'}`,
    };
  }

  /* ---- 对外只暴露四样：她能被要求做什么、这次允许做什么、现在在哪、屋子在看什么 ---- */
  const api = {
    registry: R,
    entities: () => entities().map(({ id, kind, label }) => ({ id, kind, label })),
    describe: () => R.describeAll(),
    call: (name, args, opt) => R.call(name, args, { world: null, ...opt }),
    windowFor,
    where: () => ({ pose: state.poseName, walking: state.walking, x: +state.pos.x.toFixed(2), z: +state.pos.z.toFixed(2) }),
    near: () => { const n = nearestInt(); return n.it ? { label: n.it.label, d: +n.d.toFixed(2), reach: n.it.reach } : null; },
  };
  return api;
}
