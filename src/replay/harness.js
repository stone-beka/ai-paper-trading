// 通用策略回测框架：多策略横向对比，含随机对照（区分 alpha 与 beta）
// 所有策略严格无未来函数：调仓日只用截至该日数据，按当日收盘价成交（保守口径），换手计成本
import fs from 'node:fs';
import path from 'node:path';
import { market } from './engine.js';

export const COST = 0.0015; // 单边 0.15%（佣金+滑点）
export const START_CAP = 100000;

export function mkt() {
  return market();
}

/** 建立向量化索引：date -> (code -> bar)，以及每只股票的日期序列 */
export function buildIndex(codes) {
  const m = mkt();
  const byDate = new Map(); // date -> Map(code -> bar)
  const meta = new Map();
  for (const code of codes) {
    const s = m.stocks[code];
    if (!s) continue;
    meta.set(code, { name: s.name, bars: s.bars, dates: s.bars.map((b) => b.date) });
  }
  return { byDate, meta };
}

/** 解析策略用的价格：按日期取收盘（停牌沿用前值） */
function priceOn(meta, code, date, cache) {
  const key = `${code}|${date}`;
  if (cache.has(key)) return cache.get(key);
  const m = meta.get(code);
  if (!m) return null;
  const i = m.dates.get ? m.dates.get(date) : undefined;
  let p = null;
  if (i !== undefined) p = m.bars[i].close;
  else {
    // 二分找最后一个 <= date
    let lo = 0, hi = m.bars.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (m.bars[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    p = found >= 0 ? m.bars[found].close : null;
  }
  cache.set(key, p);
  return p;
}

export function maxDrawdown(curve) {
  let peak = -Infinity, mdd = 0;
  for (const c of curve) {
    peak = Math.max(peak, c.value);
    mdd = Math.min(mdd, c.value / peak - 1);
  }
  return mdd;
}

export function metrics(curve, capital = START_CAP) {
  if (!curve.length) return null;
  const final = curve[curve.length - 1].value;
  const days = curve.length;
  const years = days / 242;
  const ret = final / capital - 1;
  return {
    final, ret, cagr: Math.pow(final / capital, 1 / Math.max(years, 1e-9)) - 1,
    mdd: maxDrawdown(curve), days, years,
    calmar: (() => { const m = maxDrawdown(curve); return m < 0 ? (Math.pow(final / capital, 1 / Math.max(years, 1e-9)) - 1) / Math.abs(m) : null; })(),
  };
}

/**
 * 通用回测：按 rebalanceEvery 个交易日调仓，目标权重由 pickFn 给出
 * @param pickFn(date, ctx) -> [{code, weight}]  权重合计 ≤ 1，其余为现金
 */
export function backtest({ codes, from, to, rebalanceEvery = 242, pickFn, label }) {
  const m = mkt();
  const dates = m.index.bars.filter((b) => b.date >= from && b.date <= to).map((b) => b.date);
  if (dates.length < 30) return null;
  const { meta } = buildIndex(codes);
  const pcache = new Map();

  let cash = START_CAP;
  let holdings = new Map(); // code -> shares
  const curve = [];
  let rebalances = 0;
  let turnoverSum = 0;

  const valueOf = (date) => {
    let v = cash;
    for (const [c, sh] of holdings) {
      const p = priceOn(meta, c, date, pcache);
      if (p) v += sh * p;
    }
    return v;
  };

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const isFirst = i === 0;
    const doRebalance = isFirst || (rebalanceEvery > 0 && i % rebalanceEvery === 0);
    if (doRebalance) {
      const total = valueOf(d);
      const targets = pickFn(d, { i, dates, total, holdings: new Set(holdings.keys()), meta, pcache }) || [];
      // 目标市值
      const tgt = new Map();
      for (const t of targets) if (t.weight > 0) tgt.set(t.code, total * t.weight);
      // 先卖后买
      for (const [c, sh] of [...holdings]) {
        const p = priceOn(meta, c, d, pcache);
        if (!p) continue;
        const curVal = sh * p;
        const want = tgt.get(c) ?? 0;
        if (curVal > want * 1.02) {
          const sellVal = curVal - want;
          const sellSh = sellVal / p;
          holdings.set(c, sh - sellSh);
          cash += sellVal * (1 - COST);
          turnoverSum += sellVal / total;
          if (holdings.get(c) < 1e-9) holdings.delete(c);
        }
      }
      for (const [c, want] of tgt) {
        const p = priceOn(meta, c, d, pcache);
        if (!p) continue;
        const curVal = (holdings.get(c) || 0) * p;
        if (curVal < want * 0.98) {
          const buyVal = Math.min(want - curVal, cash);
          if (buyVal <= 0) continue;
          const buySh = (buyVal * (1 - COST)) / p;
          holdings.set(c, (holdings.get(c) || 0) + buySh);
          cash -= buyVal;
          turnoverSum += buyVal / total;
        }
      }
      rebalances++;
    }
    curve.push({ date: d, value: valueOf(d) });
  }

  const mt = metrics(curve);
  return { label, ...mt, rebalances, turnover: turnoverSum, curve };
}

/** 期初固定票池（消除"未来才上市"的股票） */
export function poolAt(from, { minBefore = 60, minAfter = 30, excludeST = true } = {}) {
  const m = mkt();
  const out = [];
  for (const [code, s] of Object.entries(m.stocks)) {
    if (excludeST && /ST|退/.test(s.name)) continue;
    const before = s.bars.filter((b) => b.date <= from).length;
    const after = s.bars.filter((b) => b.date >= from).length;
    if (before < minBefore || after < minAfter) continue;
    out.push(code);
  }
  return out;
}

export const pct = (x, d = 2) => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
export const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 0 }));
