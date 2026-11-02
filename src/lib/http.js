// 极简 HTTP 客户端：超时 + 重试 + GBK/UTF8 自适应解码
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(buf, charset) {
  if (charset === 'gbk' || charset === 'gb2312') {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
  return new TextDecoder('utf-8').decode(buf);
}

export async function getText(url, { charset, headers = {}, timeout = 15000, retries = 3, referer } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeout);
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          ...(referer ? { Referer: referer } : {}),
          ...headers,
        },
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return decode(buf, charset);
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(300 * (i + 1));
    }
  }
  throw lastErr;
}

export async function getJson(url, opts = {}) {
  const txt = await getText(url, opts);
  return JSON.parse(txt);
}

// 并发限流的 map
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = { __error: String(e && e.message ? e.message : e) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export { sleep };
