// 历史回放引擎：把真实历史行情倒带重炒
// 关键约束（无未来函数）：
//   - 决策日 D 只能看到 D 及之前的数据（候选排名用 bars[date <= D] 计算）
//   - 成交发生在 D 的次日开盘价（买入 ×(1+滑点)，卖出 ×(1-滑点)）
//   - T+1：D 日买入的股票，D+1 才能卖
//   - 费用：佣金 0.025%（最低 5 元）+ 卖出印花税 0.05%
import fs from 'node:fs';
import path from 'node:path';
import { COST, INITIAL_CAPITAL } from '../lib/engine.js';
import { scoreStock, STRATEGY } from '../lib/strategy.js';
import { cacheFile } from './cache.js';

export { COST, INITIAL_CAPITAL, STRATEGY };

let _market = null;
let _index = null; // code -> { name, bars, factorCount, dates: Map<date, idx> }

export function market() {
  if (!_market) {
    _market = JSON.parse(fs.readFileSync(cacheFile('market'), 'utf8'));
    _index = {};
    for (const [code, s] of Object.entries(_market.stocks)) {
      const dates = new Map();
      s.bars.forEach((b, i) => dates.set(b.date, i));
      _index[code] = { name: s.name, bars: s.bars, factorCount: s.factors || 0, dates };
    }
    // 指数日期索引
    _market.__indexDates = new Map(_market.index.bars.map((b, i) => [b.date, i]));
  }
  return _market;
}

function stockIdx(code) {
  market();
  return _index[code] || null;
}

/** 全部交易日（以指数日历为准） */
export function tradingDays() {
  market();
  return _market.index.bars.map((b) => b.date);
}

