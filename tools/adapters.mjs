/* 外线插槽：别人往这间屋子里接一条线，只要放一个文件
 * ============================================================
 * 为什么要有这一层，而不是"照文档写个脚本 POST /api/in"：
 *   后者要读一篇文档、自己写重连、自己管进程、自己处理"页面没开时怎么办"；
 *   前者是"扔一个 .mjs 进来，重启服务"。一个项目对外好不好接，
 *   差别就在这两句话之间。功能上它俩是同一件事——这里最后还是走 pushIn。
 *
 * 契约（adapters/ 下一个 .mjs，export default {...}）：
 *   id     必填，唯一，小写蛇形（'qq' / 'bili' / 'heibox'）。重名当场报错，不覆盖。
 *   label  人看的名字（'QQ 群'）。没有就用 id。
 *   where  这些话在她世界里**从哪来**，一个人话名词（'手机' / '屏幕上'）。
 *          会跟着每一句话进她的记忆，渲染成 [小明·手机]。
 *          不写就是"不知道从哪来"——不替她编一个装置。
 *   start(send)  必填。send({text, from, name, source, where})，一行一条。
 *                协议、重连、鉴权、心跳，全归适配器自己；这一层不知道 QQ 是什么。
 *   stop()       可选。进程退出时调。
 *   state()      可选。返回一个扁平对象，进 /api/health——让人看得见"连着没有"。
 *
 * 三条硬规矩（都写在代码里，不靠自觉）：
 *   ① 一个适配器起不来，不许把别的拖下水。和衣柜里坏一件不拖垮其余，同一条。
 *   ② 失败必须留痕。import 失败、start 抛错、send 抛错，都进 health 的 error。
 *      静默的插件比没有插件更难查——"她怎么听不到 QQ"会查一整天。
 *   ③ 这一层不判断"她要不要回"。收下就是收下，回不回是 chat-in 后面的事。
 *
 * 文件名以 _ 或 . 开头的不自动加载（`_example.mjs` 就是给人复制改名的）。
 *
 * ⚠ 一句实话：消息只推给**开着的页面**。没有页面在听时最多排 50 条（serve.mjs 的
 *   IN.maxQueue），再多的丢，并且 dropped 计数。所以"她没在的时候刷屏"会丢东西，
 *   这不是 bug，是"她不在场"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const MAX_TEXT = 500;

export function createAdapters({ dir, send, log = () => {}, now = () => Date.now(),
                                 importModule = null } = {}) {
  if (!dir) throw new Error('createAdapters 要一个目录');
  if (typeof send !== 'function') throw new Error('createAdapters 要 send(msg)——消息往哪送');

  const items = new Map();     // id -> 记录
  const skipped = [];          // 没加载的（下划线、坏文件、重名）
  const doImport = importModule || (p => import(pathToFileURL(p).href));

  function wrapSend(rec) {
    return (msg = {}) => {
      const text = String(msg?.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text) { rec.errors += 1; rec.lastError = '空话不收'; return { ok: false, reason: 'empty' }; }
      rec.sent += 1;
      rec.lastAt = now();
      try {
        const r = send({
          text: text.slice(0, MAX_TEXT),
          /* 默认 from 用 id：她看到的是 guest:qq，不是一个没头没脸的"有人"。
           * 但 source 不给 id——source 的取值被 chat-in 的白名单管着
           * （local/danmaku/group/voice/script/game），写了 'qq' 会被退回 script，
           * 那还不如一开始就写对。想让"群里"认出来的，适配器自己传 group。 */
          from: String(msg.from ?? rec.id).slice(0, 40),
          name: String(msg.name ?? '').slice(0, 24),
          source: String(msg.source ?? 'script').slice(0, 16),
          where: String(msg.where ?? rec.where ?? '').slice(0, 24) || null,
          at: Number(msg.at) || now(),
        });
        return r && typeof r === 'object' ? r : { ok: true };
      } catch (e) {
        rec.errors += 1;
        rec.lastError = String(e?.message || e);
        return { ok: false, reason: 'send_failed', message: rec.lastError };
      }
    };
  }

  async function load() {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort();
    } catch {
      /* 没有这个目录不是错：整份项目的默认状态就是"一条外线都没接"。 */
      log('没有 adapters/ 目录，跳过');
      return { loaded: [], skipped: [], missing: true };
    }

    for (const file of files) {
      if (file.startsWith('_') || file.startsWith('.')) {
        skipped.push({ file, why: '下划线开头，不自动加载' });
        continue;
      }
      let mod;
      try {
        mod = (await doImport(path.join(dir, file)))?.default;
      } catch (e) {
        /* 语法错、依赖没装、顶层就抛——都算这一个文件的事，别的照跑。 */
        const why = 'import 失败：' + String(e?.message || e);
        skipped.push({ file, why });
        log(file + ' ' + why);
        continue;
      }
      if (!mod || typeof mod !== 'object') {
        skipped.push({ file, why: '没有 export default 一个对象' }); continue;
      }
      const id = String(mod.id || '');
      if (!ID_RE.test(id)) {
        skipped.push({ file, why: `id 不合格：'${id}'（要小写蛇形，1–24 字）` }); continue;
      }
      if (typeof mod.start !== 'function') {
        skipped.push({ file, why: '缺 start(send)' }); continue;
      }
      if (items.has(id)) {
        /* 不覆盖：两个文件抢一个 id，谁都猜不到最后活的是哪个。 */
        skipped.push({ file, why: `id 重名：${id}（已被 ${items.get(id).file} 用了）` }); continue;
      }

      const rec = {
        id, file,
        label: String(mod.label || id).slice(0, 24),
        where: mod.where ? String(mod.where).slice(0, 24) : null,
        mod,
        started: false, error: null, lastError: null,
        sent: 0, errors: 0, lastAt: null,
      };
      items.set(id, rec);
      try {
        /* start 允许 async：连 WS、登录这种事本来就是异步的。
         * 不 await 到"连上"——连不上是适配器自己的事，它该在 state() 里说。 */
        const r = mod.start(wrapSend(rec));
        if (r && typeof r.then === 'function') r.catch(e => {
          rec.error = String(e?.message || e); rec.started = false;
          log(`${id} start 后来失败了：${rec.error}`);
        });
        rec.started = true;
        log(`${id}（${rec.label}${rec.where ? ' · ' + rec.where : ''}）起来了`);
      } catch (e) {
        rec.error = String(e?.message || e);
        log(`${id} start 失败：${rec.error}`);
      }
    }
    return { loaded: [...items.values()].map(x => x.id), skipped };
  }

  function stopAll() {
    const out = [];
    for (const rec of items.values()) {
      if (!rec.started) continue;
      try { rec.mod.stop?.(); out.push({ id: rec.id, stopped: true }); }
      catch (e) { out.push({ id: rec.id, stopped: false, error: String(e?.message || e) }); }
      rec.started = false;
    }
    return out;
  }

  /* 给 /api/health 看。state() 是适配器自己写的，它抛错不许影响别人。 */
  function info() {
    return [...items.values()].map(rec => {
      let state = null, stateError = null;
      if (typeof rec.mod.state === 'function') {
        try { state = rec.mod.state(); }
        catch (e) { stateError = String(e?.message || e); }
      }
      return {
        id: rec.id, label: rec.label, where: rec.where, file: rec.file,
        started: rec.started, error: rec.error, lastError: rec.lastError,
        sent: rec.sent, errors: rec.errors,
        lastAt: rec.lastAt,
        idleMs: rec.lastAt ? now() - rec.lastAt : null,
        state, stateError,
      };
    });
  }

  return {
    load, stopAll, info,
    dir,
    get size() { return items.size; },
    skipped: () => skipped.slice(),
    /* 测试和排障用：手动发一条，看它落不落得下去 */
    feed: (id, msg) => items.has(id) ? wrapSend(items.get(id))(msg) : { ok: false, reason: 'no_such_adapter' },
  };
}
