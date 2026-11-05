/* 动作注册表（枚举路线）
 * ------------------------------------------------------------
 * 拍定：动作空间用**枚举**，不用"让 LLM 写代码"。
 * 理由不是"枚举更简单"，是分工：
 *   大脑只说"我要坐那张椅子"，**怎么走过去、走多远、膝盖弯多少度，是屋子的事**。
 *   让 LLM 去想"离椅子 0.83 米"，它既算不准，也没必要算。
 *
 * 所以这个注册表有三条硬规矩，全部在代码里拦，不靠提示词自觉：
 *   1) schema 里只允许「意图」：实体 id、枚举值、整数次数。**不许出现坐标/距离/速度/时长**。
 *   2) 动作数控制在 20~30 条，每条一句话。这是枚举路线成立的前提。
 *   3) 执行失败必须回 ok:false + reason，服务端才知道要不要重试/换一个。
 *      （neuro-probe 实测过：未知动作若不回失败，会触发自动重试）
 *
 * ⚠ 2026-11-05 09:3x 照 neuro-game-sdk 源码重做了四处（这四处之前我们不如它）：
 *   A. **动作窗口**：不再"永远全部可用"。屋子开一个窗口，里面只放这次允许的动作，
 *      提示词只列窗口里的，执行时也只认窗口里的（对应它的 ActionWindow）。
 *   B. **注销宽限 10 秒**：动作注销后仍认得。她如果刚好选了刚收走的动作，
 *      回的是"这个动作刚被收走"，不是"没有这个动作"——后者会让她以为自己在幻觉。
 *   C. **重名覆盖**：房间重载时同一个动作会再注册一遍，抛错会直接崩（对应它的 RemoveAll + AddRange）。
 *   D. **责任写进 message**：回执只有 ok/message 会进下一轮上下文，
 *      所以"是你的错"和"是屋子的错"必须写进那句话，不能只放在字段里。
 */

/* 一旦出现这些键，说明大脑在下达"怎么动"，不是"做什么"。
 * 这不是洁癖：位置一旦进了协议，两边的坐标基准就永远对不齐。 */
export const GEOMETRY_KEYS = new Set([
  'x', 'y', 'z', 'pos', 'position', 'xyz', 'coord', 'coords',
  'rot', 'rotation', 'quaternion', 'angle', 'heading',
  'dist', 'distance', 'range',
  'speed', 'velocity', 'accel',
  'duration', 'ms', 'seconds', 'time', 'delay',
  'path', 'waypoint', 'waypoints', 'navmesh', 'target_pos',
  'scale', 'offset', 'bone', 'bones', 'joint', 'joints', 'ik',
]);

/* 注销后还认多久。抄它的 10 秒，理由是同一个：
 * force 发出去到动作回来之间有个来回，注销和选择可能撞上。 */
export const UNREGISTER_GRACE_MS = 10000;

const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);

