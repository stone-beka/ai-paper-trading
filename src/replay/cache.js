// 行情缓存：一次性把「选股池 + 指数」的历史日K抓到本地，供回放使用
// 数据源：新浪原始价 + 新浪复权因子（本地前复权），与实盘引擎完全一致
import fs from 'node:fs';
import path from 'node:path';
import { fetchUniverse, fetchKlineSinaAdjusted, fetchIndex, INDEX_SH } from '../lib/market.js';
import { prefilter, STRATEGY } from '../lib/strategy.js';
import { mapLimit, sleep } from '../lib/http.js';

export const CACHE_DIR = path.join(process.cwd(), 'data', 'replay');

export function cacheFile(name) {
  return path.join(CACHE_DIR, `${name}.json`);
}

export function loadCache(name) {
  return JSON.parse(fs.readFileSync(cacheFile(name), 'utf8'));
}

export function listCached() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  return fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

/** 选股池：与实盘 scan.js 的 pickPool 保持一致口径 */
export function pickPool(filtered, limit) {
  const nAmt = Math.ceil(limit * 0.6);
  const byAmt = [...filtered].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, nAmt);
  const byTurn = [...filtered].sort((a, b) => (b.turnover || 0) - (a.turnover || 0)).slice(0, limit);
  const seen = new Set();
  const out = [];
  for (const s of [...byAmt, ...byTurn]) {
    if (seen.has(s.code)) continue;
    seen.add(s.code);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export async function buildCache({ poolSize = 600, klineLen = 1024, force = false } = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log('拉取全市场快照...');
  const universe = await fetchUniverse();
  const filtered = prefilter(universe).filter((s) => s.price * 100 <= 16000);
  const pool = pickPool(filtered, poolSize);
  console.log(`全市场 ${universe.length} -> 硬筛 ${filtered.length} -> 缓存池 ${pool.length} 只`);

  const meta = {
    builtAt: new Date().toISOString(),
    universeCount: universe.length,
    filteredCount: filtered.length,
    klineLen,
    pool: pool.map((s) => ({
      code: s.code, name: s.name, price: s.price, floatMcap: s.floatMcap,
      amount: s.amount, turnover: s.turnover, pct: s.pct,
    })),
    index: null,
    stocks: {},
  };

  let done = 0;
  const results = await mapLimit(pool, 6, async (s) => {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetchKlineSinaAdjusted(s.code, klineLen);
        done++;
        if (done % 50 === 0) console.log(`  已缓存 ${done}/${pool.length}，最新 ${s.name}`);
        return { code: s.code, name: s.name, bars: r.bars, factors: r.factors };
      } catch (e) {
        if (i === 3) return { code: s.code, error: e.message };
        await sleep(400 * (i + 1));
      }
    }
    return null;
  });

  let fail = 0;
  for (const r of results) {
    if (!r) continue;
    if (r.error || !r.bars?.length) { fail++; continue; }
    meta.stocks[r.code] = { name: r.name, bars: r.bars, factors: r.factors };
  }

  console.log('拉取指数...');
  const idx = await fetchIndex(INDEX_SH, 260);
  meta.index = { symbol: idx.symbol, name: idx.name, bars: idx.bars };

  fs.writeFileSync(cacheFile('market'), JSON.stringify(meta));
  console.log(`缓存完成：${Object.keys(meta.stocks).length} 只（失败 ${fail}），指数 ${idx.bars.length} 根`);
  console.log(`文件：${cacheFile('market')}  ${(fs.statSync(cacheFile('market')).size / 1e6).toFixed(1)} MB`);
  return meta;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/replay/cache.js')) {
  buildCache({ force: process.argv.includes('--force') })
    .then(() => process.exit(0))
    .catch((e) => { console.error('缓存失败：', e); process.exit(1); });
}
