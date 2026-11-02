// 确认指数身份 + 用真实指数做资产配置回测
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = path.join(process.cwd(), 'data', 'replay');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

// ---------- 1) 确认 sh000847 是什么 ----------
console.log('===== 确认指数身份 =====');
for (const sym of ['sh000847', 'sh000852', 'sz399303', 'sh000905', 'sh000300', 'sh000985', 'sh000922', 'sh000923']) {
  try {
    const out = execFileSync('curl.exe', ['-s', '-m', '15', '-A', UA, '-e', 'https://gu.qq.com/', `https://qt.gtimg.cn/q=${sym}`], { encoding: 'latin1', maxBuffer: 1 << 20 });
    const m = out.match(/="([^"]*)"/);
    if (!m) { console.log(`  ${sym}  无数据`); continue; }
    const f = m[1].split('~');
    console.log(`  ${sym}  名称=${f[1]}  最新=${f[3]}`);
  } catch (e) {
    console.log(`  ${sym}  失败 ${e.message.slice(0, 40)}`);
  }
}

// ---------- 2) 用真实指数做配置回测 ----------
const raw = JSON.parse(fs.readFileSync(path.join(OUT, 'indices-raw.json'), 'utf8'));
const NAMES = {
  sh000300: '沪深300', sh000905: '中证500', sh000852: '中证1000',
  sz399303: '国证2000', sh000847: 'sh000847(最小市值)', sh000001: '上证指数',
};

function alignSeries(from, to) {
  const out = {};
  for (const [sym, d] of Object.entries(raw)) {
    out[sym] = d.bars.filter((b) => b.date >= from && b.date <= to);
  }
  return out;
}

/** 固定权重组合，年度再平衡（按单边 0.15% 计成本） */
function portfolio(weights, from, to, { rebalanceMonths = 12, cost = 0.0015 } = {}) {
  const series = alignSeries(from, to);
  const syms = Object.keys(weights).filter((s) => series[s]?.length > 30);
  if (!syms.length) return null;
  const dates = series[syms[0]].map((b) => b.date);
  const px = {};
  for (const s of syms) px[s] = new Map(series[s].map((b) => [b.date, b.close]));

  const totalW = syms.reduce((a, s) => a + weights[s], 0);
  let units = {};
  let cash = 0;
  const cap = 100000;
  for (const s of syms) {
    const invest = (cap * weights[s]) / totalW;
    units[s] = (invest * (1 - cost)) / px[s].get(dates[0]);
  }
  let nextIdx = Math.round(21 * rebalanceMonths);
  let rebalances = 0;
  const curve = [];
  let peak = -Infinity, mdd = 0;
  const valAt = (d) => {
    let v = cash;
    for (const s of syms) v += units[s] * (px[s].get(d) ?? lastPx(px[s], d, dates[0]));
    return v;
  };
  function lastPx(mp, d, fb) { let best = null; for (const [k, v] of mp) { if (k <= d) best = v; else break; } return best ?? mp.get(fb); }

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const v = valAt(d);
    peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1);
    curve.push({ date: d, value: +v.toFixed(2) });
    if (i >= nextIdx && i < dates.length - 1) {
      const total = valAt(d) * (1 - cost);
      for (const s of syms) units[s] = (total * weights[s]) / totalW / (px[s].get(d) ?? lastPx(px[s], d, dates[0]));
      cash = 0; rebalances++;
      nextIdx += Math.round(21 * rebalanceMonths);
    }
  }
  const final = valAt(dates.at(-1));
  const years = dates.length / 242;
  return { final, ret: final / cap - 1, cagr: Math.pow(final / cap, 1 / years) - 1, mdd, years, rebalances, days: dates.length };
}

const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const WINDOWS = [
  ['2018-07-17', '2026-10-16', '8.3 年'],
  ['2021-01-04', '2026-10-16', '5.8 年'],
  ['2023-01-03', '2026-10-16', '3.8 年'],
];

const PLANS = [
  ['100% 上证指数', { sh000001: 1 }],
  ['100% 沪深300', { sh000300: 1 }],
  ['100% 最小市值(sh000847)', { sh000847: 1 }],
  ['100% 国证2000', { sz399303: 1 }],
  ['50% 沪深300 + 50% 最小市值', { sh000300: 0.5, sh000847: 0.5 }],
  ['30% 沪深300 + 40% 最小市值 + 30% 现金', { sh000300: 0.3, sh000847: 0.4 }],
  ['60% 最小市值 + 40% 现金', { sh000847: 0.6 }],
  ['等权 5 个指数', { sh000300: 0.2, sh000905: 0.2, sh000852: 0.2, sz399303: 0.2, sh000847: 0.2 }],
];

const result = {};
for (const [f, t, label] of WINDOWS) {
  console.log(`\n████ ${label}   ${f} ~ ${t}`);
  console.log(`  ${'配置（年度再平衡）'.padEnd(40)} ${'期末'.padStart(10)} ${'总收益'.padStart(10)} ${'年化'.padStart(9)} ${'回撤'.padStart(9)}`);
  const rows = [];
  for (const [name, w] of PLANS) {
    const r = portfolio(w, f, t);
    if (!r) continue;
    // 未投入的部分视为现金
    const invested = Object.values(w).reduce((a, x) => a + x, 0);
    const cashPart = Math.max(0, 1 - invested);
    const rAdj = cashPart > 0 ? (() => {
      const blended = portfolio(w, f, t);
      const finalWithCash = blended.final * invested + 100000 * cashPart;
      const years = blended.years;
      const ret = finalWithCash / 100000 - 1;
      return { final: finalWithCash, ret, cagr: Math.pow(1 + ret, 1 / years) - 1, mdd: blended.mdd, years, rebalances: blended.rebalances };
    })() : r;
    rows.push({ name, ...rAdj });
    console.log(`  ${name.padEnd(38)} ${(rAdj.final / 10000).toFixed(2).padStart(9)}万 ${pct(rAdj.ret).padStart(10)} ${pct(rAdj.cagr).padStart(9)} ${pct(rAdj.mdd).padStart(9)}`);
  }
  result[label] = rows;
}

fs.writeFileSync(path.join(OUT, 'allocation.json'), JSON.stringify(result, null, 2));
console.log('\n已写入 data/replay/allocation.json');
