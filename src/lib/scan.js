// 一次完整扫描：全市场快照 -> 硬筛 -> 拉前复权K线 -> 打分排名 -> 大盘环境
import { fetchUniverse, fetchKlinesAuto, fetchIndex, INDEX_SH } from './market.js';
import { prefilter, rankCandidates, marketWeather, STRATEGY } from './strategy.js';
import { log } from './store.js';

export const CONFIG = {
  detailPool: 420, // 进入K线细算的股票数
  klineLen: 140,
  concurrency: 12,
  // 单只目标仓位 18% × 本金 10 万 ≈ 1.76 万；一手超过约 1.6 万的股票会让组合仓位被"资金占用"卡死，
  // 因此细算前先剔除（否则会出现只买到 4 只、现金大量闲置的情况）
  maxLotCost: 16000,
};

/** 细算池挑选：成交额前 60% + 换手活跃 40%，去重（避免单一排序口径漏掉风格股） */
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

export async function runScan({ verbose = true } = {}) {
  const t0 = Date.now();
  const universe = await fetchUniverse({
    onProgress: verbose ? (p, max, got) => { if (p % 5 === 1) log(`  列表进度 ${p}/${max} 页，累计 ${got} 只`); } : undefined,
  });
  if (verbose) log(`全市场快照 ${universe.length} 只，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const filtered = prefilter(universe);
  // 二手硬筛：单只一手金额不能过高，否则 100 股整数倍的约束会让仓位配置失效
  const affordable = filtered.filter((s) => s.price * 100 <= CONFIG.maxLotCost);
  if (verbose) {
    log(`硬筛后 ${filtered.length} 只，剔除一手超 ${CONFIG.maxLotCost} 元的 ${filtered.length - affordable.length} 只 -> 可投池 ${affordable.length} 只`);
  }

  const snapshot = {};
  for (const s of universe) snapshot[s.code] = s;

  const pool = pickPool(affordable, CONFIG.detailPool);
  if (verbose) log(`细算池 ${pool.length} 只，开始拉前复权日K...`);

  let usedSource = '';
  const { source, klines, adjusted } = await fetchKlinesAuto(pool.map((s) => s.code), CONFIG.klineLen, {
    onSource: (s) => { usedSource = s; if (verbose) log(`  数据源：${s}`); },
    log: (m) => { if (verbose) console.log(m); },
  });
  if (verbose) log(`日K 到手 ${Object.keys(klines).length} 只，数据源 ${source}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const idx = await fetchIndex(INDEX_SH, 60);
  const weather = marketWeather(idx.bars);

  const candidates = rankCandidates(klines, snapshot, weather.gate, 30);
  const asOf = candidates[0]?.lastDate ?? idx.bars[idx.bars.length - 1].date;

  if (verbose) {
    log(`扫描完成 asOf=${asOf}，候选 ${candidates.length} 只；上证 ${weather.indexClose} vs MA20 ${weather.ma20} -> ${weather.above ? '强势' : '弱势 ×0.5'}`);
  }
  return {
    at: new Date().toISOString(),
    asOf,
    weather,
    dataSource: source,
    adjusted: adjusted !== false,
    universeCount: universe.length,
    filteredCount: filtered.length,
    affordableCount: affordable.length,
    scoredCount: Object.keys(klines).length,
    candidates,
    strategy: {
      name: STRATEGY.name,
      maxPositions: STRATEGY.maxPositions,
      positionPct: STRATEGY.positionPct,
      stopLoss: STRATEGY.stopLoss,
      trailDrawdown: STRATEGY.trailDrawdown,
      rules: STRATEGY.rules,
    },
  };
}
