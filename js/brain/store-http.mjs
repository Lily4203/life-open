/* 浏览器侧的存储：把记忆文件放到服务端 data/ 目录
 * ------------------------------------------------------------
 * 为什么不用 localStorage：换一个浏览器、清一次缓存，她就换了一个人。
 * 记忆必须落在文件上，和"重启"这件事对齐——重启进程、重启浏览器、换设备，读的都是同一份。
 *
 * 接口必须和 memory.mjs 要求的 {read, write, append} 一致，而 read 是**同步**的
 * （memory.load() 在构造后立刻同步读）。所以这里先 preload 一次全量，之后 read 走内存，
 * 写回是即发即忘（写失败会在控制台喊，不吞）。
 */

/* memories.json 是长期记忆条目（她自己写的），reads.log 是"她查过哪几条"。
 * 两份都必须在这里列出：preload 只抓列出来的文件，漏一个就等于重启后忘了。 */
export const MEM_FILES = ['identity.md', 'world.json', 'agenda.json', 'events.jsonl', 'relations.json',
                          'told.json', 'recalls.log', 'memories.json', 'reads.log'];

export function httpStore({ base = '/api/store', files = MEM_FILES } = {}) {
  const cache = new Map();
  const inflight = [];
  let ready = false;

  async function preload() {
    await Promise.all(files.map(async name => {
      try {
        const r = await fetch(`${base}/${name}`, { cache: 'no-store' });
        cache.set(name, r.ok ? await r.text() : '');
      } catch (e) {
        console.warn('[store] 读不到', name, e.message);
        cache.set(name, '');
      }
    }));
    ready = true;
    return [...cache.keys()].map(k => `${k}:${(cache.get(k) || '').length}B`).join(' ');
  }

  function push(name, text, append) {
    const p = fetch(`${base}/${name}${append ? '?append=1' : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text,
    }).then(r => { if (!r.ok) console.warn('[store] 写失败', name, r.status); })
      .catch(e => console.warn('[store] 写失败', name, e.message));
    inflight.push(p);
    return p;
  }

  return {
    preload,
    get ready() { return ready; },
    read: name => cache.get(name) ?? '',
    write(name, text) {
      cache.set(name, text);
      push(name, text, false);
    },
    append(name, text) {
      cache.set(name, (cache.get(name) || '') + text);
      push(name, text, true);
    },
    /* 测试用：等所有写回落地 */
    async flush() { await Promise.all(inflight.splice(0)); },
    dump: () => Object.fromEntries(files.map(n => [n, cache.get(n) || ''])),
  };
}
