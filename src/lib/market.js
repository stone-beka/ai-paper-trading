// 行情数据层
//  - 全市场列表：新浪 Market_Center（分页，500/页），字段最全（含总市值/流通市值/成交额/换手）
//  - 前复权日K：腾讯 fqkline（东财接口对 Node TLS 指纹有拦截，故不用）
//  - 实时报价：腾讯 qt.gtimg.cn
import { getText, getJson, mapLimit, sleep } from './http.js';
import { execFile } from 'node:child_process';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SINA_LIST = (page, num, node = 'hs_a') =>
  `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=${num}&sort=amount&asc=0&node=${node}&symbol=&_s_r_a=page`;

const TX_KLINE = (sym, n, fq = 'qfq') =>
  `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${n},${fq}`;

const TX_PLAIN_KLINE = (sym, n) =>
  `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${sym},day,,,${n}`;

/** 沪/深/北 前缀 */
export function txSymbol(code) {
  if (/^(60|68|90|11|13|50|51|52|56|58|5)/.test(code)) return 'sh' + code;
  if (/^(4|8|92)/.test(code)) return 'bj' + code;
  return 'sz' + code;
}

export function isST(name) {
  return /ST|退/.test(name || '');
}

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 全市场 A 股列表（新浪 hs_a 节点，约 5500 只）
 * @returns [{code,symbol,name,price,pct,open,high,low,prevClose,volume,amount,mcap,floatMcap,turnover,pe,pb}]
 */
export async function fetchUniverse({ pageSize = 100, maxPages = 60, onProgress } = {}) {
  const first = await getJson(SINA_LIST(1, pageSize), { referer: 'https://finance.sina.com.cn/', timeout: 25000 });
  if (!Array.isArray(first) || !first.length) throw new Error('新浪列表接口返回异常');
  const all = [...first];
  if (onProgress) onProgress(1, maxPages, all.length);

  for (let p = 2; p <= maxPages; p++) {
    let arr = null;
    for (let attempt = 0; attempt < 3 && !arr; attempt++) {
      try {
        const r = await getJson(SINA_LIST(p, pageSize), { referer: 'https://finance.sina.com.cn/', timeout: 25000, retries: 1 });
        if (Array.isArray(r)) arr = r;
      } catch {
        await sleep(600 * (attempt + 1));
      }
    }
    if (!arr || !arr.length) break;
    all.push(...arr);
    if (onProgress) onProgress(p, maxPages, all.length);
    if (arr.length < pageSize) break;
    await sleep(150);
  }

  const seen = new Set();
  return all
    .filter((d) => d && d.code && !seen.has(d.code) && seen.add(d.code))
    .map((d) => ({
      code: String(d.code),
      symbol: d.symbol,
      name: d.name,
      price: num(d.trade),
      pct: num(d.changepercent),
      open: num(d.open),
      high: num(d.high),
      low: num(d.low),
      prevClose: num(d.settlement),
      volume: num(d.volume),
      amount: num(d.amount),
      mcap: num(d.mktcap) != null ? num(d.mktcap) * 1e4 : null, // 万元 -> 元
      floatMcap: num(d.nmc) != null ? num(d.nmc) * 1e4 : null, // 万元 -> 元
      turnover: num(d.turnoverratio),
      pe: num(d.per),
      pb: num(d.pb),
    }));
}

/** 腾讯前复权日K -> [{date,open,close,high,low,volume}] */
export async function fetchKlineQfq(code, n = 140) {
  const sym = txSymbol(code);
  const j = await getJson(TX_KLINE(sym, n, 'qfq'), { timeout: 9000, retries: 1, referer: 'https://gu.qq.com/' });
  const node = j?.data?.[sym];
  if (!node) throw new Error('no data');
  const raw = node.qfqday || node.day;
  if (!Array.isArray(raw) || !raw.length) throw new Error('no kline');
  const bars = raw.map((a) => ({
    date: a[0],
    open: +a[1],
    close: +a[2],
    high: +a[3],
    low: +a[4],
    volume: +a[5],
  }));
  // 计算涨跌幅（用前复权序列算，反映真实收益）
  for (let i = 0; i < bars.length; i++) {
    const prev = i > 0 ? bars[i - 1].close : bars[i].open;
    bars[i].pct = prev ? (bars[i].close / prev - 1) * 100 : 0;
  }
  const nm = node.qt && !Array.isArray(node.qt) ? node.qt.name : Array.isArray(node.qt) ? node.qt[1] : '';
  return { code, name: nm || '', bars };
}

