/* 游戏端口：让鱼去玩，不是我们替她玩
 * ------------------------------------------------------------
 * 这条端口解决的是"她能不能坐在那儿玩一局"，不是"我们能不能控制游戏"。
 * 所以游戏只暴露两样东西给大脑：
 *   局面（state / brief）—— 现在什么情况，用中文说人话
 *   动作（actions）      —— 这一局能做什么，语义级（出这张牌 / 猜这个数 / 结束回合）
 *
 * **坐标、像素、点击位置，一律不进大脑。**
 * 有接口的游戏自己把语义动作翻译成调用；只能看屏幕的游戏，
 * 由适配器在**执行层内部**用视觉找到目标再点——大脑看到的仍然只是"出第三张牌"。
 * 这条分界和 actions.mjs 拦 x/y/z 是同一条，只是这里拦在游戏这一侧。
 *
 * 游戏适配器（adapter）长什么样：
 *   {
 *     id: 'guess', name: '猜数字', mode: 'api' | 'screen',
 *     actions: [{ name, description, intent, schema }],
 *     start(ctx), state(), brief(), act(name, args), stop()
 *   }
 * ctx 只给两样：emit(type, detail) 投一件事；now() 拿时间。
 *
 * 这个文件不碰模型、不拼提示词、不决定"该不该玩"。
 */

import { GEOMETRY_KEYS } from './actions.mjs';

const MODES = ['api', 'screen'];

/* 局面里不允许出现的键。游戏状态最容易被顺手写成 {x: 120, y: 340}，
 * 一旦进了提示词，模型就会开始算"往左 40 像素"——那不是她该想的事。 */
const BANNED_STATE_KEYS = new Set([
  ...GEOMETRY_KEYS,
  'bbox', 'rect', 'bounds', 'screen', 'screenpos', 'screen_pos', 'pixel', 'pixels',
  'cursor', 'mouse', 'click', 'clickat', 'click_at', 'element', 'selector',
]);

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/* 局面只留"人能读的事实"：字符串/数字/布尔/数组/浅对象。
 * 深的、坐标的、DOM 的，全丢掉——宁可少给，不可漏坐标。 */
export function sanitizeState(v, depth = 0) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 400);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth >= 3) return null;
  if (Array.isArray(v)) return v.slice(0, 12).map(x => sanitizeState(x, depth + 1)).filter(x => x !== null);
  if (!isObj(v)) return null;
  const out = {};
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (BANNED_STATE_KEYS.has(String(k).toLowerCase())) continue;
    if (n++ >= 24) break;
    const s = sanitizeState(val, depth + 1);
    if (s !== null) out[k] = s;
  }
  return out;
}

function validateAdapter(a) {
  if (!isObj(a)) throw new Error('游戏适配器必须是一个对象');
  if (!a.id || !/^[a-z0-9][a-z0-9_-]*$/.test(a.id)) throw new Error('游戏 id 只能是小写字母/数字/_/-');
  if (!a.name) throw new Error('游戏要有 name（提示词里会说"你在玩…"）');
  if (!MODES.includes(a.mode)) throw new Error(`游戏 mode 只能是 ${MODES.join('/')}`);
  if (typeof a.act !== 'function') throw new Error('游戏要有 act(name,args)：动作总得有人执行');
  if (!Array.isArray(a.actions) || !a.actions.length) throw new Error('游戏至少要有 1 个动作');
  const seen = new Set();
  for (const x of a.actions) {
    if (!x || !x.name) throw new Error('游戏动作没有 name');
    if (seen.has(x.name)) throw new Error(`游戏动作重名：${x.name}`);
    seen.add(x.name);
    if (!x.description) throw new Error(`游戏动作 ${x.name} 没有 description（提示词里只有名字，模型只能猜）`);
  }
  return a;
}

