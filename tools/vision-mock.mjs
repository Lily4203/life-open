/* 假的看图服务：只用来验证管线，不产生任何"看见"
 * ------------------------------------------------------------
 * 它假装自己是智谱的 /v1/chat/completions，回一句固定的"看见"。
 * 为什么要有它：没 key 的时候，"没配置"和"配了但坏了"看起来一样。
 * 有了它，截屏→缩图→投事件这条链能不能走通，可以在没有一分钱额度的情况下证明。
 *
 * 跑：PORT=8791 node tools/vision-mock.mjs
 * 然后让服务指向它：VISION_BASE=http://127.0.0.1:8791/v1
 * 三种坏天气：MOCK_MODE=fail（500）/ limit（429）/ noise（不按 JSON 回）
 */
import http from 'node:http';

const MODE = process.env.MOCK_MODE || 'ok';

http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const j = (() => { try { return JSON.parse(body || '{}'); } catch { return {}; } })();
    const parts = j?.messages?.[0]?.content || [];
    const hasImg = Array.isArray(parts) && parts.some(p => p?.type === 'image_url');
    console.log(`[mock] ${req.method} ${req.url} image=${hasImg} bytes=${body.length}`);

    if (MODE === 'fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end('{"error":"mock boom"}');
    }
    if (MODE === 'limit') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end('{"error":"quota"}');
    }
    if (MODE === 'noise') {
      // 故意不按 JSON 回：验证"模型不听话时降级成一句话"
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: '他在一个黑底白字的窗口里改东西，屏幕上有一行红字。' } }] }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        what: '他在写代码，屏幕上有一行红色报错', entities: ['编辑器', '报错'], private: false,
      }) } }],
      usage: { total_tokens: 812 },
    }));
  });
}).listen(Number(process.env.PORT || 8791), '127.0.0.1', () => {
  console.log('[mock] 假看图服务在 ' + (process.env.PORT || 8791) + '  mode=' + MODE);
});
