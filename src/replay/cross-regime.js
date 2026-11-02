// 跨行情验证：把子代理的打法写成规则，在不同性质的行情段里考一遍
// 目的：判断「赢」到底来自规则本身，还是只来自"刚好躲过了下跌"
import fs from 'node:fs';
import path from 'node:path';
import {
  market, tradingDays, weatherAt, rankAt, barAt, barsUpTo,
  newAccount, buy, sell, markToMarket, totalAssets, STRATEGY, INITIAL_CAPITAL,
} from './engine.js';
import { runPlan } from './run.js';

const OUT = path.join(process.cwd(), 'data', 'replay');
const m = market();
const days = m.index.bars.map((b) => b.date);

/** 行情窗口清单：手动挑选不同性质（牛/熊/震荡） */
const WINDOWS = [
  { name: '2026-07-01 ~ 2026-10-16（子代理实测段）', from: '2026-07-01', to: '2026-10-16' },
  { name: '2025-09-15 ~ 2025-12-31（震荡微涨）', from: '2025-09-15', to: '2025-12-31' },
  { name: '2026-01-01 ~ 2026-03-31（先涨后急跌）', from: '2026-01-01', to: '2026-03-31' },
  { name: '2026-03-01 ~ 2026-06-30（深跌后修复）', from: '2026-03-01', to: '2026-06-30' },
  { name: '2026-04-01 ~ 2026-07-31（新高后转跌）', from: '2026-04-01', to: '2026-07-31' },
];

/** 指数区间统计 */
function idxStats(from, to) {
  const bars = m.index.bars.filter((b) => b.date >= from && b.date <= to);
  if (bars.length < 2) return null;
  const c0 = bars[0].close, c1 = bars.at(-1).close;
  let peak = -Infinity, mdd = 0;
  for (const b of bars) { peak = Math.max(peak, b.close); mdd = Math.min(mdd, b.close / peak - 1); }
  const ma20Above = bars.filter((b, i) => i >= 20 && b.close >= bars.slice(i - 20, i).reduce((a, x) => a + x.close, 0) / 20).length;
  return {
    days: bars.length, c0, c1, ret: c1 / c0 - 1, mdd,
    aboveRatio: ma20Above / Math.max(1, bars.length - 20),
    hi: Math.max(...bars.map((b) => b.close)), lo: Math.min(...bars.map((b) => b.close)),
  };
}

/**
 * 子代理的打法（按它自述的规则机械实现，不含任何未来信息）：
 *  - 空仓/建仓前置：指数在 MA20 上方 且 5日动能 ≥ +1% 且 指数距20日高点 ≥3% 空间
 *  - 清仓信号：跌破 MA20 / 5日动能 ≤ -1% / 指数单日 ≤ -1.5%
 *  - 最多同时持有 4 只，单只波动率 ≤30%，弱势市场每天最多新增 1 只
 */