export function createGameBridge({ registry, perception = null, now = () => Date.now() } = {}) {
  if (!registry) throw new Error('createGameBridge 需要 registry（游戏动作也要进同一张表）');

  let cur = null;
  let ctx = null;
  const owned = new Set();
  const log = [];
  const stats = { starts: 0, calls: 0, fails: 0, events: 0, lastFail: null };

  const owns = name => Boolean(cur && owned.has(name));

  function emit(type, detail = '') {
    if (!cur) return { matched: false };
    stats.events += 1;
    log.push({ at: now(), op: 'event', game: cur.id, type, detail });
    if (perception && typeof perception.signal === 'function') {
      return perception.signal({ type, detail, by: 'game' });
    }
    return { matched: false, reason: 'no_perception' };
  }

  /* 注册游戏的语义动作。
   * run 里只做一件事：交给适配器。校验、窗口、超时、回执都复用动作注册表——
   * 游戏不是法外之地，不能因为"它是游戏"就绕过 schema。 */
  function attach(adapter, { autoContinue = false } = {}) {
    if (cur) detach('switch');
    validateAdapter(adapter);

    const added = [];
    try {
      for (const a of adapter.actions) {
        if (registry.has(a.name) && !owned.has(a.name))
          throw new Error(`游戏动作和屋里已有的动作撞名了：${a.name}。给游戏动作加个前缀（比如 sts_play_card）`);
        registry.register({
          name: a.name,
          description: a.description,
          intent: a.intent || a.description,
          schema: a.schema || {},
          run: async (world, args) => {
            stats.calls += 1;
            const out = await adapter.act(a.name, args);
            if (out === false) return { ok: false, reason: 'refused', by: 'game' };
            if (isObj(out) && out.ok === false) return { ...out, by: 'game' };
            return isObj(out) ? { ...out, ok: true } : { ok: true, effect: String(out || '做了') };
          },
        });
        added.push(a.name);
      }

      /* 结束游戏也是游戏动作：她不想玩了，不用喊人 */
      registry.register({
        name: 'stop_game',
        description: '结束现在这一局，从游戏里退出来',
        intent: '不玩了',
        run: () => {
          const name = cur?.name || '这局游戏';
          detach('her');
          return { ok: true, effect: `从${name}里退出来了` };
        },
      });
      added.push('stop_game');
    } catch (e) {
      for (const n of added) registry.unregister(n, { graceMs: 0 });
      throw e;
    }

    cur = adapter;
    owned.clear();
    for (const n of added) owned.add(n);

    ctx = {
      emit: (type, detail) => emit(type, detail),
      now,
      autoContinue: Boolean(autoContinue),
    };

    stats.starts += 1;
    log.push({ at: now(), op: 'attach', game: adapter.id, actions: [...owned] });
    try { adapter.start?.(ctx); } catch (e) {
      log.push({ at: now(), op: 'start_failed', game: adapter.id, error: String(e.message || e) });
    }
    return { ok: true, game: adapter.id, actions: [...owned] };
  }

  function detach(reason = 'manual') {
    if (!cur) return { ok: false, reason: 'no_game' };
    const game = cur.id;
    for (const n of owned) if (n !== 'stop_game') registry.unregister(n, { graceMs: 0 });
    registry.unregister('stop_game', { graceMs: 0 });
    try { cur.stop?.(); } catch {}
    log.push({ at: now(), op: 'detach', game, reason });
    cur = null; ctx = null; owned.clear();
    return { ok: true, game, reason };
  }

  /* 走注册表：schema、窗口、20 秒超时、失败分类都和别人一样。
   * 执行层据此把 port 标成 game，但不需要另开一条执行路径。 */
  function call(name, args, opt) {
    if (!cur) return { action: name, ok: false, reason: 'no_game', by: 'game', message: '现在没在玩游戏' };
    if (!owned.has(name)) return { action: name, ok: false, reason: 'not_game_action', by: 'game', message: '这不是这一局的动作' };
    return registry.call(name, args, opt);
  }

  function state() {
    if (!cur) return null;
    let s = null;
    try { s = sanitizeState(cur.state?.() ?? null); } catch (e) { s = { error: String(e.message || e) }; }
    return { game: cur.id, name: cur.name, mode: cur.mode, ...(isObj(s) ? s : { state: s }) };
  }

  /* 进提示词的那块。只写"局面 + 你正在玩"，不写操作说明——
   * 动作说明在动作表里，写两遍会让模型以为其中一份是重点。 */
  function brief() {
    if (!cur) return '';
    let text = '';
    try { text = String(cur.brief?.() || ''); } catch (e) { text = ''; }
    const s = state();
    const tail = s ? JSON.stringify(s) : '';
    return [`## 你正在玩：${cur.name}`, text, tail ? `局面：${tail}` : '', '想继续玩就做一个游戏动作；不想玩了就 stop_game。']
      .filter(Boolean).join('\n');
  }

  /* 窗口：游戏动作 + 停 + 屋子原本的动作（由调用方合并）。
   * 这里只返回游戏这一半，合并的事放在页面，免得游戏端口反过来知道屋子有什么。 */
  function windowFor() {
    if (!cur) return null;
    return { names: [...owned], note: `你在玩${cur.name}` };
  }

  function statsOut() {
    return { ...stats, game: cur?.id || null, actions: [...owned], log: log.slice(-20) };
  }

  return {
    attach, detach, owns, call, state, brief, windowFor, emit, stats: statsOut,
    get current() { return cur ? { id: cur.id, name: cur.name, mode: cur.mode } : null; },
    log: () => log.slice(),
  };
}
