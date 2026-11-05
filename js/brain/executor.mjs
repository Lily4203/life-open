/* 执行层：想的是她，动的是这里
 * ------------------------------------------------------------
 * 一句话分工：
 *   大模型只产出**意图**（"坐下"，对谁，哪一件），
 *   这个文件只负责**把意图变成动作**（走过去、坐下、换表情、落子、点那张牌）。
 *
 * 为什么要把这件事单独拎出来，而不是留在 loop 里顺手调一下：
 *   只要"决定做什么"和"碰世界"还在同一个函数里，早晚会长出
 *   `if (灯是关的) 顺手开一下` 这种代码——那就是执行层在替她做决定。
 *   拆开之后有一条能检查的线：
 *     loop 只认 {say, read, remember, forget, plan, done, do}
 *     executor 只认 {name, args}
 *   前者出现坐标/动作细节，是提示词的错；后者出现"要不要做"，是执行层的错。
 *
 * 这个文件**没有**什么（写下来是为了以后能查）：
 *   · 不调模型、不拼提示词、不看记忆、不判断"值不值得做"
 *   · 不改世界快照、不做规划、不产生议程
 *   · 不重试、不补救：失败就回一句人话，让下一轮的她自己决定
 *
 * 它有的只有三件事：
 *   ① 路由：这条意图归谁执行（屋子 / 游戏 / 身体）
 *   ② 顺序：一次只做一步，前一步没成就停（和派发层同一条规矩）
 *   ③ 回执：把"做成了什么 / 没做成什么、是谁的问题"写成她能读的一句话
 */

/* 三个执行端。名字固定下来，回执里能看出是哪一端做的，
 * 排错时不用再翻代码猜"这个动作到底走哪条路"。 */
export const PORTS = ['room', 'game', 'body'];

/* 一次最多几步。和 parseOut 的上限一致：模型一次最多给两个动作。
 * 放在执行层再拦一次，是因为"模型改了、解析没改"这种事一定会发生。 */
export const MAX_STEPS = 2;

