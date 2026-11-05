/* 感知层：只报告"世界变了"，不决定她该有什么反应
 * ------------------------------------------------------------
 * 这一层的定位，是照 AIRI 的 perception 改的，但砍掉了它的"阈值/窗口"那部分。
 * 理由是：阈值和窗口是给连续信号（视线停留、语音强度）用的，我们现在的世界是离散的
 * —— 灯要么开要么关，姿态要么坐要么站。离散的东西做差就够了，加阈值只会让"灯灭了"
 * 有时候不报，变成查不出来的怪事。
 *
 * 三条硬规矩：
 *   ① **只报告，不反应**。规则命中后只往待执行队列里放一条记录；选什么动作是模型的事。
 *      这也是上一版"规则表代替定时器"被否掉的原因：那一版让规则直接挑动作，
 *      等于外面替她决定。现在规则只负责"这件事值得一顾"。
 *   ② **不做无变化的观察**。前后签名一样就直接返回，不产生任何记录，不调用模型。
 *      （Neuro 的 BEST_PRACTICES 原话：不要发连续的状态更新。这里是同一个道理。）
 *   ③ **开机第一次观察只立基线**。不然开机那一刻"灯本来是亮的"会被当成"灯刚被打开"。
 *
 * 规则文件是 JSON 不是 YAML：项目现在是零依赖，加一个 YAML 解析器只为了少打几个引号
 * 不划算。格式见 rules/room.json 与 设计-目标形态-2026-11-05.md。
 */

import { normalizeWorld, diffWorld, worldSignature } from './world.mjs';
import { REASONS } from './initiative.mjs';

export const CHANGE_TYPES = ['pose', 'near', 'light', 'present'];
const WHEN_KEYS = new Set(['change', 'label', 'from', 'to', 'by']);
/* 事件类（瞬时）的 when 只允许这几个键：它没有"从什么变成什么"，也没有"状态"。 */
const EVENT_WHEN_KEYS = new Set(['event', 'by']);
const FILL_KEYS = ['label', 'from', 'to', 'by'];

const fmt = v => (v === true ? '开' : v === false ? '关' : v == null ? '无' : String(v));

/* 规则写错要当场报错。默默不生效是最坏的情况：
   用户加了一条规则，观察三天没反应，最后发现是字段名写错了。 */
export function loadRules(input) {
  const list = Array.isArray(input) ? input : (input && input.rules) || [];
  const seen = new Set();
  return list.map((r, i) => {
    const where = `第 ${i + 1} 条规则`;
    if (!r || typeof r !== 'object') throw new Error(`${where}不是对象`);
    if (!r.id || !String(r.id).trim()) throw new Error(`${where}没有 id`);
    if (seen.has(r.id)) throw new Error(`规则 id 重复：${r.id}`);
    seen.add(r.id);

    const when = r.when || {};
    /* 快照类和事件类是两条路，不能混：快照有"变成什么"，事件没有。
     * 一条规则同时写 change 和 event，就说不清它到底在等哪一件——当场报错，
     * 不要让它在运行时悄悄只命中一半。 */
    const isEvent = 'event' in when;
    if (isEvent && 'change' in when)
      throw new Error(`规则 ${r.id} 同时写了 when.change 和 when.event：这两条路不一样，只能写一个`);
    if (isEvent) {
      if (!String(when.event || '').trim()) throw new Error(`规则 ${r.id} 的 when.event 不能空`);
      for (const k of Object.keys(when)) if (!EVENT_WHEN_KEYS.has(k))
        throw new Error(`规则 ${r.id} 等的是事件，when.${k} 不认识（事件没有 from/to/label）`);
    } else {
      if (!CHANGE_TYPES.includes(when.change))
        throw new Error(`规则 ${r.id} 的 when.change 只能是 ${CHANGE_TYPES.join('/')}，收到：${when.change}`);
      for (const k of Object.keys(when)) if (!WHEN_KEYS.has(k)) throw new Error(`规则 ${r.id} 的 when.${k} 不认识`);
    }
    if ('by' in when && !['her', 'him', 'none', 'unknown'].includes(when.by))
      throw new Error(`规则 ${r.id} 的 when.by 只能是 her/him/none/unknown`);

    const e = r.emit || {};
    if (!REASONS.includes(e.reason)) throw new Error(`规则 ${r.id} 的 emit.reason 只能是 ${REASONS.join('/')}`);
    if (!e.target) throw new Error(`规则 ${r.id} 的 emit.target 是队列里的 id（同一件事要能合并）`);
    if (!e.detail) throw new Error(`规则 ${r.id} 的 emit.detail 是进提示词的那句话，不能空`);
    if (e.candidates && !Array.isArray(e.candidates)) throw new Error(`规则 ${r.id} 的 emit.candidates 要是数组`);

    return { id: r.id, when, emit: { ...e, candidates: e.candidates || [] } };
  });
}