/**
 * 批量前复权日K，带熔断与总时限（被限流时快速失败而不是拖死）
 * @param {object} opts { concurrency, deadlineMs, minRatio }
 */
export async function fetchKlinesQfq(codes, n = 140, opts = {}) {
  const concurrency = typeof opts === 'number' ? opts : opts.concurrency ?? 8;
  const deadlineMs = typeof opts === 'object' ? opts.deadlineMs ?? 120000 : 120000;
  const minRatio = typeof opts === 'object' ? opts.minRatio ?? 0.5 : 0.5;
  const t0 = Date.now();
  const out = {};
  let fails = 0;
  let aborted = false;

  const one = async (c) => {
    for (let i = 0; i < 2; i++) {
      if (Date.now() - t0 > deadlineMs) { aborted = true; return null; }
      try {
        return await fetchKlineQfq(c, n);
      } catch (e) {
        if (i === 1) { fails++; lastErr = e.message; }
        else await sleep(250 + Math.random() * 250);
      }
    }
    return null;
  };
  let lastErr = '';

  const res = await mapLimit(codes, concurrency, one);
  for (const r of res) if (r && !r.__error && r.bars?.length) out[r.code] = r;

  const gotRatio = Object.keys(out).length / Math.max(1, codes.length);
  if (gotRatio < minRatio) {
    console.warn(`  ⚠️ 日K 获取率仅 ${(gotRatio * 100).toFixed(0)}%（${Object.keys(out).length}/${codes.length}），疑似被限流，熔断跳过补拉。示例错误：${lastErr || '无'}`);
    return out;
  }

  // 补拉缺失（串行，短退避）
  const missing = codes.filter((c) => !out[c]);
  if (missing.length && !aborted) {
    for (const c of missing) {
      if (Date.now() - t0 > deadlineMs) break;
      await sleep(120);
      const r = await one(c);
      if (r && r.bars?.length) out[c] = r;
    }
  }
  return out;
}

/** 单只最近 N 天前复权K（用于增量更新） */
export async function fetchKlineQfqShort(code, n = 8) {
  return fetchKlineQfq(code, n);
}

// ---------------- 备用数据源：东方财富（Node 被 TLS 指纹拦截，走 curl.exe） ----------------

const EM_SECID = (code) => (/^(60|68|9|5)/.test(code) ? '1.' : '0.') + code;
const EM_KLINE = (secid, lmt) =>
  `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${lmt}`;

function curlJson(url, timeoutSec = 25) {
  return new Promise((resolve, reject) => {
    execFile(
      'curl.exe',
      ['-s', '-m', String(timeoutSec), '-A', BROWSER_UA, '--compressed', url],
      { encoding: 'utf8', maxBuffer: 1 << 25 },
      (err, stdout) => {
        if (err) return reject(new Error(err.message.slice(0, 120)));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('curl 返回非 JSON（可能被拦截）'));
        }
      }
    );
  });
}

/** 东财单只前复权日K */
export async function fetchKlineEast(code, n = 140) {
  const j = await curlJson(EM_KLINE(EM_SECID(code), n));
  const lines = j?.data?.klines;
  if (!Array.isArray(lines) || !lines.length) throw new Error('east no kline');
  const bars = lines.map((l) => {
    const p = l.split(',');
    return { date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4], volume: +p[5], pct: +p[8] };
  });
  return { code, name: j.data.name || '', bars };
}

/** 东财批量前复权日K（curl 并发） */
export async function fetchKlinesEast(codes, n = 140, concurrency = 5) {
  const res = await mapLimit(codes, concurrency, async (c) => {
    for (let i = 0; i < 2; i++) {
      try {
        return await fetchKlineEast(c, n);
      } catch (e) {
        if (i === 1) return { __error: e.message, code: c };
        await sleep(300);
      }
    }
    return null;
  });
  const out = {};
  for (const r of res) if (r && r.bars?.length) out[r.code] = r;
  return out;
}

// ---------------- 备用数据源：新浪（原始价 + 本地前复权） ----------------

