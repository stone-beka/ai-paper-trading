// 被动/低换手策略的诚实检验：指数本身 + 等权篮子 + 趋势过滤，长周期真实数据
import fs from 'node:fs';
import path from 'node:path';
import { market } from './engine.js';

const OUT = path.join(process.cwd(), 'data', 'replay');
const m = market();
const ib = m.index.bars; // 2018-07-17 ~ 2026-10-16

const fmt = (n) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';

console.log(`指数数据：${ib[0].date} ~ ${ib.at(-1).date}（${ib.length} 根，约 ${(ib.length / 242).toFixed(1)} 年）\n`);

/** 从任意起点持有到终点 */
function holdFrom(startDate, endDate = ib.at(-1).date) {
  const seg = ib.filter((b) => b.date >= startDate && b.date <= endDate);
  if (seg.length < 2) return null;
  const ret = seg.at(-1).close / seg[0].close - 1;
  let pk = -Infinity, mdd = 0;
  for (const b of seg) { pk = Math.max(pk, b.close); mdd = Math.min(mdd, b.close / pk - 1); }
  const years = seg.length / 242;
  return { start: seg[0].date, end: seg.at(-1).date, years, ret, mdd, cagr: Math.pow(1 + ret, 1 / years) - 1, days: seg.length };
}

console.log('===== 检验 A：买入上证指数并持有（无幸存者偏差、无换手） =====');
const starts = ['2018-07-17', '2019-01-02', '2020-01-02', '2021-01-04', '2022-01-04', '2023-01-03', '2024-01-02', '2025-01-02', '2026-01-05'];
for (const s of starts) {
  const r = holdFrom(s);
  if (r) console.log(`  从 ${r.start} 持有至今：${pct(r.ret)}（${r.years.toFixed(1)} 年，年化 ${pct(r.cagr)}，最大回撤 ${pct(r.mdd)}）`);
}

console.log('\n===== 检验 B：等权买入一篮子股票并持有（含幸存者偏差，仅供参考） =====');
function equalWeightBasket(from, to, { rebalanceDays = null, topN = null, sizeFilter = null } = {}) {
  const codes = Object.keys(m.stocks);
  const series = [];
  for (const code of codes) {
    const bars = m.stocks[code].bars.filter((b) => b.date >= from && b.date <= to);
    if (bars.length < 100) continue;
    series.push(bars);
  }
  if (!series.length) return null;
  // 对齐到共同日期（以指数日历为准）
  const dates = ib.filter((b) => b.date >= from && b.date <= to).map((b) => b.date);
  let value = 100000;
  let prevClose = new Map();
  let peak = -Infinity, mdd = 0;
  const snaps = [];
  for (let di = 0; di < dates.length; di++) {
    const d = dates[di];
    const cur = new Map();
    for (const bars of series) {
      const b = bars.find((x) => x.date === d);
      if (b) cur.set(bars, b.close);
    }
    if (di === 0) { prevClose = cur; continue; }
    // 等权日收益
    let sum = 0, n = 0;
    for (const [bars, c] of cur) {
      const p = prevClose.get(bars);
      if (p && p > 0) { sum += c / p - 1; n++; }
    }
    if (n) value *= 1 + sum / n;
    prevClose = cur;
    peak = Math.max(peak, value);
    mdd = Math.min(mdd, value / peak - 1);
    if (di % 20 === 0) snaps.push({ date: d, value });
  }
  const years = dates.length / 242;
  return { ret: value / 100000 - 1, mdd, years, cagr: Math.pow(value / 100000, 1 / years) - 1, n: series.length, final: value };
}
for (const [f, t] of [['2023-01-03', '2026-10-16'], ['2024-01-02', '2026-10-16'], ['2025-01-02', '2026-10-16']]) {
  const r = equalWeightBasket(f, t);
  if (r) console.log(`  ${f} ~ ${t}（${r.n} 只等权，不换手）：${pct(r.ret)}（年化 ${pct(r.cagr)}，最大回撤 ${pct(r.mdd)}）`);
}

console.log('\n===== 检验 C：指数择时（MA20 上持有、下方空仓）到底有没有用 =====');
function maTiming(from, to, ma = 20) {
  const seg = ib.filter((b) => b.date >= from && b.date <= to);
  let value = 100000;
  let peak = -Infinity, mdd = 0;
  let inDays = 0;
  for (let i = ma; i < seg.length; i++) {
    const maVal = seg.slice(i - ma, i).reduce((a, b) => a + b.close, 0) / ma;
    const above = seg[i - 1].close >= maVal; // 用昨收判断，今日持有（无未来函数）
    const dailyRet = seg[i].close / seg[i - 1].close - 1;
    if (above) { value *= 1 + dailyRet; inDays++; }
    peak = Math.max(peak, value);
    mdd = Math.min(mdd, value / peak - 1);
  }
  const years = (seg.length - ma) / 242;
  return { ret: value / 100000 - 1, mdd, years, cagr: Math.pow(value / 100000, 1 / years) - 1, inRatio: inDays / (seg.length - ma), final: value };
}
for (const [f, t] of [['2023-01-03', '2026-10-16'], ['2024-01-02', '2026-10-16'], ['2019-01-02', '2026-10-16']]) {
  const bh = holdFrom(f, t);
  const tm = maTiming(f, t);
  if (bh && tm) {
    console.log(`  ${f} ~ ${t}`);
    console.log(`    买入持有    ${pct(bh.ret)}  回撤 ${pct(bh.mdd)}  年化 ${pct(bh.cagr)}`);
    console.log(`    MA20 择时   ${pct(tm.ret)}  回撤 ${pct(tm.mdd)}  年化 ${pct(tm.cagr)}  （在场时间 ${(tm.inRatio * 100).toFixed(0)}%）`);
  }
}

console.log('\n===== 检验 D：成本对频繁交易的真实杀伤（用实测口径） =====');
const roundTripCost = 0.00025 * 2 + 0.0005 + 0.001 * 2; // 0.3%
console.log(`  一次完整买卖成本率 ${(roundTripCost * 100).toFixed(2)}%`);
for (const [label, perYear] of [['每年 1 次（躺平）', 1], ['每月 1 次', 12], ['每周 1 次', 50], ['每天 1 次', 242]]) {
  const drag = Math.pow(1 - roundTripCost, perYear) - 1;
  console.log(`  ${label.padEnd(16)} 年化成本拖累 ${pct(drag)}   → 10 年后还剩 ${((1 + drag) ** 10 * 100).toFixed(1)}%`);
}
