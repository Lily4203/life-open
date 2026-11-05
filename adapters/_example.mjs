/* 示例适配器：一条不会打扰人的线
 * ------------------------------------------------------------
 * 下划线开头 = 不自动加载。想用它：
 *   复制成 example.mjs（去掉下划线），重启服务。
 *
 * 它每 30 秒发一句"示例到点了"——只在设了环境变量时发，
 * 不然一个照抄的模板会默认往她的记忆里灌废话。
 *
 * 这是最小可用的骨架：没有协议、没有重连、没有鉴权。
 * 真实的一条线（QQ/弹幕）要在这三件事上多写，别的地方一模一样。
 */

let timer = null;
let count = 0;

export default {
  id: 'example',
  label: '示例线',
  where: '示例',

  start(send) {
    /* 环境变量是"临时打开"的意思：改代码改环境都行，
     * 但别让一个模板在别人那儿默默开始说话。 */
    if (process.env.ADAPTER_EXAMPLE !== '1') {
      console.log('[example] 没发东西：要跑就设 ADAPTER_EXAMPLE=1（这是故意的，模板不该默认开口）');
      return;
    }
    timer = setInterval(() => {
      count += 1;
      /* source 用现有的词：group / danmaku / voice / script / game。
       * 写自己的 id 会被退回 script——不是错，只是别指望那个词有含义。 */
      const r = send({
        text: `示例第 ${count} 句。`,
        from: 'example',
        name: '示例',
        source: 'script',
      });
      if (!r?.ok) console.log('[example] 没送出去：' + (r?.reason || '?'));
    }, 30e3);
  },

  stop() {
    if (timer) clearInterval(timer);
    timer = null;
  },

  /* 进 /api/health。别返回大对象——这就是给人"一眼看明白"用的。 */
  state() {
    return { on: !!timer, sent: count };
  },
};