function matchWhen(when, c) {
  if (when.change !== c.type) return false;
  if (when.label !== undefined && when.label !== (c.label ?? null)) return false;
  if (when.by !== undefined && when.by !== c.by) return false;
  if ('from' in when && when.from !== c.from) return false;
  if ('to' in when && when.to !== c.to) return false;
  return true;
}

const fill = (tpl, c) => String(tpl)
  .replace(/\{\{\s*label\s*\}\}/g, c.label ?? '')
  .replace(/\{\{\s*from\s*\}\}/g, fmt(c.from))
  .replace(/\{\{\s*to\s*\}\}/g, fmt(c.to))
  .replace(/\{\{\s*by\s*\}\}/g, c.by ?? 'unknown')
  /* 事件类才有：{{event}} 是事件类型，{{text}} 是事件自己带的那句话 */
  .replace(/\{\{\s*event\s*\}\}/g, c.event ?? '')
  .replace(/\{\{\s*text\s*\}\}/g, c.text ?? '');

/* 事件 = 没有"恢复"的那种事（他敲了一下键盘、切到了别的窗口、游戏里死了一次）。
 * 它不能进快照：快照要能做差，而"敲了一下"永远没有反向状态——
 * 一旦做成布尔，就必须靠"多久没敲"来变回 false，那一秒就变成定时器了。 */
function matchEvent(when, ev) {
  if (when.event !== ev.event) return false;
  if (when.by !== undefined && when.by !== ev.by) return false;
  return true;
}

