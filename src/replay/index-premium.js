// 用真实指数历史测"小市值溢价"——完全规避个股池的幸存者偏差与流动性偏差
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = path.join(process.cwd(), 'data', 'replay');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

const INDICES = [
  ['sh000300', '沪深300（大盘）'],
  ['sh000905', '中证500（中盘）'],
  ['sh000852', '中证1000（小盘）'],
  ['sz399303', '国证2000（小盘）'],
  ['sh000847', 'sh000847（待确认，疑似微盘/小市值）'],
  ['sh000001', '上证指数'],
  ['sh000985', '中证全指'],
];

function fetchKline(sym, len = 2000) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=${len}`;
  const out = execFileSync('curl.exe', ['-s', '-m', '40', '-A', UA, '-e', 'https://finance.sina.com.cn/', url], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const arr = JSON.parse(out);
  return arr.map((b) => ({ date: b.day, close: +b.close }));
}

const data = {};
for (const [sym, name] of INDICES) {
  try {
    const bars = fetchKline(sym);
    data[sym] = { name, bars };
    console.log(`✅ ${name.padEnd(30)} ${bars.length} 根  ${bars[0].date} ~ ${bars.at(-1).date}`);
  } catch (e) {
    console.log(`❌ ${name.padEnd(30)} ${e.message.slice(0, 70)}`);
  }
}

// 输出各指数的绝对点位与区间，人工识别哪个是微盘
console.log('\n各指数首末点位（确认身份）：');
for (const [sym, d] of Object.entries(data)) {
  console.log(`  ${sym}  ${d.bars[0].date} ${d.bars[0].close} -> ${d.bars.at(-1).date} ${d.bars.at(-1).close}`);
}

/** 区间统计 */
function stats(bars, from, to) {
  const seg = bars.filter((b) => b.date >= from && b.date <= to);
  if (seg.length < 30) return null;
  const c0 = seg[0].close, c1 = seg.at(-1).close;
  let pk = -Infinity, mdd = 0;
  for (const b of seg) { pk = Math.max(pk, b.close); mdd = Math.min(mdd, b.close / pk - 1); }
  const years = seg.length / 242;
  return {
    from: seg[0].date, to: seg.at(-1).date, days: seg.length, years,
    ret: c1 / c0 - 1, cagr: Math.pow(c1 / c0, 1 / years) - 1, mdd,
    calmar: (Math.pow(c1 / c0, 1 / years) - 1) / Math.abs(mdd || 1e-9),
  };
}

const WINDOWS = [
  ['2018-07-17', '2026-10-16', '8.3 年（最长可比区间）'],
  ['2019-01-02', '2026-10-16', '7.8 年'],
  ['2021-01-04', '2026-10-16', '5.8 年'],
  ['2023-01-03', '2026-10-16', '3.8 年（与我的回放同期）'],
  ['2025-01-02', '2026-10-16', '1.8 年'],
];

const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const result = { indices: {}, windows: {} };

console.log('\n' + '='.repeat(96));
for (const [f, t, label] of WINDOWS) {
  console.log(`\n██ ${label}  ${f} ~ ${t}`);
  console.log(`  ${'指数'.padEnd(34)} ${'总收益'.padStart(10)} ${'年化'.padStart(9)} ${'最大回撤'.padStart(10)} ${'Calmar'.padStart(8)}`);
  const row = {};
  for (const [sym, d] of Object.entries(data)) {
    const s = stats(d.bars, f, t);
    if (!s) continue;
    row[sym] = s;
    console.log(`  ${d.name.padEnd(32)} ${pct(s.ret).padStart(10)} ${pct(s.cagr).padStart(9)} ${pct(s.mdd).padStart(10)} ${s.calmar.toFixed(2).padStart(8)}`);
  }
  result.windows[label] = row;
}

result.indices = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { name: v.name, first: v.bars[0].date, last: v.bars.at(-1).date, n: v.bars.length }]));
fs.writeFileSync(path.join(OUT, 'index-premium.json'), JSON.stringify(result, null, 2));
// 存原始序列供后续复用
fs.writeFileSync(path.join(OUT, 'indices-raw.json'), JSON.stringify(data));
console.log('\n已写入 data/replay/index-premium.json 与 indices-raw.json');