function runTraderPolicy({ from, to, maxPos = 4, volCap = 0.3, needRoom = 0.03, momentumNeed = 0.01, verbose = false }) {
  const list = tradingDays().filter((d) => d >= from && d <= to);
  const a = newAccount();
  const rejects = { noSignal: 0, noRoom: 0, vol: 0, weakCap: 0, cash: 0 };
  const entries = [];

  for (let i = 0; i < list.length; i++) {
    const date = list[i];
    a.curDate = date;

    // 开盘执行待办
    if (a.pending.length) {
      const q = a.pending; a.pending = [];
      for (const o of q.filter((x) => x.action === 'sell')) {
        const b = barAt(o.code, date);
        if (!b || a.positions[o.code]?.openDate === date) continue;
        sell(a, { code: o.code, open: b.open, date, reason: o.reason });
      }
      const ta = totalAssets(a, (c) => barAt(c, date)?.open ?? a.positions[c]?.lastPrice);
      const w = weatherAt(list[Math.max(0, i - 1)]);
      const maxExp = w.above ? STRATEGY.maxExposureStrong : STRATEGY.maxExposureWeak;
      for (const o of q.filter((x) => x.action === 'buy')) {
        if (a.positions[o.code]) continue;
        if (Object.keys(a.positions).length >= maxPos) continue;
        const b = barAt(o.code, date);
        if (!b || !(b.open > 0)) continue;
        const mvNow = Object.values(a.positions).reduce((s, p) => s + (barAt(p.code, date)?.open ?? p.lastPrice) * p.shares, 0);
        const perAmount = ta.total * STRATEGY.positionPct;
        if ((mvNow + perAmount) / ta.total > maxExp + 1e-6) { rejects.cash++; continue; }
        const cashFloor = ta.total * STRATEGY.minCashPct;
        const budget = Math.min(perAmount, Math.max(0, a.cash - cashFloor));
        if (budget < b.open * 100 * 1.001) { rejects.cash++; continue; }
        const tr = buy(a, { code: o.code, name: m.stocks[o.code]?.name, open: b.open, targetAmount: budget, date, reason: o.reason });
        if (tr) entries.push({ date, code: o.code, name: tr.name });
      }
    }

    markToMarket(a, date);

    // 收盘后按规则决定
    const w = weatherAt(date);
    const idxBars = m.index.bars;
    const cut = idxBars.findIndex((b) => b.date === date);
    const chg1 = cut >= 1 ? idxBars[cut].close / idxBars[cut - 1].close - 1 : 0;
    const chg5 = cut >= 5 ? idxBars[cut].close / idxBars[cut - 5].close - 1 : 0;
    const hi20 = cut >= 20 ? Math.max(...idxBars.slice(cut - 19, cut + 1).map((b) => b.close)) : idxBars[cut].close;
    const roomToHigh = idxBars[cut].close / hi20 - 1; // 负值 = 距高点还有多少空间

    // 1) 清仓信号
    const clearAll = !w.above || chg5 <= -0.01 || chg1 <= -0.015;
    if (clearAll && Object.keys(a.positions).length) {
      for (const p of Object.values(a.positions)) {
        if (a.pending.find((x) => x.code === p.code && x.action === 'sell')) continue;
        a.pending.push({ action: 'sell', code: p.code, name: p.name, reason: `规则清仓：${!w.above ? '跌破MA20' : chg5 <= -0.01 ? '5日动能转负' : '指数单日跌超1.5%'}` });
      }
      continue;
    }

    // 2) 建仓信号
    const canEnter = w.above && chg5 >= momentumNeed && roomToHigh <= -needRoom;
    if (!canEnter) { rejects.noSignal++; continue; }
    if (Object.keys(a.positions).length >= maxPos) { rejects.weakCap++; continue; }

    const ranked = rankAt(date, { top: 30, gate: w.gate });
    for (const c of ranked.slice(0, 10)) {
      if (Object.keys(a.positions).length >= maxPos) break;
      if (a.positions[c.code]) continue;
      if (a.pending.find((x) => x.code === c.code && x.action === 'buy')) continue;
      if (c.vol > volCap) { rejects.vol++; continue; }
      a.pending.push({ action: 'buy', code: c.code, name: c.name, reason: `规则建仓：动能第 ${ranked.indexOf(c) + 1} 名，波动 ${(c.vol * 100).toFixed(1)}%` });
      if (!w.above) break;
      // 强势日一次可建到上限（与子代理 8/05 一次建 3 只一致）
      if (Object.keys(a.positions).length + a.pending.filter((x) => x.action === 'buy').length >= maxPos) break;
    }
  }

  const last = a.snapshots.at(-1);
  a.final = {
    total: last.total,
    pnlPct: last.total / INITIAL_CAPITAL - 1,
    trades: a.trades.length,
    entries: entries.length,
    maxDrawdown: (() => { let pk = -Infinity, mdd = 0; for (const s of a.snapshots) { pk = Math.max(pk, s.total); mdd = Math.min(mdd, s.total / pk - 1); } return mdd; })(),
    cashDays: 0,
  };
  a.final.cashDays = a.snapshots.filter((s) => s.mktValue < 1).length;
  return { account: a, rejects };
}

// ---------------- 跑对比 ----------------
const rows = [];
for (const W of WINDOWS) {
  const st = idxStats(W.from, W.to);
  if (!st) { console.log(`跳过 ${W.name}：数据不足`); continue; }
  const trader = runTraderPolicy(W);
  const mech = runPlan(null, { start: W.from, end: W.to, mechanical: true, autoRules: true, verbose: false });
  const idxEnd = 100000 * (1 + st.ret);

  // 期初等权买入动能前 5 持有
  const w0 = weatherAt(W.from);
  const top5 = rankAt(W.from, { top: 5, gate: w0.gate });
  let s = 0, n = 0;
  for (const c of top5) {
    const b = barAt(c.code, W.to);
    if (!b) continue;
    s += b.close / c.close - 1; n++;
  }
  const hold = n ? 100000 * (1 + s / n) : null;

  rows.push({
    window: W.name,
    idxRet: st.ret, idxMdd: st.mdd, aboveRatio: st.aboveRatio, days: st.days,
    trader: trader.account.final, mech: mech.account.final, hold,
    rejects: trader.rejects,
  });
  console.log(`\n${W.name}`);
  console.log(`  大盘 ${(st.ret * 100).toFixed(2)}%  回撤 ${(st.mdd * 100).toFixed(2)}%  站上MA20天数占比 ${(st.aboveRatio * 100).toFixed(0)}%`);
  console.log(`  操盘手打法 ${(trader.account.final.pnlPct * 100).toFixed(2)}%  回撤 ${(trader.account.final.maxDrawdown * 100).toFixed(2)}%  成交 ${trader.account.final.trades} 笔  空仓天数 ${trader.account.final.cashDays}/${trader.account.final.trades ? st.days : st.days}`);
  console.log(`  机械规则   ${(mech.account.final.pnlPct * 100).toFixed(2)}%  回撤 ${(mech.account.final.maxDrawdown * 100).toFixed(2)}%  成交 ${mech.account.final.trades} 笔`);
  console.log(`  等权持有前5 ${hold == null ? '—' : ((hold / 100000 - 1) * 100).toFixed(2) + '%'}`);
}

fs.writeFileSync(path.join(OUT, 'cross-regime.json'), JSON.stringify(rows, null, 2));
console.log('\n已写入 data/replay/cross-regime.json');
