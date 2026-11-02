// 长周期对照：全部可用历史（截至 2026-10-16，往前 ~3.5 年，含牛熊震荡）
import fs from 'node:fs';
import path from 'node:path';
import { market, tradingDays, weatherAt, rankAt, barAt, newAccount, buy, sell, markToMarket, totalAssets, STRATEGY, INITIAL_CAPITAL } from './engine.js';
import { runPlan } from './run.js';

const OUT = path.join(process.cwd(), 'data', 'replay');
const m = market();
const START = process.argv[2] || '2023-01-03';
const END = '2026-10-16';

// ---- 1) 指数本身 ----
const ib = m.index.bars.filter((b) => b.date >= START && b.date <= END);
const idxRet = ib.at(-1).close / ib[0].close - 1;
let pk = -Infinity, idxMdd = 0;
for (const b of ib) { pk = Math.max(pk, b.close); idxMdd = Math.min(idxMdd, b.close / pk - 1); }
console.log(`区间：${ib[0].date} ~ ${ib.at(-1).date}（${ib.length} 个交易日，约 ${(ib.length / 242).toFixed(1)} 年）`);
console.log(`上证指数：${ib[0].close} -> ${ib.at(-1).close}  收益 ${(idxRet * 100).toFixed(2)}%  最大回撤 ${(idxMdd * 100).toFixed(2)}%`);

// ---- 2) 操盘手打法（按规则复现） ----
function runTraderPolicy({ from, to, maxPos = 4, volCap = 0.3, needRoom = 0.03, momentumNeed = 0.01 }) {
  const list = tradingDays().filter((d) => d >= from && d <= to);
  const a = newAccount();
  for (let i = 0; i < list.length; i++) {
    const date = list[i];
    a.curDate = date;
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
        if ((mvNow + perAmount) / ta.total > maxExp + 1e-6) continue;
        const budget = Math.min(perAmount, Math.max(0, a.cash - ta.total * STRATEGY.minCashPct));
        if (budget < b.open * 100 * 1.001) continue;
        buy(a, { code: o.code, name: m.stocks[o.code]?.name, open: b.open, targetAmount: budget, date, reason: o.reason });
      }
    }
    markToMarket(a, date);
    const w = weatherAt(date);
    const ib2 = m.index.bars;
    const cut = ib2.findIndex((b) => b.date === date);
    if (cut < 21) continue;
    const chg1 = ib2[cut].close / ib2[cut - 1].close - 1;
    const chg5 = ib2[cut].close / ib2[cut - 5].close - 1;
    const hi20 = Math.max(...ib2.slice(cut - 19, cut + 1).map((b) => b.close));
    const room = ib2[cut].close / hi20 - 1;

    if (!w.above || chg5 <= -0.01 || chg1 <= -0.015) {
      for (const p of Object.values(a.positions)) {
        if (a.pending.find((x) => x.code === p.code && x.action === 'sell')) continue;
        a.pending.push({ action: 'sell', code: p.code, name: p.name, reason: `规则清仓` });
      }
      continue;
    }
    if (!(w.above && chg5 >= momentumNeed && room <= -needRoom)) continue;
    if (Object.keys(a.positions).length >= maxPos) continue;
    const ranked = rankAt(date, { top: 30, gate: w.gate });
    for (const c of ranked.slice(0, 10)) {
      if (Object.keys(a.positions).length >= maxPos) break;
      if (a.positions[c.code]) continue;
      if (a.pending.find((x) => x.code === c.code && x.action === 'buy')) continue;
      if (c.vol > volCap) continue;
      a.pending.push({ action: 'buy', code: c.code, name: c.name, reason: `规则建仓` });
    }
  }
  const last = a.snapshots.at(-1);
  a.final = {
    total: last.total, pnlPct: last.total / INITIAL_CAPITAL - 1, trades: a.trades.length,
    maxDrawdown: (() => { let p = -Infinity, d = 0; for (const s of a.snapshots) { p = Math.max(p, s.total); d = Math.min(d, s.total / p - 1); } return d; })(),
    cashDays: a.snapshots.filter((s) => s.mktValue < 1).length,
    days: a.snapshots.length,
  };
  return a;
}

const trader = runTraderPolicy({ from: START, to: END });
console.log(`\n操盘手打法（趋势过滤 + 空仓）  ${trader.final.total.toFixed(2)} 元  ${(trader.final.pnlPct * 100).toFixed(2)}%  回撤 ${(trader.final.maxDrawdown * 100).toFixed(2)}%  成交 ${trader.final.trades} 笔  空仓 ${trader.final.cashDays}/${trader.final.days} 天`);

const mech = runPlan(null, { start: START, end: END, mechanical: true, autoRules: true, verbose: false });
console.log(`机械规则（动能+止损止盈）      ${mech.account.final.total.toFixed(2)} 元  ${(mech.account.final.pnlPct * 100).toFixed(2)}%  回撤 ${(mech.account.final.maxDrawdown * 100).toFixed(2)}%  成交 ${mech.account.final.trades} 笔`);

const mechTrend = runPlan(null, { start: START, end: END, mechanical: true, autoRules: true, verbose: false, buyGate: (w) => w.above });
console.log(`机械规则 + MA20 闸门           ${mechTrend.account.final.total.toFixed(2)} 元  ${(mechTrend.account.final.pnlPct * 100).toFixed(2)}%  回撤 ${(mechTrend.account.final.maxDrawdown * 100).toFixed(2)}%  成交 ${mechTrend.account.final.trades} 笔`);

console.log(`完全空仓                       100000.00 元  0.00%`);
console.log(`上证指数                        ${(100000 * (1 + idxRet)).toFixed(2)} 元  ${(idxRet * 100).toFixed(2)}%`);

const res = {
  range: [ib[0].date, ib.at(-1).date], days: ib.length,
  index: { ret: idxRet, mdd: idxMdd },
  trader: trader.final, mech: mech.account.final, mechTrend: mechTrend.account.final,
};
fs.writeFileSync(path.join(OUT, `longrun-${START}.json`), JSON.stringify(res, null, 2));
console.log(`\n已写入 data/replay/longrun-${START}.json`);