export function createExecutor({ registry, avatar = null, game = null, now = () => Date.now(),
                                 record = null } = {}) {
  if (!registry) throw new Error('createExecutor 需要 registry：动作得有地方执行');

  const stats = {
    steps: 0, ok: 0, failed: 0, partial: 0,
    byPort: { room: 0, game: 0, body: 0 },
    says: 0, lastFail: null,
  };

  const isFn = (o, k) => o && typeof o[k] === 'function';
  const gameOwns = name => Boolean(game && isFn(game, 'owns') && game.owns(name));

  /* 意图 -> 一句她读得懂的话。
   * 成败都要有这句话：下一轮的她只读得到这句，读不到我们的 reason 码。 */
  const intentOf = name => {
    if (gameOwns(name) && isFn(game, 'intentOf')) return game.intentOf(name) || name;
    return registry.get?.(name)?.intent || name;
  };

  function receiptText(name, r) {
    if (!r) return `想${intentOf(name)}，但屋子没回话`;
    /* 第三态先说：停下来的回执不能写成"没成"。
     * 写成"没成：停下来了"她会以为屋子做不到，下次就不试了；
     * 写成"做成了"更糟——她会以为自己已经在那儿了。
     * 只陈述事实（停在哪），后面怎么解读是她下一轮的事。 */
    if (r.partial) return `你${r.effect || '做到一半停下了'}`;
    if (r.ok === false) return `你想${intentOf(name)}，但没成：${r.message || r.reason || '不知道原因'}`;
    return `你${r.effect || '做成了'}`;
  }

  /* 把任意一端的返回，收成同一种回执。
   * 执行端允许返回 false（旧动作这么写过），也允许抛异常——都变成回执，不冒泡。 */
  function norm(name, port, out, ms) {
    if (out === false) out = { ok: false, reason: 'refused' };
    const o = (out && typeof out === 'object') ? out : {};
    /* 三态：done / partial / failed。
     *   done    真做到了
     *   partial 做到一半被叫停（他喊了你，脚步停了）——既不是成功也不是失败
     *   failed  没做成，屋子或她自己的问题
     * ok 仍然是二值（ok === done），老代码不用改；要看"是不是停下"用 partial。 */
    const partial = o.partial === true;
    const ok = !partial && o.ok !== false;
    return {
      action: name, ok, partial, port, status: partial ? 'partial' : (ok ? 'done' : 'failed'),
      reason: partial ? (o.reason || 'stopped') : (ok ? null : (o.reason || 'refused')),
      by: (ok || partial) ? null : (o.by || (port === 'room' ? 'room' : port === 'game' ? 'game' : 'body')),
      effect: o.effect ?? null,
      message: o.message ?? null,
      ms: ms ?? null,
    };
  }

  /* ---- ① 做一步 ----
   * signal：他中途喊了一声。透传到动作里，由动作自己决定这一帧停不停。
   * 执行层不在这里"看时间"——什么时候该停是屋子的事（走路才有"停在半路"）。 */
  async function act(name, args = {}, { timeoutMs = 20000, signal = null } = {}) {
    if (!name) {
      return { action: null, ok: false, port: null, reason: 'no_action', by: 'her',
               message: '没说要做什么', effect: null };
    }
    const t0 = now();
    stats.steps += 1;

    let r;
    if (gameOwns(name)) {
      stats.byPort.game += 1;
      try {
        /* 有 call 就走注册表（schema/窗口/超时都复用），没有才退到裸 act。
         * 游戏动作不该有第二条执行路径，否则它会绕过校验。 */
        const out = typeof game.call === 'function'
          ? await game.call(name, args, { timeoutMs, signal })
          : await game.act(name, args);
        r = norm(name, 'game', out, now() - t0);
      } catch (e) {
        r = { action: name, ok: false, port: 'game', reason: e.code || 'threw', by: 'game',
              message: String(e.message || e), effect: null, ms: now() - t0 };
      }
    } else {
      stats.byPort.room += 1;
      try {
        r = norm(name, 'room', await registry.call(name, args, { timeoutMs, signal }), now() - t0);
      } catch (e) {
        // registry.call 自己吞异常；这里兜的是"registry 都不认识了"的配置错
        r = { action: name, ok: false, port: 'room', reason: e.code || 'threw', by: 'room',
              message: String(e.message || e), effect: null, ms: now() - t0 };
      }
    }

    /* 三件不同的事，记在三处：
     *   做到 → ok；停下 → partial（不是失败，不写 lastFail，不进 failed）；
     *   没做成 → failed + lastFail（排错要看这个）。 */
    if (r.partial) stats.partial += 1;
    else if (r.ok) stats.ok += 1;
    else {
      stats.failed += 1;
      stats.lastFail = { name, args, reason: r.reason, by: r.by, message: r.message, at: now() };
    }
    return r;
  }

  /* ---- ② 走完这一轮的动作表 ----
   * 顺序不能并行：她说了"走过去坐下"，走过去没成，坐下就不该发生。
   * 失败即停，不是"跳过这一步继续下一步"——那会让她做出没头没尾的事。
   * 停下（partial）也即停：他已经叫了，这一轮到此为止，剩下的事留给她下一轮决定。 */
  async function run(doList = [], { place = null, timeoutMs = 20000, signal = null } = {}) {
    const list = (Array.isArray(doList) ? doList : []).slice(0, MAX_STEPS);
    const results = [];
    for (const d of list) {
      if (!d || !d.name) continue;
      const r = await act(d.name, d.args || {}, { timeoutMs, signal });
      const text = receiptText(d.name, r);
      results.push({ ...d, ...r, text });
      if (typeof record === 'function') {
        /* 停下来的那条也进记忆（salience 略高）：她下一轮要读到"我停在哪"，
         * 不读到就会以为自己还走在路上，或者以为自己已经到了。 */
        record({ who: 'fish', kind: 'did', text, place,
                 salience: r.partial ? 0.75 : (r.ok === false ? 0.7 : 0.4) });
      }
      if (r.partial || r.ok === false) break;
    }
    return results;
  }

  /* ---- ③ 说话 / 表情：也是"行为"，也必须走这里 ----
   * 从前 loop 只执行 do，说话由页面自己调 avatar.say。
   * 结果两边都能说话，谁先谁后全看调用顺序——两个窗同时开就会抢。
   * 收进来之后，"她这一轮说了什么"只有一个出口。 */
  /* opt 只影响"怎么说"（接在字幕后面 / 只上字不出声），不影响"说什么"。
   * 流式时一句话会分几次交上来，所以这个口子必须有；不给就还是老行为。 */
  function speak(text, opt = null) {
    stats.says += 1;
    stats.byPort.body += 1;
    if (!text) return { ok: false, port: 'body', reason: 'empty', message: '没有说话内容' };
    if (!avatar || !isFn(avatar, 'say')) {
      return { ok: false, port: 'body', reason: 'no_backend', message: '这具身体不能说话' };
    }
    try {
      const r = avatar.say(String(text), opt);
      return { ...r, port: 'body', text: String(text) };
    } catch (e) {
      return { ok: false, port: 'body', reason: 'threw', message: String(e.message || e), text: String(text) };
    }
  }

  function express(emotion) {
    stats.byPort.body += 1;
    if (!avatar || !isFn(avatar, 'setEmotion')) {
      return { ok: false, port: 'body', reason: 'no_backend', message: '这具身体没有表情' };
    }
    try {
      return { ...avatar.setEmotion(emotion), port: 'body' };
    } catch (e) {
      return { ok: false, port: 'body', reason: 'threw', message: String(e.message || e) };
    }
  }

  return {
    act, run, speak, express,
    /* 只读：给状态栏和排错用。执行层不因为被读就改变什么。 */
    stats: () => ({ ...stats, byPort: { ...stats.byPort }, lastFail: stats.lastFail ? { ...stats.lastFail } : null }),
    intentOf,
  };
}
