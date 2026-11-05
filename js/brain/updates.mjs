/* 更新检查 —— 我这份是什么版本，外面有没有新的。
 * ============================================================
 * 只有一件事要保证：**它永远不许自作主张**。
 *
 * 三条界线，每条都有具体的坏结果在后面：
 *   ① 不自动更新。仓库里的 data/ 是他和她的事，覆盖一次就没了。
 *      所以这里只回答"有没有新的"，动手是人的事。
 *   ② 不许因为检查失败就说"你该更新"。没联网、仓库还没建、返回了别的网页——
 *      这些情况一律归到 unknown，页面上照实说"查不了"，不是"有新版本"。
 *   ③ 不许提示降级。开发时本地版本通常比已发布的**新**（0.2.0-dev 在改，
 *      外面还是 0.1.0）。这时候弹"有新版本"是错的，得说"你这份比发布版新"。
 *
 * 为什么把版本比较写成纯函数：这东西出错的方式很安静——
 * 把 0.10.0 判成比 0.9.0 小（字符串比较），于是所有人永远收不到更新提示，
 * 而且没有任何报错。只有断言能盯住它。
 */

/* 版本号：主.次.修订，可以带 -dev.3 这样的预发布尾巴，段可以少写（0.1 = 0.1.0）。
 * 返回 null 表示这不是版本号——调用方要当"读不懂"处理，不要当 0。 */
export function parseVersion(s) {
  const m = String(s == null ? '' : s).trim()
    .match(/^v?(\d{1,4})(?:\.(\d{1,4}))?(?:\.(\d{1,4}))?(?:-([0-9A-Za-z.-]{1,20}))?$/);
  if (!m) return null;
  return {
    major: +m[1],
    minor: m[2] == null ? 0 : +m[2],
    patch: m[3] == null ? 0 : +m[3],
    pre: m[4] || '',        // 有尾巴的是预发布版，比同号的正式版小
  };
}

/* 比大小。返回 -1 / 0 / 1。读不懂的一方按"无法比较"返回 null——
 * 这不是偷懒：把读不懂的当 0 会让 0.0.1 显得比 'abc' 大，
 * 于是别人 tag 写错了，更新检查还一本正经地说"你是最新版"。 */
export function compare(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  /* 同号：没有尾巴的更大（1.0.0 > 1.0.0-dev）。
   * 两边都有尾巴时按字典序——够用，且不会把 -dev.10 判成小于 -dev.9 之外还出别的幺蛾子。 */
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre === y.pre ? 0 : (x.pre < y.pre ? -1 : 1);
}

/* 更新日志归一化：文件是人手写的，字段缺一半是常态。
 * 这里只保证"拿到什么都不会崩"，不替人补内容——补出来的内容是假的。 */
export function normalizeNotes(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((n) => n && typeof n === 'object')
    .map((n) => ({
      v: typeof n.v === 'string' ? n.v : '',
      date: typeof n.date === 'string' ? n.date : '',
      kind: ['release', 'fix', 'content', 'security'].includes(n.kind) ? n.kind : 'release',
      title: typeof n.title === 'string' ? n.title : '',
      items: Array.isArray(n.items) ? n.items.filter((s) => typeof s === 'string' && s.trim()) : [],
    }))
    .filter((n) => n.v || n.title || n.items.length);
}

export const KIND_LABEL = {
  release: '新版本',
  fix: '修好了',
  content: '新内容',
  security: '安全',
};

/* 状态只有四个，页面上一个都不许漏：
 *   unknown  查不了（没配地址 / 没联网 / 返回看不懂）——照实说，不许说成"最新"
 *   current  已经是最新
 *   newer    外面有新的
 *   ahead    你这份比发布版新（开发分支）
 *
 * `reason` 是给不写代码的人看的：整个功能的信任都压在"失败时说清楚为什么"上。 */