const SINA_KLINE = (sym, n) =>
  `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=${n}`;

/** 新浪复权因子（降序，f 为累乘因子；已用东财前复权数据交叉验证到 0.2% 以内） */
export async function fetchAdjustFactors(code, maxAge = 8) {
  const sym = txSymbol(code);
  const txt = await getText(`https://finance.sina.com.cn/realstock/company/${sym}/hfq.js`, {
    charset: 'gbk',
    referer: 'https://finance.sina.com.cn/',
    timeout: 15000,
    retries: 2,
  });
  const i = txt.indexOf('=');
  if (i < 0) return null;
  const body = txt.slice(i + 1).trim().replace(/;\s*$/, '');
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try {
    const j = JSON.parse(body.slice(s, e + 1));
    const arr = (j.data || []).map((x) => ({ d: x.d, f: +x.f })).filter((x) => Number.isFinite(x.f) && x.f > 0);
    return arr.slice(0, maxAge);
  } catch {
    return null;
  }
}

/**
 * 把原始价前复权：前复权价 = 原始价 × Π(f_{i+1}/f_i)，对所有除权日 d_i > 该K线日期
 */
export function applyForwardAdjust(bars, factors) {
  if (!factors || factors.length < 2) return bars;
  const out = bars.map((b) => ({ ...b }));
  for (let i = 0; i < factors.length - 1; i++) {
    const exDate = factors[i].d;
    const ratio = factors[i + 1].f / factors[i].f;
    if (Math.abs(ratio - 1) < 1e-9) continue;
    for (const b of out) {
      if (b.date < exDate) {
        b.open *= ratio;
        b.close *= ratio;
        b.high *= ratio;
        b.low *= ratio;
      }
    }
  }
  // 重算涨跌幅
  for (let i = 0; i < out.length; i++) {
    const prev = i > 0 ? out[i - 1].close : out[i].open;
    out[i].pct = prev ? (out[i].close / prev - 1) * 100 : 0;
  }
  return out;
}

/** 新浪原始K + 本地前复权 */
export async function fetchKlineSinaAdjusted(code, n = 140) {
  const sym = txSymbol(code);
  const [txt, factors] = await Promise.all([
    getText(SINA_KLINE(sym, n), { referer: 'https://finance.sina.com.cn/', timeout: 20000, retries: 2 }),
    fetchAdjustFactors(code).catch(() => null),
  ]);
  const arr = JSON.parse(txt);
  if (!Array.isArray(arr) || !arr.length) throw new Error('sina no kline');
  const bars = arr.map((b) => ({
    date: b.day, open: +b.open, close: +b.close, high: +b.high, low: +b.low, volume: +b.volume,
  }));
  return { code, name: '', bars: applyForwardAdjust(bars, factors), adjusted: true, factors: factors?.length || 0 };
}

export async function fetchKlineSinaRaw(code, n = 140) {
  const sym = txSymbol(code);
  const txt = await getText(SINA_KLINE(sym, n), { referer: 'https://finance.sina.com.cn/', timeout: 20000, retries: 2 });
  const arr = JSON.parse(txt);
  if (!Array.isArray(arr) || !arr.length) throw new Error('sina no kline');
  const bars = arr.map((b) => ({
    date: b.day, open: +b.open, close: +b.close, high: +b.high, low: +b.low, volume: +b.volume,
  }));
  for (let i = 0; i < bars.length; i++) {
    const prev = i > 0 ? bars[i - 1].close : bars[i].open;
    bars[i].pct = prev ? (bars[i].close / prev - 1) * 100 : 0;
  }
  return { code, name: '', bars };
}

/**
 * 数据源自动选择 + 批量取数
 * 依次尝试：东财前复权(curl) -> 新浪原始+本地前复权 -> 新浪原始
 * 先用单只探针判断可用性，避免整批失败后才发现被限流
 */
