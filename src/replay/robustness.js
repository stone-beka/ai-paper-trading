// 稳健性检验：逐年分段 + 参数敏感性（判断是"真规则"还是"幸存者叙事"）
import fs from 'node:fs';
import path from 'node:path';
import { market, tradingDays, weatherAt, rankAt, barAt, newAccount, buy, sell, markToMarket, totalAssets, STRATEGY, INITIAL_CAPITAL } from './engine.js';

const OUT = path.join(process.cwd(), 'data', 'replay');
const m = market();

/** 操盘手打法（可调参数） */
function runTrader({ from, to, maxPos = 4, volCap = 0.3, needRoom = 0.03, momentumNeed = 0.01, rankDepth = 10, cashOnClear = true }) {
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
        if (a.positions[o.code] || Object.keys(a.positions).length >= maxPos) continue;
        const b = barAt(o.code, date);
        if (!b || !(b.open > 0)) continue;
        const mvNow = Object.values(a.positions).reduce((s, p) => s + (barAt(p.code, date)?.open ?? p.lastPrice) * p.shares, 0);
        const per = ta.total * STRATEGY.positionPct;
        if ((mvNow + per) / ta.total > maxExp + 1e-6) continue;
        const budget = Math.min(per, Math.max(0, a.cash - ta.total * STRATEGY.minCashPct));
        if (budget < b.open * 100 * 1.001) continue;
        buy(a, { code: o.code, name: m.stocks[o.code]?.name, open: b.open, targetAmount: budget, date, reason: o.reason });
      }
    }
    markToMarket(a, date);
    const w = weatherAt(date);
    const ib = m.index.bars;
    const cut = ib.findIndex((b) => b.date === date);
    if (cut < 21) continue;
    const chg1 = ib[cut].close / ib[cut - 1].close - 1;
    const chg5 = ib[cut].close / ib[cut - 5].close - 1;
    const hi20 = Math.max(...ib.slice(cut - 19, cut + 1).map((b) => b.close));
    const room = ib[cut].close / hi20 - 1;

    if (!w.above || chg5 <= -0.01 || chg1 <= -0.015) {
      if (cashOnClear) {
        for (const p of Object.values(a.positions)) {
          if (a.pending.find((x) => x.code === p.code && x.action === 'sell')) continue;
          a.pending.push({ action: 'sell', code: p.code, name: p.name, reason: '规则清仓' });
        }
      }
      continue;
    }
    if (!(w.above && chg5 >= momentumNeed && room <= -needRoom)) continue;
    if (Object.keys(a.positions).length >= maxPos) continue;
    const ranked = rankAt(date, { top: 30, gate: w.gate });
    for (const c of ranked.slice(0, rankDepth)) {
      if (Object.keys(a.positions).length >= maxPos) break;
      if (a.positions[c.code]) continue;
      if (a.pending.find((x) => x.code === c.code && x.action === 'buy')) continue;
      if (c.vol > volCap) continue;
      a.pending.push({ action: 'buy', code: c.code, name: c.name, reason: '规则建仓' });
    }
  }
  const last = a.snapshots.at(-1);
  const stats = (() => { let p = -Infinity, d = 0; for (const s of a.snapshots) { p = Math.max(p, s.total); d = Math.min(d, s.total / p - 1); } return d; })();
  return { total: last.total, ret: last.total / INITIAL_CAPITAL - 1, mdd: stats, trades: a.trades.length, cashDays: a.snapshots.filter((s) => s.mktValue < 1).length, days: a.snapshots.length };
}

function idxOf(from, to) {
  const b = m.index.bars.filter((x) => x.date >= from && x.date <= to);
  return { ret: b.at(-1).close / b[0].close - 1, days: b.length };
}

console.log('================ 检验 1：逐年分段 ================');
const YEARS = [
  ['2023-01-03', '2023-12-29'], ['2024-01-02', '2024-12-31'],
  ['2025-01-02', '2025-12-31'], ['2026-01-05', '2026-10-16'],
];
const yearRows = [];
for (const [f, t] of YEARS) {
  const t1 = runTrader({ from: f, to: t });
  const i1 = idxOf(f, t);
  const label = `${f} ~ ${t}`;
  const ret = t1.ret;
  yearRows.push({ label, trader: ret, idx: i1.ret, mdd: t1.mdd, trades: t1.trades, cashDays: t1.cashDays, days: t1.days });
  console.log(`  ${label}  操盘手打法 ${(ret * 100).toFixed(2).padStart(8)}%  上证 ${(i1.ret * 100).toFixed(2).padStart(8)}%  回撤 ${(t1.mdd * 100).toFixed(1).padStart(6)}%  成交 ${String(t1.trades).padStart(4)} 笔  空仓 ${t1.cashDays}/${t1.days}`);
}

console.log('\n================ 检验 2：参数敏感性（全区间 2023-01-03 ~ 2026-10-16） ================');
const F = '2023-01-03', T = '2026-10-16';
const variants = [
  ['基准（maxPos4 / vol30% / 距高点3% / 动能1% / 排名10）', {}],
  ['只买 1 只', { maxPos: 1 }],
  ['最多买 2 只', { maxPos: 2 }],
  ['最多买 6 只', { maxPos: 6 }],
  ['波动率上限 20%', { volCap: 0.2 }],
  ['波动率上限 50%', { volCap: 0.5 }],
  ['距高点空间要求 1%', { needRoom: 0.01 }],
  ['距高点空间要求 8%', { needRoom: 0.08 }],
  ['5日动能要求 3%', { momentumNeed: 0.03 }],
  ['5日动能要求 0%（放宽）', { momentumNeed: 0 }],
  ['只买排名前 3', { rankDepth: 3 }],
  ['排名放宽到前 20', { rankDepth: 20 }],
  ['不清仓（只停止新增）', { cashOnClear: false }],
];
const paramRows = [];
for (const [name, opts] of variants) {
  const r = runTrader({ from: F, to: T, ...opts });
  paramRows.push({ name, ...r });
  console.log(`  ${name.padEnd(44)} 收益 ${(r.ret * 100).toFixed(2).padStart(8)}%  回撤 ${(r.mdd * 100).toFixed(1).padStart(6)}%  成交 ${String(r.trades).padStart(4)} 笔  空仓 ${String(r.cashDays).padStart(3)}/${r.days}`);
}
const iAll = idxOf(F, T);
console.log(`  ${'（上证指数对照）'.padEnd(44)} 收益 ${(iAll.ret * 100).toFixed(2).padStart(8)}%`);

fs.writeFileSync(path.join(OUT, 'robustness.json'), JSON.stringify({ years: yearRows, params: paramRows, index: iAll }, null, 2));
console.log('\n已写入 data/replay/robustness.json');