export function createRegistry({ now = () => Date.now(), strictNames = false } = {}) {
  const defs = new Map();
  const calls = [];              // 全部调用留痕，便于事后查"她为什么做了这个"
  const log = [];                // 注册/注销/覆盖/窗口，都是给排障看的
  const dying = new Map();       // name -> { def, until }

  /* ---------------- 窗口：这次只允许做这几件 ---------------- */
  let win = null;

  function openWindow({ names, note = '' } = {}) {
    if (!Array.isArray(names) || !names.length) throw new Error('开窗必须给至少一个动作名');
    const unknown = names.filter(n => !defs.has(n));
    if (unknown.length) throw new Error(`窗口里有没注册的动作：${unknown.join('、')}`);
    const uniq = [...new Set(names)];
    win = { names: uniq, set: new Set(uniq), note: String(note || ''), openedAt: now() };
    log.push({ at: now(), op: 'window', names: uniq, note: win.note });
    return windowInfo();
  }

  const closeWindow = () => {
    if (win) log.push({ at: now(), op: 'window_closed', names: win.names });
    win = null;
  };

  const windowInfo = () => (win ? { names: win.names.slice(), note: win.note, openedAt: win.openedAt } : null);

  /* 没有窗口 = 全部可用（保持旧行为，测试和调试台不用每次开窗） */
  const allowed = name => (!win ? true : win.set.has(name));

  /* ---------------- 注册 / 注销 ---------------- */
  function register(def) {
    const { name, description, schema = {}, run } = def || {};
    if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`动作名必须是小写蛇形：${name}`);
    if (!description || !description.trim())
      throw new Error(`动作 ${name} 没有 description —— 提示词里只有名字的动作，模型只能瞎猜（Randy 就是这个毛病）`);
    if (typeof run !== 'function') throw new Error(`动作 ${name} 没有 run()`);

    // schema 自身也不许带几何
    for (const k of Object.keys(schema)) {
      if (GEOMETRY_KEYS.has(k.toLowerCase())) throw new Error(`schema 字段 ${k} 是几何量，不该出现在动作里`);
      const f = schema[k];
      if (!isPlain(f)) throw new Error(`schema.${k} 必须是描述对象`);
      if (!['entity', 'enum', 'int', 'bool', 'text'].includes(f.type))
        throw new Error(`schema.${k}.type 不支持：${f.type}`);
    }

    /* C. 重名：默认覆盖，不抛错。房间重新加载时同一个动作会再注册一遍，
     * 抛错等于页面一刷新就崩。strictNames 只在测试里开，用来抓"真的写重了"。 */
    if (defs.has(name)) {
      if (strictNames) throw new Error(`动作重名：${name}`);
      log.push({ at: now(), op: 'replace', name });
      defs.delete(name);
    }
    dying.delete(name);   // 重新注册的动作不再算"刚被收走"

    const d = {
      name, description: description.trim(), schema,
      /* intent：她视角的一句话（"坐下""走过去"）。只用在回执里——
       * 失败时写"你想坐下，但没成：这件东西坐不上去"，比"use_furniture 没成（not_allowed）"
       * 更接近她能读的事实。description 是给提示词看的三单称，两件事不能混用。 */
      intent: String(def.intent || '').trim() || description.trim(),
      run, interruptible: def.interruptible !== false,
      cost: def.cost || 'low',           // low | mid | high，给发起层做取舍
    };
    defs.set(name, d);
    return d;
  }

  const registerAll = list => list.map(register);

  /* B. 注销进 dying 表，10 秒内仍认得 */
  function unregister(name, { graceMs = UNREGISTER_GRACE_MS } = {}) {
    const d = defs.get(name);
    if (!d) return false;
    defs.delete(name);
    if (win) win = { ...win, names: win.names.filter(n => n !== name), set: new Set([...win.set].filter(n => n !== name)) };
    if (graceMs > 0) dying.set(name, { def: d, until: now() + graceMs });
    log.push({ at: now(), op: 'unregister', name, graceMs });
    return true;
  }

  const has = name => defs.has(name);
  const get = name => defs.get(name) || null;
  const names = () => [...defs.keys()];
  const isDying = name => {
    const x = dying.get(name);
    return Boolean(x && x.until > now());
  };

  /* ---------------- 校验：把"指向不存在的实体""模式不在枚举里"当失败，不当异常 ---------------- */
  function validate(name, args) {
    const d = defs.get(name);
    if (!d) return { ok: false, reason: 'no_such_action', by: 'her' };
    if (!isPlain(args)) return { ok: false, reason: 'bad_args', by: 'her', message: 'args 必须是对象' };

    for (const k of Object.keys(args)) {
      if (GEOMETRY_KEYS.has(k.toLowerCase())) {
        return {
          ok: false, reason: 'geometry_not_allowed', field: k, by: 'her',
          message: `不要给坐标/距离/速度（${k}）。只说做什么，怎么走过去由屋子算。`,
        };
      }
    }
    for (const [k, f] of Object.entries(d.schema)) {
      const v = args[k];
      if (v === undefined || v === null) {
        if (f.required !== false && f.default === undefined) return { ok: false, reason: 'missing_arg', field: k, by: 'her' };
        continue;
      }
      if (f.type === 'entity') {
        if (typeof v !== 'string' && typeof v !== 'number') return { ok: false, reason: 'bad_arg', field: k, by: 'her' };
        if (f.kinds && f.kinds.length) {
          // 实体种类由屋子声明，大脑只递 id；这里只做"是不是这一类"，不做几何
          const kind = String(v).split(':')[0];
          if (!f.kinds.includes(kind))
            return { ok: false, reason: 'wrong_entity_kind', field: k, expect: f.kinds, by: 'her' };
        }
      } else if (f.type === 'enum') {
        if (!f.values.includes(v)) return { ok: false, reason: 'bad_enum', field: k, expect: f.values, by: 'her' };
      } else if (f.type === 'int') {
        if (!Number.isInteger(v)) return { ok: false, reason: 'bad_arg', field: k, by: 'her' };
        if (f.min !== undefined && v < f.min) return { ok: false, reason: 'out_of_range', field: k, by: 'her' };
        if (f.max !== undefined && v > f.max) return { ok: false, reason: 'out_of_range', field: k, by: 'her' };
      } else if (f.type === 'bool') {
        if (typeof v !== 'boolean') return { ok: false, reason: 'bad_arg', field: k, by: 'her' };
      } else if (f.type === 'text') {
        if (typeof v !== 'string') return { ok: false, reason: 'bad_arg', field: k, by: 'her' };
        if (f.max && v.length > f.max) return { ok: false, reason: 'too_long', field: k, max: f.max, by: 'her' };
      }
    }
    // 未声明的字段：宽容放行（模型常多带一个 confidence），但记下来
    const extra = Object.keys(args).filter(k => !(k in d.schema));
    return { ok: true, extra };
  }

  /* ---------------- 执行：20 秒无回执判失败（抄 neuro-game-sdk 的 20s，不自己拍） ---------------- */
  /* signal：他喊了一声，这一步要不要停下。
   * 只往下传，不在这里判断——"停不停"由动作自己决定（走路停下是有意义的，
   * 开关灯停下来毫无意义：它只要一帧）。interruptible:false 的动作不接这个信号。 */
  async function call(name, args = {}, { timeoutMs = 20000, world = null, id = null, signal = null } = {}) {
    const started = now();
    const rec = { id: id || `c${calls.length + 1}`, name, args, at: started, ok: null, reason: null };
    calls.push(rec);

    const refuse = (reason, message, by = 'her') => {
      rec.ok = false; rec.reason = reason; rec.ms = 0;
      return { action: name, args, ok: false, reason, by, message, id: rec.id };
    };

    /* A. 窗口：不在窗口里的动作，不执行。
     * 但要分清两种"不行"，回的话不一样：
     *   动作存在、这次不允许 → 告诉她这次能做什么（她下次就会挑对的）
     *   动作不存在        → 告诉她没这个动作
     * 这两种混成一句，她会以为屋子里所有动作随时都能用。 */
    if (win && !win.set.has(name)) {
      if (defs.has(name)) return refuse('not_in_window', `这次只允许做：${win.names.join('、')}。别的先不做。`, 'her');
      return refuse('no_such_action', `没有「${name}」这个动作。`, 'her');
    }

    /* B. 刚被收走的动作：仍认得，但不能执行 */
    if (!defs.has(name)) {
      if (isDying(name)) return refuse('recently_unregistered', `「${name}」这个动作刚被收走了，现在做不了。`, 'room');
      return refuse('no_such_action', `没有「${name}」这个动作。`, 'her');
    }

    const v = validate(name, args);
    if (!v.ok) {
      rec.ok = false; rec.reason = v.reason; rec.ms = 0;
      return { action: name, args, ok: false, reason: v.reason, by: v.by, message: v.message, id: rec.id, field: v.field };
    }

    const d = defs.get(name);
    const filled = { ...args };
    for (const [k, f] of Object.entries(d.schema)) if (filled[k] === undefined && f.default !== undefined) filled[k] = f.default;

    let timer;
    try {
      /* 第三步参数就是那个信号。动作签名是 (w, args, { signal })——
       * 不看这个信号的动作照旧，不用改一行。 */
      const sig = d.interruptible === false ? null : signal;
      const out = await Promise.race([
        Promise.resolve(d.run(world, filled, { signal: sig })),
        new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs); }),
      ]);
      clearTimeout(timer);
      const partial = isPlain(out) && out.partial === true;
      const ok = !partial && out !== false && !(isPlain(out) && out.ok === false);
      rec.ok = ok; rec.reason = (isPlain(out) && out.reason) || (ok ? null : 'refused');
      rec.ms = now() - started;
      return {
        action: name, id: rec.id, ok, partial,
        reason: rec.reason,
        /* D. 责任方：校验错是她的问题（by:'her'），执行不了是屋子的限制（by:'room'）。
         * message 会进下一轮上下文，所以这句人话比字段更重要。
         * 停下来的 partial 没有责任方：不是她做错，也不是屋子做不到。 */
        by: (ok || partial) ? null : 'room',
        // 回执里带上"屋子做了什么"，但不带几何：大脑不需要知道走几步
        effect: isPlain(out) ? (out.effect ?? null) : null,
        message: isPlain(out) ? (out.message ?? null) : null,
      };
    } catch (e) {
      clearTimeout(timer);
      rec.ok = false; rec.reason = e.code || 'exception'; rec.ms = now() - started;
      /* 停下（是我们让它停的）既不是异常，也不是屋子的错，是"做到一半"。
       * 混进 failure 她会以为这件东西做不了，下次干脆不试了。 */
      if (e && e.code === 'stopped') {
        rec.reason = 'stopped';
        return { action: name, id: rec.id, ok: false, partial: true, reason: 'stopped',
                 by: null, effect: e.effect || '做到一半停下了', message: null };
      }
      return { action: name, id: rec.id, ok: false, partial: false, reason: rec.reason, by: 'room', message: e.message };
    }
  }

  /* ---------------- 给提示词看的形态：一句一条，参数写成"意图" ---------------- */
  function describe(name) {
    const d = defs.get(name);
    if (!d) return '';
    const ps = Object.entries(d.schema).map(([k, f]) => {
      const field = f.required === false ? `${k}?` : k;
      if (f.type === 'entity') return `${field}: ${f.kinds ? f.kinds.join('|') : '实体'}`;
      if (f.type === 'enum') return `${field}: ${f.values.join('|')}`;
      if (f.type === 'int') return `${field}: 整数${f.min !== undefined ? `(${f.min}~${f.max ?? '∞'})` : ''}`;
      if (f.type === 'bool') return `${field}: 是/否`;
      return `${field}: 文本`;
    });
    const tail = ps.length ? `(${ps.join(', ')})` : '';
    return `- ${d.name}${tail} — ${d.description}`;
  }

  /* 窗口开着就只列窗口里的：提示词里列了但执行时拒绝，等于骗她 */
  function describeAll() {
    const list = win ? win.names.filter(n => defs.has(n)) : [...defs.keys()];
    return list.map(n => describe(n)).join('\n');
  }

  /* 给 neuro 的 actions/register 用的形状（字段照 SPEC，不改名） */
  function toProtocol() {
    return [...defs.values()].map(d => ({
      name: d.name,
      description: d.description,
      schema: Object.fromEntries(Object.entries(d.schema).map(([k, f]) => [k, { ...f }])),
    }));
  }

  return {
    register, registerAll, unregister, has, get, names,
    // 窗口
    openWindow, closeWindow, windowInfo, inWindow: allowed,
    // 注销宽限
    isDying,
    // 查询与执行
    validate, call, describe, describeAll, toProtocol,
    calls, log, size: () => defs.size,
  };
}