export async function fetchKlinesAuto(codes, n = 140, { onSource, log: logFn, forceSource } = {}) {
  const say = (m) => (logFn ? logFn(m) : console.warn(m));

  // 1) 东财（curl）探针（forceSource='sina' 可直接跳过）
  const eastProbe = forceSource === 'sina' ? null : await fetchKlineEast(codes[0], 10).catch(() => null);
  if (eastProbe) {
    const east = await fetchKlinesEast(codes, n, 6);
    const ratio = Object.keys(east).length / codes.length;
    if (ratio >= 0.8) {
      onSource?.('东财前复权');
      return { source: '东财前复权', klines: east, adjusted: true };
    }
    say(`  ⚠️ 东财获取率仅 ${(ratio * 100).toFixed(0)}%，切换到本地复权方案`);
  } else {
    say('  ⚠️ 东财接口不可用，切换本地复权方案（新浪原始价 + 新浪复权因子）');
  }

  // 2) 新浪原始价 + 本地前复权
  const res = await mapLimit(codes, 8, async (c) => {
    for (let i = 0; i < 3; i++) {
      try {
        return await fetchKlineSinaAdjusted(c, n);
      } catch (e) {
        if (i === 2) return { __error: e.message, code: c };
        await sleep(300 * (i + 1));
      }
    }
    return null;
  });
  const out = {};
  let withFactors = 0;
  for (const r of res) {
    if (r && r.bars?.length) { out[r.code] = r; if (r.factors >= 2) withFactors++; }
  }
  const ratio = Object.keys(out).length / codes.length;
  if (ratio >= 0.5) {
    onSource?.(`新浪原始价+本地前复权(带因子 ${withFactors}/${Object.keys(out).length})`);
    return { source: '新浪原始价+本地前复权', klines: out, adjusted: true };
  }

  // 3) 兜底：新浪原始价（未复权）
  say(`  ⚠️ 本地复权方案获取率仅 ${(ratio * 100).toFixed(0)}%，兜底用新浪原始价`);
  const sina = await mapLimit(codes, 8, (c) => fetchKlineSinaRaw(c, n).catch(() => null));
  const out2 = {};
  for (const r of sina) if (r && r.bars?.length) out2[r.code] = r;
  onSource?.('新浪原始价(未复权)');
  return { source: '新浪原始价(未复权)', klines: out2, adjusted: false };
}

/**
 * 腾讯批量实时报价（GBK），{ code: {name,price,prevClose,open,high,low,volume,amount,pct,bid,ask,time} }
 */
export async function fetchQuotes(codes) {
  const out = {};
  if (!codes.length) return out;
  const chunks = [];
  for (let i = 0; i < codes.length; i += 60) chunks.push(codes.slice(i, i + 60));
  const results = await mapLimit(chunks, 4, async (chunk) => {
    const q = chunk.map(txSymbol).join(',');
    return getText(`https://qt.gtimg.cn/q=${q}`, { charset: 'gbk', referer: 'https://gu.qq.com/', retries: 2 });
  });
  for (const txt of results) {
    if (typeof txt !== 'string') continue;
    for (const line of txt.split(';')) {
      const m = line.match(/v_([a-z]{2})(\d{6})="([^"]*)"/);
      if (!m) continue;
      const f = m[3].split('~');
      if (f.length < 40) continue;
      out[m[2]] = {
        code: m[2],
        name: f[1],
        price: num(f[3]),
        prevClose: num(f[4]),
        open: num(f[5]),
        volume: num(f[6]),
        high: num(f[33]),
        low: num(f[34]),
        amount: num(f[37]) != null ? num(f[37]) * 1e4 : null,
        turnover: num(f[38]),
        pct: num(f[32]),
        bid: num(f[9]),
        ask: num(f[19]),
        time: f[30],
      };
    }
  }
  return out;
}

/** 指数日K（腾讯，不复权即可，指数无复权） */
export async function fetchIndex(symbol = 'sh000001', n = 60) {
  const j = await getJson(TX_PLAIN_KLINE(symbol, n), { timeout: 20000, referer: 'https://gu.qq.com/' });
  const node = j?.data?.[symbol];
  const raw = node?.day || node?.qfqday;
  if (!Array.isArray(raw)) throw new Error(`指数 ${symbol} 数据异常`);
  const bars = raw.map((a) => ({
    date: a[0],
    open: +a[1],
    close: +a[2],
    high: +a[3],
    low: +a[4],
    volume: +a[5],
  }));
  return { symbol, name: node?.qt?.[1] || symbol, bars };
}

export const INDEX_SH = 'sh000001';
export const INDEX_CYB = 'sz399006';
export const INDEX_HS300 = 'sh000300';