/** 某只股票截至 date（含）的K线切片（O(1) 定位 + splice，避免全量过滤） */
export function barsUpTo(code, date) {
  const s = stockIdx(code);
  if (!s) return null;
  const i = s.dates.get(date);
  if (i !== undefined) return s.bars.slice(0, i + 1);
  // date 不是该股交易日（停牌）：取最后一个 <= date 的位置
  let lo = 0, hi = s.bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.bars[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? null : s.bars.slice(0, found + 1);
}

/** 某只股票在 date 当天的K线（当日交易用） */
export function barAt(code, date) {
  const s = stockIdx(code);
  if (!s) return null;
  const i = s.dates.get(date);
  return i === undefined ? null : s.bars[i];
}

const _rankCache = new Map();

/**
 * 决策日 date 的候选排名（只用截至 date 的数据，无未来函数）
 * @returns [{code,name,score,r20,r60,vol,close,amt20,floatMcap,intradayPct,tradable}]
 */
export function rankAt(date, { top = 30, gate = 1 } = {}) {
  const key = `${date}|${top}`;
  if (_rankCache.has(key)) return _rankCache.get(key);

  const rows = [];
  for (const code of Object.keys(market().stocks)) {
    const bars = barsUpTo(code, date);
    if (!bars || bars.length < 121) continue;
    const sc = scoreStock(bars);
    if (!sc) continue;
    if (sc.amt20 < 8000e4) continue;
    if (!sc.tradable) continue;
    const last = bars[bars.length - 1];
    rows.push({
      code,
      name: market().stocks[code].name,
      score: sc.score * gate,
      rawScore: sc.score,
      r20: sc.r20,
      r60: sc.r60,
      vol: sc.vol,
      close: last.close,
      date: last.date,
      amt20: sc.amt20,
      intradayPct: last.pct,
      high20: sc.high20,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  const out = rows.slice(0, top);
  _rankCache.set(key, out);
  return out;
}

/** 大盘环境：指数收盘 vs MA20（只用截至 date 的数据） */
export function weatherAt(date) {
  market();
  const i = _market.__indexDates.get(date);
  const bars = _market.index.bars;
  const cut = i === undefined ? bars.length : i + 1;
  if (cut < 21) return { above: true, gate: 1, indexClose: bars[cut - 1]?.close ?? 0, ma20: 0, date };
  const close = bars[cut - 1].close;
  const ma20 = bars.slice(cut - 20, cut).reduce((a, b) => a + b.close, 0) / 20;
  const above = close >= ma20;
  const chg5 = cut >= 6 ? close / bars[cut - 6].close - 1 : 0;
  return { above, gate: above ? 1 : 0.5, indexClose: +close.toFixed(2), ma20: +ma20.toFixed(2), chg5, date: bars[cut - 1].date };
}

// ---------------- 账户 ----------------

export function newAccount() {
  return {
    initialCapital: INITIAL_CAPITAL,
    cash: INITIAL_CAPITAL,
    positions: {}, // code -> {code,name,shares,avgCost,openDate,highClose,lastPrice}
    trades: [],
    snapshots: [],
    pending: [],
    events: [],
  };
}

export function buyCost(price, shares) {
  const gross = price * shares;
  const fee = Math.max(gross * COST.commissionRate, COST.commissionMin);
  return { gross, fee, total: gross + fee, fill: price * (1 + COST.slippage) };
}
export function sellProceeds(price, shares) {
  const gross = price * shares;
  const fee = Math.max(gross * COST.commissionRate, COST.commissionMin) + gross * COST.stampTaxRate;
  return { gross, fee, total: gross - fee, fill: price * (1 - COST.slippage) };
}

export function totalAssets(a, priceOf = () => null) {
  let mv = 0;
  for (const p of Object.values(a.positions)) {
    const pr = priceOf(p.code) ?? p.lastPrice ?? p.avgCost;
    mv += pr * p.shares;
  }
  return { cash: a.cash, mktValue: mv, total: a.cash + mv };
}

function logEvent(a, type, msg) {
  a.events.push({ at: `${a.curDate}`, type, msg });
}

/** 按目标金额买入（date 当天开盘价口径，price 传开盘价） */
export function buy(a, { code, name, open, targetAmount, date, reason }) {
  const { fill } = buyCost(open, 100);
  const p = open * (1 + COST.slippage);
  let lots = Math.floor(targetAmount / (p * COST.lotSize));
  while (lots > 0) {
    const shares = lots * COST.lotSize;
    const { fee } = buyCost(p, shares);
    if (shares * p + fee <= a.cash) break;
    lots--;
  }
  const shares = lots * COST.lotSize;
  if (shares <= 0) return null;
  const { fee, total } = buyCost(p, shares);
  a.cash -= total;
  const pos = a.positions[code] || { code, name, shares: 0, avgCost: 0, openDate: date, highClose: open };
  const ns = pos.shares + shares;
  pos.avgCost = (pos.avgCost * pos.shares + p * shares + fee) / ns;
  pos.shares = ns;
  pos.name = name || pos.name;
  pos.lastPrice = open;
  pos.highClose = Math.max(pos.highClose || 0, open);
  a.positions[code] = pos;
  const tr = { date, time: 'open', code, name, side: 'buy', shares, price: +p.toFixed(3), fee: +fee.toFixed(2), amount: +total.toFixed(2), reason, cashAfter: +a.cash.toFixed(2) };
  a.trades.push(tr);
  logEvent(a, 'buy', `买入 ${name}(${code}) ${shares}股 @${p.toFixed(2)}，花费 ${total.toFixed(2)} 元（含费 ${fee.toFixed(2)}）`);
  return tr;
}

/** 全部卖出（date 当天开盘价口径） */
export function sell(a, { code, open, date, reason }) {
  const pos = a.positions[code];
  if (!pos || pos.shares <= 0) return null;
  const p = open * (1 - COST.slippage);
  const shares = pos.shares;
  const { fee, total } = sellProceeds(p, shares);
  const pnl = total - pos.avgCost * shares;
  const pnlPct = pos.avgCost > 0 ? total / (pos.avgCost * shares) - 1 : 0;
  a.cash += total;
  const tr = {
    date, time: 'open', code, name: pos.name, side: 'sell', shares,
    price: +p.toFixed(3), avgCost: +pos.avgCost.toFixed(4), fee: +fee.toFixed(2), amount: +total.toFixed(2),
    pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(4), holdFrom: pos.openDate, reason, cashAfter: +a.cash.toFixed(2),
  };
  a.trades.push(tr);
  logEvent(a, 'sell', `卖出 ${pos.name}(${code}) ${shares}股 @${p.toFixed(2)}，回款 ${total.toFixed(2)}，${pnl >= 0 ? '盈' : '亏'} ${pnl.toFixed(2)} (${(pnlPct * 100).toFixed(2)}%)`);
  delete a.positions[code];
  return tr;
}

/** 按当日收盘价盯市，记录净值快照 */
export function markToMarket(a, date) {
  for (const p of Object.values(a.positions)) {
    const b = barAt(p.code, date);
    if (b) {
      p.lastPrice = b.close;
      p.highClose = Math.max(p.highClose || 0, b.close, p.avgCost);
    }
  }
  const { cash, mktValue, total } = totalAssets(a, (c) => a.positions[c]?.lastPrice);
  const idx = market().index.bars.find((b) => b.date === date);
  a.snapshots.push({ date, total: +total.toFixed(2), cash: +cash.toFixed(2), mktValue: +mktValue.toFixed(2), index: idx?.close ?? null });
  return { cash, mktValue, total };
}

/** 当日收盘价（用于决策参考展示） */
export function closeAt(code, date) {
  return barAt(code, date)?.close ?? null;
}
