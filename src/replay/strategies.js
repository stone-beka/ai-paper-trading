// 策略库 + 横向评测
import fs from 'node:fs';
import path from 'node:path';
import { rankAt, weatherAt, market } from './engine.js';
import { scoreStock } from '../lib/strategy.js';
import { backtest, poolAt, pct, fmt, buildIndex } from './harness.js';

const OUT = path.join(process.cwd(), 'data', 'replay');
const m = market();

// 确定性随机
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 计算某票在 date 的因子（只用截至 date 的数据） */
function factorOf(meta, code, date, pcache) {
  const mm = meta.get(code);
  if (!mm) return null;
  const idx = mm.dates.indexOf(date);
  const cut = idx >= 0 ? idx + 1 : (() => { let lo = 0, hi = mm.dates.length - 1, f = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (mm.dates[mid] <= date) { f = mid; lo = mid + 1; } else hi = mid - 1; } return f + 1; })();
  if (cut < 130) return null;
  const bars = mm.bars.slice(0, cut);
  const close = bars[cut - 1].close;
  const ret20 = close / bars[cut - 21].close - 1;
  const ret60 = close / bars[cut - 61].close - 1;
  const ret120 = cut >= 121 ? close / bars[cut - 121].close - 1 : null;
  const rets = [];
  for (let i = cut - 20; i < cut; i++) rets.push(bars[i].close / bars[i - 1].close - 1);
  const mean = rets.reduce((a, x) => a + x, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / rets.length) * Math.sqrt(20);
  const amt20 = bars.slice(-20).reduce((a, b) => a + b.close * b.volume * 100, 0) / 20;
  return { close, ret20, ret60, ret120, vol, amt20, bars };
}

/** 按因子排序选前 N 等权 */
function topN(meta, date, N, scorer, { minAmt = 8000e4, pcache } = {}) {
  const rows = [];
  for (const code of meta.keys()) {
    const f = factorOf(meta, code, date, pcache);
    if (!f) continue;
    if (f.amt20 < minAmt) continue;
    const s = scorer(f);
    if (s == null || !Number.isFinite(s)) continue;
    rows.push({ code, s });
  }
  rows.sort((a, b) => b.s - a.s);
  const picks = rows.slice(0, N);
  const w = picks.length ? 1 / picks.length : 0;
  return picks.map((p) => ({ code: p.code, weight: w }));
}

