/* 一次性的 HTTPS 请求，走本机代理
 * ------------------------------------------------------------
 * 为什么不用 fetch：Node 22 的 fetch 不认 HTTP_PROXY，而本机直连 api.deepseek.com 是断的
 * （实测：直连挂住，走 127.0.0.1:55048 才通）。装 undici 要多一个依赖，
 * 所以这里自己做两件事：先 CONNECT 打通隧道，再把 HTTP/1.1 写在已经加密的 socket 上。
 *
 * 两个出口：
 *   requestJSON    攒完再给（普通接口用这个）
 *   requestStream  边到边给（流式用这个）—— 攒完再给就没有"流"了，所以它必须分开
 *
 * 流式那条只负责搬字节和分帧，不认识任何厂商的 JSON：见 js/brain/sse.mjs 的分层说明。
 */
import http from 'node:http';
import tls from 'node:tls';
import { createSseDecoder } from '../js/brain/sse.mjs';

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
const NO_PROXY_HOSTS = /^(127\.0\.0\.1|localhost)$/i;

function tunnel(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const req = http.request({
      host: p.hostname, port: p.port, method: 'CONNECT',
      path: `${host}:${port}`, timeout: timeoutMs,
      headers: p.username ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64') } : {},
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`代理 CONNECT 失败：${res.statusCode}`)); }
      const t = tls.connect({ socket, servername: host });
      t.once('secureConnect', () => resolve(t));
      t.once('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('代理连接超时')); });
    req.once('error', reject);
    req.end();
  });
}

/* 两个出口共用的开场：解析 URL、准备 body、必要时先打通隧道。
 * 抽出来是因为"怎么连"只有一处该有答案——两处各写一遍，早晚有一处忘了走代理。 */
async function open(url, { method = 'POST', headers = {}, body = null, timeoutMs = 60000 } = {}) {
  const u = new URL(url);
  const useProxy = PROXY && !NO_PROXY_HOSTS.test(u.hostname);
  const port = Number(u.port || 443);
  const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const socket = useProxy ? await tunnel(PROXY, u.hostname, port, Math.min(timeoutMs, 20000)) : null;
  return { u, port, payload, socket, method, headers, timeoutMs };
}

function reqOptions({ u, port, payload, socket, method, headers, timeoutMs }, accept) {
  return {
    host: u.hostname, port, path: u.pathname + u.search, method,
    headers: {
      'Host': u.hostname,
      'Accept': accept,
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      ...headers,
    },
    // socket 已经过 TLS，http 只管往上写 HTTP/1.1 —— 不要走 https 再握一次手
    ...(socket ? { createConnection: () => socket } : {}),
    timeout: timeoutMs,
  };
}

/* 返回 { status, json } —— 非 2xx 也把 body 带出来，报错时说清楚服务端讲了什么 */
export async function requestJSON(url, opts = {}) {
  const o = await open(url, opts);

  return new Promise((resolve, reject) => {
    const req = http.request(reqOptions(o, 'application/json'), res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 留着原文给报错用 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.once('error', reject);
    if (o.payload) req.write(o.payload);
    req.end();
  });
}

/**
 * 边到边给。每条 SSE 消息到齐就调一次 onEvent({event, data})。
 *
 * 返回 { status, text, aborted }：
 *   status  上游的 HTTP 码（拿它判断是不是 401/429 这类）
 *   text    非 2xx 时的原文，用来报错；流式成功时是空串（不攒，攒了就不是流了）
 *   aborted true = 我们主动掐断的（页面被打断），不是故障
 *
 * signal 来自 AbortController：掐断时必须 destroy 上游请求，
 * 否则"打断"只是我们不看结果，网还在跑、钱还在花。
 */
export async function requestStream(url, opts = {}) {
  const { onEvent = () => {}, onText = null, signal = null } = opts;
  const o = await open(url, opts);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ status: 0, text: '', aborted: true });

    const req = http.request(reqOptions(o, 'text/event-stream'), res => {
      const status = res.statusCode;
      // 非 2xx：上游给的是错误 JSON，不是事件流，老老实实攒完给调用方
      if (status !== 200) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8'), aborted: false }));
        return;
      }
      const dec = createSseDecoder({ onEvent, onText });
      res.on('data', chunk => { try { dec.push(chunk); } catch (e) { /* 解析炸了不该静默 */ onEvent({ event: 'error', data: String(e.message || e) }); } });
      res.on('end', () => { try { dec.end(); } catch { /* 收尾失败也把结果交出去 */ } resolve({ status, text: '', aborted: false }); });
      res.on('aborted', () => resolve({ status, text: '', aborted: true }));
      res.on('error', e => reject(e));
    });

    const onAbort = () => {
      // 掐断上游连接：这一步才是"打断"真正的成本节约
      try { req.destroy(Object.assign(new Error('aborted'), { code: 'aborted' })); } catch { /* 已经断了 */ }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.once('error', e => {
      if (signal?.aborted || e.code === 'aborted') return resolve({ status: 0, text: '', aborted: true });
      reject(e);
    });
    if (o.payload) req.write(o.payload);
    req.end();
  });
}
