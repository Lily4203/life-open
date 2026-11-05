/* 存储接口的 Node 实现。浏览器侧换成 localStorage 即可，memory.mjs 不认平台。
 * 目录默认 life/memory/<charId>/，和旧 memory/ 目录分开：
 * 那个是 DSH/QQ 侧的老结构，这里是"屋子里的她"用的，混在一起以后分不清谁是谁。 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function nodeStore(dir) {
  const full = name => join(dir, name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return {
    dir,
    read: name => { try { return readFileSync(full(name), 'utf8'); } catch { return null; } },
    write: (name, s) => writeFileSync(full(name), s, 'utf8'),
    append: (name, s) => appendFileSync(full(name), s, 'utf8'),
    exists: name => existsSync(full(name)),
  };
}

/* 浏览器用的：同一个接口，键名前缀。真接页面时再传进来，核心不用改一行。 */
export function webStore(prefix = 'fish:') {
  return {
    read: name => localStorage.getItem(prefix + name),
    write: (name, s) => localStorage.setItem(prefix + name, s),
    append: (name, s) => localStorage.setItem(prefix + name, (localStorage.getItem(prefix + name) || '') + s),
  };
}
