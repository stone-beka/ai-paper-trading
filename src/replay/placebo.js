// 安慰剂检验（placebo test）：跑 N 个随机组合，看各因子策略是否超出随机分布
// 这是区分「alpha」与「运气/池子beta」最干净的判据
import fs from 'node:fs';
import path from 'node:path';
import { backtest, poolAt, pct, buildIndex, metrics } from './harness.js';
import { market } from './engine.js';

const OUT = path.join(process.cwd(), 'data', 'replay');
const m = market();

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function factorOf(meta, code, date) {
  const mm = meta.get(code);
  if (!mm) return null;
  let lo = 0, hi = mm.bars.length - 1, f = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (mm.bars[mid].date <= date) { f = mid; lo = mid + 1; } else hi = mid - 1; }
  const cut = f + 1;
  if (cut < 130) return null;
  const bars = mm.bars;
  const close = bars[cut - 1].close;
  const ret20 = close / bars[cut - 21].close - 1;
  const ret60 = close / bars[cut - 61].close - 1;
  const rets = [];
  for (let i = cut - 20; i < cut; i++) rets.push(bars[i].close / bars[i - 1].close - 1);
  const mean = rets.reduce((a, x) => a + x, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / rets.length) * Math.sqrt(20);
  const amt20 = bars.slice(cut - 20, cut).reduce((a, b) => a + b.close * b.volume * 100, 0) / 20;
  return { close, ret20, ret60, vol, amt20 };
}

function uniq(arr) {
  const s = new Set();
  const out = [];
  for (const x of arr) if (!s.has(x)) { s.add(x); out.push(x); }
  return out;
}

const WINDOWS = [
  { label: '全区间 2023-06-01 ~ 2026-10-16', from: '2023-06-01', to: '2026-10-16' },
  { label: '样本外 2025-03-01 ~ 2026-10-16', from: '2025-03-01', to: '2026-10-16' },
];

const N_RANDOM = 300;
const summary = {};

for (const W of WINDOWS) {
  const codes = poolAt(W.from, { minBefore: 60, minAfter: 30 });
  const meta = buildIndex(codes).meta;
  const N = 20;

  // ---- 1) 随机组合分布 ----
  const randoms = [];
  for (let k = 0; k < N_RANDOM; k++) {
    const rnd = mulberry32(1000 + k);
    const r = backtest({
      codes, from: W.from, to: W.to, rebalanceEvery: 63, label: `random-${k}`,
      pickFn: (d) => {
        const arr = [...meta.keys()];
        for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
        return arr.slice(0, N).map((c) => ({ code: c, weight: 1 / N }));
      },
    });
    if (r) randoms.push(r);
  }
  const rets = randoms.map((r) => r.ret).sort((a, b) => a - b);
  const mdds = randoms.map((r) => r.mdd).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const mean = rets.reduce((a, x) => a + x, 0) / rets.length;

  console.log(`\n████ ${W.label}   票池 ${codes.length} 只`);
  console.log(`  随机 ${N} 只 + 季度调仓，跑 ${N_RANDOM} 次：`);
  console.log(`    收益 中位 ${pct(q(rets, 0.5))} | 5%~95% 区间 [${pct(q(rets, 0.05))}, ${pct(q(rets, 0.95))}] | 最好 ${pct(rets.at(-1))} | 最差 ${pct(rets[0])}`);
  console.log(`    回撤 中位 ${pct(q(mdds, 0.5))} | 5%~95% 区间 [${pct(q(mdds, 0.05))}, ${pct(q(mdds, 0.95))}]`);

  // ---- 2) 因子策略，看是否超过随机分布 95 分位 ----
  const NAMES = [
    ['低波动', (f) => -f.vol],
    ['高动量20', (f) => f.ret20],
    ['中期动量60', (f) => f.ret60],
    ['反转20', (f) => -f.ret20],
    ['反转60', (f) => -f.ret60],
    ['小成交额', (f) => -f.amt20],
    ['大成交额', (f) => f.amt20],
    ['低波动+动量', (f) => 0.5 * f.ret60 - 0.5 * f.vol],
  ];
  const rows = [];
  for (const [name, scorer] of NAMES) {
    const r = backtest({
      codes, from: W.from, to: W.to, rebalanceEvery: 63, label: name,
      pickFn: (d) => {
        const arr = [];
        for (const code of meta.keys()) {
          const f = factorOf(meta, code, d);
          if (!f || f.amt20 < 3000e4) continue;
          const s = scorer(f);
          if (Number.isFinite(s)) arr.push({ code, s });
        }
        arr.sort((a, b) => b.s - a.s);
        const picks = arr.slice(0, N);
        return picks.map((p) => ({ code: p.code, weight: 1 / N }));
      },
    });
    if (!r) continue;
    const percentile = rets.filter((x) => x < r.ret).length / rets.length;
    rows.push({ name, ret: r.ret, mdd: r.mdd, percentile, beats95: r.ret > q(rets, 0.95), final: r.final });
  }
  console.log(`\n  ${'因子(随机20只/季度调仓)'.padEnd(28)} 收益       回撤      在随机分布中的分位   超过95%?`);
  for (const r of rows.sort((a, b) => b.ret - a.ret)) {
    console.log(`  ${r.name.padEnd(26)} ${pct(r.ret).padStart(9)} ${pct(r.mdd).padStart(9)} ${(r.percentile * 100).toFixed(1).padStart(12)}% ${r.beats95 ? '  ✅ 是' : '  ❌ 否'}`);
  }
  summary[W.label] = {
    pool: codes.length,
    random: { median: q(rets, 0.5), p5: q(rets, 0.05), p95: q(rets, 0.95), best: rets.at(-1), worst: rets[0], mddMedian: q(mdds, 0.5) },
    factors: rows,
  };
}

fs.writeFileSync(path.join(OUT, 'placebo.json'), JSON.stringify(summary, null, 2));
console.log('\n已写入 data/replay/placebo.json');