export function runStrategySet({ from, to, label, codes }) {
  const meta = buildIndex(codes).meta;
  const pcache = new Map();
  const tests = [];
  const add = (name, opts) => {
    const r = backtest({ codes, from, to, label: name, ...opts });
    if (r) tests.push(r);
  };

  // ---------- 对照基准 ----------
  add('① 现金（什么都不做）', { rebalanceEvery: 0, pickFn: () => [] });

  add('② 等权买入全部票池并持有', {
    rebalanceEvery: 0,
    pickFn: (d, ctx) => [...meta.keys()].map((c) => ({ code: c, weight: 1 / meta.size })),
  });

  // 随机 30 只，年度再平衡（对照：量化"选股 vs 随机"）
  add('③ 随机 30 只 + 年度再平衡', {
    rebalanceEvery: 242,
    pickFn: (d, ctx) => {
      const rnd = mulberry32([...String(d)].reduce((a, ch) => a + ch.charCodeAt(0), 7));
      const arr = [...meta.keys()];
      for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      return arr.slice(0, 30).map((c) => ({ code: c, weight: 1 / 30 }));
    },
  });

  // ---------- 因子策略 ----------
  add('④ 低波动 30 只 + 年度再平衡', {
    rebalanceEvery: 242,
    pickFn: (d, ctx) => topN(meta, d, 30, (f) => -f.vol, { pcache }),
  });

  add('⑤ 高动量 20 只 + 月度调仓', {
    rebalanceEvery: 21,
    pickFn: (d, ctx) => topN(meta, d, 20, (f) => f.ret20, { pcache }),
  });

  add('⑥ 高动量 20 只 + 年度再平衡', {
    rebalanceEvery: 242,
    pickFn: (d, ctx) => topN(meta, d, 20, (f) => f.ret20, { pcache }),
  });

  add('⑦ 中期动量(60日) 20 只 + 季度调仓', {
    rebalanceEvery: 63,
    pickFn: (d, ctx) => topN(meta, d, 20, (f) => f.ret60, { pcache }),
  });

  add('⑧ 反转：近20日跌幅最大 20 只 + 月度调仓', {
    rebalanceEvery: 21,
    pickFn: (d, ctx) => topN(meta, d, 20, (f) => -f.ret20, { pcache }),
  });

  add('⑨ 反转：近60日跌幅最大 20 只 + 季度调仓', {
    rebalanceEvery: 63,
    pickFn: (d, ctx) => topN(meta, d, 20, (f) => -f.ret60, { pcache }),
  });

  add('⑩ 长期赢家：120日涨幅前 30 + 年度再平衡', {
    rebalanceEvery: 242,
    pickFn: (d, ctx) => topN(meta, d, 30, (f) => f.ret120 ?? -99, { pcache }),
  });

  add('⑪ 低波动+动量混合 20 只 + 季度调仓', {
    rebalanceEvery: 63,
    pickFn: (d, ctx) => topN(meta, d, 20, (f) => 0.5 * f.ret60 - 0.5 * f.vol, { pcache }),
  });

  add('⑫ 小成交额（小盘代理）30 只 + 年度再平衡', {
    rebalanceEvery: 242,
    pickFn: (d, ctx) => topN(meta, d, 30, (f) => -f.amt20, { pcache, minAmt: 3000e4 }),
  });

  add('⑬ 大成交额（大盘代理）30 只 + 年度再平衡', {
    rebalanceEvery: 242,
    pickFn: (d, ctx) => topN(meta, d, 30, (f) => f.amt20, { pcache }),
  });

  // 指数对照
  const ib = m.index.bars.filter((b) => b.date >= from && b.date <= to);
  if (ib.length > 5) {
    const idxRet = ib.at(-1).close / ib[0].close - 1;
    let pk = -Infinity, mdd = 0;
    for (const b of ib) { pk = Math.max(pk, b.close); mdd = Math.min(mdd, b.close / pk - 1); }
    const years = ib.length / 242;
    tests.push({
      label: '⑭ 上证指数买入持有', final: 100000 * (1 + idxRet), ret: idxRet, mdd,
      cagr: Math.pow(1 + idxRet, 1 / years) - 1, days: ib.length, years, rebalances: 0, turnover: 0, curve: [],
      calmar: idxRet > 0 ? Math.pow(1 + idxRet, 1 / years) - 1 / Math.abs(mdd) : null,
    });
  }

  return tests;
}

// ---------------- 执行 ----------------
const WINDOWS = [
  { label: '全区间 2023-06-01 ~ 2026-10-16', from: '2023-06-01', to: '2026-10-16' },
  { label: '前半段（样本内）2023-06-01 ~ 2025-02-28', from: '2023-06-01', to: '2025-02-28' },
  { label: '后半段（样本外）2025-03-01 ~ 2026-10-16', from: '2025-03-01', to: '2026-10-16' },
];

const all = {};
for (const W of WINDOWS) {
  const codes = poolAt(W.from, { minBefore: 60, minAfter: 30 });
  console.log(`\n\n████ ${W.label}   票池 ${codes.length} 只`);
  const tests = runStrategySet({ from: W.from, to: W.to, label: W.label, codes });
  all[W.label] = tests.map((t) => ({ label: t.label, ret: t.ret, cagr: t.cagr, mdd: t.mdd, final: t.final, rebalances: t.rebalances, turnover: t.turnover, days: t.days }));
  console.log('  #  策略                                    总收益     年化      最大回撤   换手   调仓次数');
  for (const t of tests) {
    console.log(`  ${t.label.padEnd(42)} ${pct(t.ret).padStart(9)} ${pct(t.cagr).padStart(8)} ${pct(t.mdd).padStart(10)} ${(t.turnover * 100).toFixed(0).padStart(5)}% ${String(t.rebalances).padStart(6)}`);
  }
}

fs.writeFileSync(path.join(OUT, 'strategy-sweep.json'), JSON.stringify(all, null, 2));
console.log('\n已写入 data/replay/strategy-sweep.json');