export function createPerception({ rules = [], raise = null, now = () => Date.now() } = {}) {
  let list = loadRules(rules);
  let last = null;              // 上一张快照；null 表示还没立基线
  let observations = 0;
  /* 同一件事**在窗口内**出现几次：emit.target -> 时间戳数组。
   * 为什么要有窗口、而且是"最近十分钟"而不是"今天第几次"：
   *   灯一晚上被拨八十下是常态，报"今天第 80 次"没人听得懂；
   *   "十分钟里第 4 次"才是她那会儿真感觉到的东西。
   * 为什么要按 target 记在**感知层**、而不是记在发起层的记录上：
   *   发起层那条记录她一动手就结案删掉了（走过去看一眼 = acknowledged），
   *   下一次灯再变又是一条新记录、又从"第 1 次"开始。真跑里她就是这样
   *   一晚上把同一盏灯说了七八遍：每一遍在她眼里都是新的。
   */
  const TALLY_WINDOW = 10 * 60 * 1000;
  const counts = new Map();

  function tally(target) {
    const t = now();
    const arr = (counts.get(target) || []).filter(x => t - x <= TALLY_WINDOW);
    arr.push(t);
    counts.set(target, arr);
    return { occurrences: arr.length, firstAt: arr[0], lastAt: t };
  }
  const log = [];

  function setRules(input) { list = loadRules(input); return list.length; }

  /* 看一眼世界。返回这一眼看到的变化、因此入队的记录、以及没有人管的那些。
     unhandled 是故意返回的：它等于"这里有个缺口"，比静默好。 */
  function observe(world, { by = 'unknown' } = {}) {
    const cur = normalizeWorld(world);

    /* 空快照不算"世界变成什么都没有"。场景切换、模型还在加载、页面刚起来的那一瞬间，
       屋子会拿不出快照；这时候如果照做差，会得到"所有灯刚才都灭了"这种假事件
       （真跑时踩到过一次：探针传了个 {}，队列里立刻多出四条"刚被打开"）。
       宁可少报一次，不可报错一次。 */
    const usable = Boolean(cur.pose || cur.near || Object.keys(cur.lights).length);
    if (!usable) {
      log.push({ at: now(), op: 'unusable', sig: worldSignature(cur) });
      return { invalid: true, changes: [], raised: [], unhandled: [], observations };
    }

    if (last === null) {
      last = cur;
      log.push({ at: now(), op: 'baseline', sig: worldSignature(cur) });
      return { baseline: true, changes: [], raised: [], unhandled: [], observations };
    }

    // 签名一样：世界没变。直接走，一个字都不记（这就是"不发连续状态更新"）
    if (worldSignature(cur) === worldSignature(last)) {
      last = cur;
      return { baseline: false, changes: [], raised: [], unhandled: [], observations };
    }

    const changes = diffWorld(last, cur).map(c => ({ ...c, by }));
    last = cur;
    observations += 1;

    const raised = [], unhandled = [];
    for (const c of changes) {
      // **第一条命中的算数**，按文件里的顺序。所以具体的写在前面、通用的写在后面
      // （和防火墙一个道理）。允许多条同时命中就会一件事进两条记录，队列里还得去重。
      const r = list.find(x => matchWhen(x.when, c));
      if (!r) { unhandled.push(c); continue; }

      const e = r.emit;
      // target 也过一遍模板：一条规则要能管住"任何一盏灯"，不然四盏灯要写四条
      const target = fill(e.target, c);
      const { occurrences, firstAt, lastAt } = tally(target);

      // 窗口内第二次起改成 repeat：同一件事反复提，队列里该合并成一条并升优先级
      const reason = occurrences >= 2 && e.reason === 'signal' ? 'repeat' : e.reason;
      const detail = fill(e.detail, c);

      let record = null;
      if (typeof raise === 'function') {
        record = raise({ reason, target, detail, candidates: e.candidates.slice(), priority: e.priority,
          occurrences, firstAt, lastAt });
      }
      raised.push({ rule: r.id, change: c, reason, target, detail, occurrences, record });
      log.push({ at: now(), op: 'raise', rule: r.id, change: c, reason, target, detail, occurrences });
    }

    for (const c of unhandled) log.push({ at: now(), op: 'unhandled', change: c });
    return { baseline: false, changes, raised, unhandled, observations };
  }

  /* 投递一件事：**没有恢复**的那种（他敲了一下键盘、切了窗口、游戏里死了一次）。
   * 和 observe 是两条路，但共用同一份规则表和同一个待执行队列——
   * 因为对大脑来说，"灯灭了"和"他切走了"没有区别，都是"有件事值得一顾"。
   *
   * 这条通道现在**没有真实事件源**（网页里他说话已经单独处理了）。
   * 它是给桌面壳和游戏留的门：那边一有事件，调这个方法就行，大脑一行不改。 */
  function signal(ev = {}) {
    const type = String(ev.type ?? '').trim();
    if (!type) throw new Error('signal 必须带 type：事件得有名字');

    const item = { event: type, text: ev.detail || '', by: ev.by || 'unknown', at: now() };
    const r = list.find(x => x.when.event && matchEvent(x.when, item));
    if (!r) {
      log.push({ at: now(), op: 'unhandled_event', event: type });
      return { matched: false, rule: null, raised: null };
    }

    const e = r.emit;
    const target = fill(e.target, item);
    const { occurrences, firstAt, lastAt } = tally(target);
    const reason = occurrences >= 2 && e.reason === 'signal' ? 'repeat' : e.reason;
    const detail = fill(e.detail, item) || item.text;

    let record = null;
    if (typeof raise === 'function') {
      record = raise({ reason, target, detail, candidates: e.candidates.slice(), priority: e.priority,
        occurrences, firstAt, lastAt });
    }
    log.push({ at: now(), op: 'raise_event', rule: r.id, event: type, reason, target, detail });
    return { matched: true, rule: r.id, reason, target, detail, record };
  }

  /* 换了场景/新角色时清空基线：否则"上一个房间的灯是开的"会污染这一个 */
  function reset() { last = null; counts.clear(); }

  return {
    observe, signal, reset, setRules,
    rules: () => list.slice(),
    log: () => log.slice(),
    /* 调试用：每个 target 在窗口内的次数和最早一次的时间 */
    counts: () => Object.fromEntries([...counts].map(([k, v]) => [k, { times: v.length, firstAt: v[0], lastAt: v[v.length - 1] }])),
    get observations() { return observations; },
    get baselineReady() { return last !== null; },
  };
}