export function createUpdates({
  local = {},
  url = '',
  intervalMs = 6 * 3600 * 1000,
  timeoutMs = 5000,
  fetchJson,
  now = () => Date.now(),
  readCache = () => null,
  writeCache = () => {},
  storageKey = 'life.updates',
} = {}) {
  const localVersion = typeof local.version === 'string' ? local.version : '';
  let state = {
    status: 'unknown',
    localVersion,
    remoteVersion: '',
    reason: url ? '' : '这份还没有发布地址，查不了外面有没有新的',
    checkedAt: 0,
    remote: null,
  };
  let inflight = null;

  function settle(patch) {
    state = { ...state, ...patch, checkedAt: patch.checkedAt || now() };
    try { writeCache(storageKey, state); } catch (e) { /* 存不下就存不下，不影响判断 */ }
    return state;
  }

  /* 一次检查。重复调用会复用同一个请求——页面加载时可能两处同时问
   * （顶部徽标 + 更新页），发两次请求既慢又可能一半成功一半失败。 */
  function check({ force = false } = {}) {
    if (!url) {
      return Promise.resolve(settle({ status: 'unknown', reason: '这份还没有发布地址，查不了外面有没有新的' }));
    }
    const cached = readCache(storageKey);
    if (!force && cached && typeof cached === 'object'
        && cached.checkedAt && now() - cached.checkedAt < intervalMs
        && cached.status && cached.status !== 'unknown') {
      state = { ...state, ...cached };
      return Promise.resolve(state);
    }
    if (inflight) return inflight;

    inflight = (async () => {
      let remote;
      try {
        remote = await fetchJson(url, { timeoutMs });
      } catch (e) {
        const msg = String((e && e.message) || e || '');
        /* 三种失败要说成三种话。全都说成"检查失败"的话，
         * 用户不知道该改网络还是该改地址。 */
        const reason = /超时|timeout|abort/i.test(msg) ? '连不上（超时）——大概是没联网'
          : /404/.test(msg) ? '地址上没有这个文件（仓库还没推，或者路径写错了）'
          : /JSON|解析/i.test(msg) ? '那个地址返回的不是 JSON（可能是网页、也可能是登录页）'
          : '查不了：' + (msg || '不知道原因');
        inflight = null;
        return settle({ status: 'unknown', reason, remoteVersion: '' });
      }

      const rv = remote && typeof remote.version === 'string' ? remote.version : '';
      if (!rv || !parseVersion(rv)) {
        inflight = null;
        return settle({ status: 'unknown', reason: '那个地址上的 version.json 里没有能读懂的 version 字段', remoteVersion: '' });
      }

      const c = compare(rv, localVersion);
      if (c == null) {
        inflight = null;
        return settle({ status: 'unknown', reason: `读不懂版本号（本地 ${localVersion || '空'} / 远端 ${rv}）`, remoteVersion: rv });
      }

      const status = c > 0 ? 'newer' : (c === 0 ? 'current' : 'ahead');
      const reason = status === 'newer' ? `外面有 ${rv}`
        : status === 'current' ? '已经是最新的'
        : `你这份（${localVersion}）比发布版（${rv}）新——大概是开发分支`;
      inflight = null;
      return settle({ status, reason, remoteVersion: rv, remote });
    })();

    return inflight;
  }

  /* 启动时先亮缓存里上次的结论，别让页面空着一片"检查中"。
   * 但缓存陈旧要标出来：昨天说有新版，今天可能已经装上了。 */
  function boot() {
    const cached = readCache(storageKey);
    if (cached && typeof cached === 'object' && cached.status) {
      state = { ...state, ...cached };
      if (cached.checkedAt && now() - cached.checkedAt > 24 * 3600 * 1000) {
        state.reason = (state.reason ? state.reason + '（' : '（') + '这是很久以前查的结果';
      }
    }
    return state;
  }

  return {
    local() {
      return {
        version: localVersion,
        released: typeof local.released === 'string' ? local.released : '',
        channel: typeof local.channel === 'string' ? local.channel : '',
        notes: normalizeNotes(local.notes),
      };
    },
    notes() { return normalizeNotes((state.remote && state.remote.notes) || local.notes); },
    state() { return { ...state, newer: state.status === 'newer' }; },
    check,
    boot,
    /* 点了"知道了"就记住，别再拿同一个版本烦人。下次有新版本号会自动重新提醒。 */
    markSeen(version = state.remoteVersion) {
      try { writeCache(storageKey + '.seen', { v: version, at: now() }); } catch (e) {}
    },
    seen() {
      const s = readCache(storageKey + '.seen');
      return !!(s && s.v && s.v === state.remoteVersion);
    },
    /* 页面徽标用：有新版、而且这个版本还没被点掉过，才亮。 */
    badge() {
      return state.status === 'newer' && !this.seen();
    },
  };
}

/* 浏览器环境的现成装配：本地 version.json + 远端 version.json + localStorage 缓存。 */
export function mountUpdates({ fetchJson } = {}) {
  const getJson = fetchJson || (async (u, { timeoutMs = 5000 } = {}) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(u, { signal: ac.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      try { return JSON.parse(txt); } catch (e) { throw new Error('返回的不是 JSON'); }
    } finally { clearTimeout(t); }
  });

  return (async () => {
    let local = {};
    try { local = await getJson('./version.json', { timeoutMs: 3000 }); } catch (e) { local = {}; }
    const url = (local && local.check && typeof local.check.url === 'string') ? local.check.url.trim() : '';
    const hours = (local && local.check && Number(local.check.intervalHours)) || 6;
    return createUpdates({
      local,
      url,
      intervalMs: Math.max(1, hours) * 3600 * 1000,
      fetchJson: getJson,
      readCache: (k) => {
        try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; }
      },
      writeCache: (k, v) => {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
      },
    });
  })();
}
