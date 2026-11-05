/* 猜数字：一个真能玩的小游戏，用来证明游戏端口是通的
 * ------------------------------------------------------------
 * 它写的不是"怎么玩"，是"这一局现在什么局面、你能做什么"。
 * 她猜一个数，游戏回"大了/小了"；每次回话都是一件真事，
 * 所以她可以接着玩——不是因为定时器在催她，是因为游戏刚回了她一句。
 *
 * 这个适配器只暴露语义动作 guess_number(n)。
 * 没有坐标、没有按钮、没有像素——那些是屏幕版适配器的事。
 */

export function guessGame({ min = 1, max = 100, maxTurns = 12, rng = Math.random } = {}) {
  let secret = 0, low = min, high = max, tries = 0, over = true, last = null;
  let ctx = null;

  const reset = () => {
    secret = min + Math.floor(rng() * (max - min + 1));
    low = min; high = max; tries = 0; over = false; last = null;
  };

  const hintOf = n => (n === secret ? '对了' : n < secret ? '小了' : '大了');

  const api = {
    id: 'guess',
    name: '猜数字',
    mode: 'api',
    note: `${min}~${max}，每次猜一个整数，游戏告诉你大了还是小了。`,

    actions: [
      {
        name: 'guess_number',
        description: `猜一个 ${min}~${max} 之间的整数`,
        intent: '猜一个数',
        schema: { n: { type: 'int', min, max } },
      },
      {
        name: 'give_up',
        description: '这局不猜了，看答案',
        intent: '不猜了',
        schema: {},
      },
    ],

    start(c) {
      ctx = c;
      reset();
      ctx?.emit?.('game_start', `坐下来玩猜数字，${min} 到 ${max}，猜一个数。`);
    },

    state() {
      return {
        game: '猜数字',
        status: over ? '结束了' : '进行中',
        tries,
        lo: low,
        hi: high,
        last: last ? { n: last.n, hint: last.hint } : null,
      };
    },

    brief() {
      if (over) return `猜数字这局已经结束了${last?.hint === '对了' ? '，你猜对了' : ''}。`;
      const lastText = last ? `上次猜 ${last.n}，${last.hint}；` : '还没猜过；';
      return `${min}~${max}，${lastText}现在范围是 ${low}~${high}，已经猜了 ${tries} 次。`;
    },

    async act(name, args = {}) {
      if (name === 'give_up') {
        over = true;
        const answer = secret;
        ctx?.emit?.('game_over', `她不想猜了，答案是 ${answer}。`);
        return { ok: true, effect: `不猜了，答案是 ${answer}` };
      }
      if (name !== 'guess_number') return { ok: false, reason: 'no_such_action', message: '这一局没有这个动作' };
      if (over) return { ok: false, reason: 'game_over', message: '这一局已经结束了' };

      const n = Number(args.n);
      if (!Number.isInteger(n) || n < min || n > max)
        return { ok: false, reason: 'bad_arg', by: 'her', message: `要猜 ${min} 到 ${max} 之间的整数` };

      /* 重复猜同一个数不算一次：她要是没听清，别拿次数罚她 */
      if (last && last.n === n)
        return { ok: true, effect: `又猜了 ${n}，还是${last.hint}`, already: true };

      tries += 1;
      const hint = hintOf(n);
      last = { n, hint };
      if (hint === '对了') {
        over = true;
        ctx?.emit?.('game_over', `她猜对了，是 ${n}，用了 ${tries} 次。`);
        return { ok: true, effect: `猜 ${n}，对了，第 ${tries} 次猜中` };
      }

      if (hint === '小了') low = Math.max(low, n + 1);
      else high = Math.min(high, n - 1);

      /* 每次回话都是一件真事。她可以接着玩，也可以起身走开——
       * 不是"每 5 秒提醒她一次"，是"游戏刚回了她一句"。 */
      if (tries >= maxTurns) {
        over = true;
        ctx?.emit?.('game_over', `猜了 ${maxTurns} 次还没中，答案是 ${secret}。`);
        return { ok: true, effect: `猜 ${n}，${hint}；次数用完了，答案是 ${secret}` };
      }
      if (ctx?.autoContinue) {
        ctx.emit('game_turn', `她猜 ${n}，${hint}。现在范围是 ${low}~${high}。`);
      }
      return { ok: true, effect: `猜 ${n}，${hint}；范围缩到 ${low}~${high}` };
    },

    stop() { over = true; ctx = null; },
  };

  reset();
  return api;
}
