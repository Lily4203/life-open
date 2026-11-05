/* 世界内容：别人往这间屋子里加"吃喝玩乐"，不改大脑
 * ------------------------------------------------------------
 * 一个活动是一份 JSON，不是一段脚本：
 *   { id, name, action, description, intent, at, move, pose, emotion, effect }
 * 它只能组合屋子里**已经有**的东西：走到某件家具、坐下、换个表情。
 * 不能写坐标、不能替她说话、不能决定"什么时候做"。
 *
 * 为什么不做成插件代码：
 *   代码插件能做的事太多，门槛也高——会写 JS 的人不需要我们，
 *   会写内容的人被挡在外面。先给一份"能加一道菜、能加一个看窗外的动作"的格式，
 *   真有复杂玩法再开 adapter，那是第二步。
 *
 * 这个文件不碰模型、不碰记忆、不做决定。她要不要喝茶，仍然是她自己说。
 */

import { GEOMETRY_KEYS } from './actions.mjs';

export const POSES = ['stand', 'sit', 'lie', 'desk'];
export const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
export const MOVES = ['use_furniture', 'go_to'];

const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ACTION = /^[a-z][a-z0-9_]*$/;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function hasGeometry(o, path = '') {
  for (const [k, v] of Object.entries(o || {})) {
    if (GEOMETRY_KEYS.has(String(k).toLowerCase())) return `${path}${k}`;
    if (isObj(v)) {
      const r = hasGeometry(v, `${path}${k}.`);
      if (r) return r;
    }
  }
  return null;
}

export function validateActivity(a) {
  const errs = [];
  if (!isObj(a)) return ['活动必须是一个对象'];
  if (Number(a.schemaVersion) !== 1) errs.push('schemaVersion 必须是 1');
  if (!a.id || !SLUG.test(String(a.id))) errs.push('id 只能是小写字母/数字/_/-');
  if (!a.name || !String(a.name).trim()) errs.push('name 不能空（提示词里用的是这个名字）');
  if (!a.action || !ACTION.test(String(a.action))) errs.push('action 必须是小写蛇形（比如 drink_tea）');
  if (!a.description || !String(a.description).trim()) errs.push('description 不能空（她不看说明就只能猜）');
  if (!a.effect || !String(a.effect).trim()) errs.push('effect 不能空（做完要有一句"发生了什么"）');
  if (a.pose != null && !POSES.includes(a.pose)) errs.push(`pose 只能是 ${POSES.join('/')}`);
  if (a.emotion != null && !EMOTIONS.includes(a.emotion)) errs.push(`emotion 只能是 ${EMOTIONS.join('/')}`);
  if (a.move != null && !MOVES.includes(a.move)) errs.push(`move 只能是 ${MOVES.join('/')}`);
  if (a.move && !a.at) errs.push('写了 move 就要写 at（去哪件东西那儿）');
  if (a.at != null && !/^[a-z]+:[0-9]+$/.test(String(a.at))) errs.push('at 要写成 kind:序号，比如 desk:1');
  /* 内容不许替她说话。她说什么由她决定；这里只写"发生了什么"。 */
  if (a.say != null) errs.push('不要写 say：话由她自己说，内容只描述发生了什么');
  const g = hasGeometry(a);
  if (g) errs.push(`不要写几何量（${g}）：走过去、坐哪儿由屋子算`);
  return errs;
}

export function createWorldContent({ registry, getWin = () => null, getAvatar = () => null,
                                     getBrain = () => null, now = () => Date.now() } = {}) {
  if (!registry) throw new Error('createWorldContent 需要 registry');
  const items = new Map();          // action -> { pack, def }
  const log = [];

  const win = () => getWin();
  const avatar = () => getAvatar();
  const brain = () => getBrain();

  function add(pack) {
    const errs = validateActivity(pack);
    if (errs.length) {
      const e = new Error(`「${pack?.name || pack?.id || '?'}」加不进来：${errs.join('；')}`);
      e.code = 'bad_activity';
      e.errs = errs;
      throw e;
    }
    if (registry.has(pack.action))
      throw new Error(`动作名和已有的撞了：${pack.action}。换个名字（比如 tea_drink）`);

    const run = async () => {
      const b = brain();
      if (pack.move) {
        if (!b || typeof b.call !== 'function')
          return { ok: false, reason: 'no_room', by: 'room', message: '屋子还没准备好' };
        const r = await b.call(pack.move, { target: pack.at });
        if (!r || r.ok === false) return r || { ok: false, reason: 'move_failed', by: 'room' };
      }
      const w = win();
      if (pack.pose && w?.__state && w.__state.poseName !== pack.pose) {
        if (typeof w.__apply !== 'function') return { ok: false, reason: 'no_room', by: 'room' };
        w.__apply(pack.pose);
      }
      if (pack.emotion) {
        const av = avatar();
        if (av && av.can?.('emotion')) av.setEmotion(pack.emotion);
      }
      return { ok: true, effect: pack.effect };
    };

    const def = registry.register({
      name: pack.action,
      description: pack.description,
      intent: pack.intent || pack.name,
      schema: {},
      run,
    });
    items.set(pack.action, { pack, def });
    log.push({ at: now(), op: 'add', id: pack.id, action: pack.action });
    return { ok: true, action: pack.action };
  }

  function unload(action) {
    if (!items.has(action)) return false;
    registry.unregister(action, { graceMs: 0 });
    items.delete(action);
    log.push({ at: now(), op: 'unload', action });
    return true;
  }

  const names = () => [...items.keys()];
  const list = () => [...items.values()].map(x => ({ ...x.pack }));

  return { add, unload, names, list, log: () => log.slice() };
}

/* 读目录。一份坏的活动不拖垮其余——和衣柜同一条规矩。 */
export async function loadActivities({ base = 'assets/world/activities/', fetchImpl = null,
                                       registry, getWin, getAvatar, getBrain } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('loadActivities 需要一个 fetch');
  const content = createWorldContent({ registry, getWin, getAvatar, getBrain });
  const problems = [];

  let index = null;
  try {
    const r = await f(base + 'index.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    index = await r.json();
  } catch (e) {
    return { content, problems: [{ file: 'index.json', error: String(e.message || e) }], loaded: 0 };
  }

  for (const entry of (index.activities || [])) {
    const p = typeof entry === 'string' ? entry : entry.file;
    if (!p) { problems.push({ file: '(index)', error: '这一项没有 file' }); continue; }
    try {
      const r = await f(base + p, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      content.add(await r.json());
    } catch (e) {
      problems.push({ file: p, error: String(e.message || e) });
    }
  }
  return { content, problems, loaded: content.names().length, index };
}
