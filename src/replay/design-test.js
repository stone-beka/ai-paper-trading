// 设计候选策略并严格检验（修正版权重口径，含合理性自检）
import fs from 'node:fs';
import path from 'node:path';
import { market } from './engine.js';

const OUT = path.join(process.cwd(), 'data', 'replay');
const m = market();
const ib = m.index.bars;
const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const COST_ONEWAY = 0.0015;

/** 期初真实存在的固定票池：消除幸存者偏差（只要求期初有历史，不要求活到期末） */
function fixedPool(from, { minBefore = 60, minAfter = 30 } = {}) {
  const out = [];
  for (const [code, s] of Object.entries(m.stocks)) {
    const before = s.bars.filter((b) => b.date <= from).length;
    const after = s.bars.filter((b) => b.date >= from).length;
    if (before < minBefore) continue;
    if (after < minAfter) continue;
    out.push(code);
  }
  return out;
}

/**
 * 等权持有：初始 10 万元等额买入 N 只，之后不动（可选定期再平衡）
 * 返回净值曲线与指标
 */
function equalWeight(pool, from, to, { rebalanceMonths = null } = {}) {
  const dates = ib.filter((b) => b.date >= from && b.date <= to).map((b) => b.date);
  if (dates.length < 2) return null;

  const P = new Map();
  for (const code of pool) {
    const mp = new Map();
    for (const b of m.stocks[code].bars) if (b.date >= from && b.date <= to) mp.set(b.date, b.close);
    if (mp.size > 5) P.set(code, mp);
  }
  const codes = [...P.keys()];
  if (codes.length < 10) return null;

  let cash = 100000;
  const shares = new Map(codes.map((c) => [c, 0]));

  // 首日等额买入（含买入成本；买不起一手的按比例少买，这里用连续份额近似，成本按单边一次性计提）
  const first = dates[0];
  const per = (cash / codes.length) * (1 - COST_ONEWAY);
  for (const c of codes) {
    const p = P.get(c).get(first);
    if (p > 0) shares.set(c, per / p);
  }
  cash = 0;

  const valueAt = (d) => {
    let v = cash;
    for (const c of codes) {
      const p = P.get(c).get(d) ?? lastPrice(P.get(c), d, first);
      if (p) v += shares.get(c) * p;
    }
    return v;
  };
  function lastPrice(mp, d, fallback) {
    // 停牌：沿用此前最后一个有效价
    let best = null;
    for (const [date, p] of mp) { if (date <= d) best = p; else break; }
    return best ?? mp.get(fallback);
  }

  let peak = -Infinity, mdd = 0, rebalances = 0;
  const curve = [];
  let nextRebalanceIdx = null;
  if (rebalanceMonths) nextRebalanceIdx = Math.round((rebalanceMonths * 21));

  for (let di = 0; di < dates.length; di++) {
    const d = dates[di];
    const v = valueAt(d);
    peak = Math.max(peak, v);
    mdd = Math.min(mdd, v / peak - 1);
    if (di % 20 === 0 || di === dates.length - 1) curve.push({ date: d, value: +v.toFixed(2) });

    if (rebalanceMonths && nextRebalanceIdx != null && di >= nextRebalanceIdx && di < dates.length - 1) {
      const total = valueAt(d) * (1 - COST_ONEWAY);
      const w = total / codes.length;
      for (const c of codes) {
        const p = P.get(c).get(d) ?? lastPrice(P.get(c), d, first);
        if (p > 0) shares.set(c, w / p);
      }
      cash = 0;
      rebalances++;
      nextRebalanceIdx += Math.round(rebalanceMonths * 21);
    }
  }

  const finalValue = valueAt(dates.at(-1));
  const years = dates.length / 242;
  return {
    ret: finalValue / 100000 - 1, final: finalValue, mdd, years,
    cagr: Math.pow(finalValue / 100000, 1 / years) - 1, n: codes.length, rebalances, curve,
  };
}

// 合理性自检
console.log('================ 自检：单只股票的收益应由价格驱动 ================');
{
  const pool = fixedPool('2025-01-02', { minBefore: 60, minAfter: 30 });
  const r = equalWeight(pool, '2025-01-02', '2026-10-16');
  console.log(`  票池 ${r.n} 只，期末净值 ${r.final.toFixed(0)} 元（收益率 ${pct(r.ret)}）`);
  // 手工交叉验证：等权收益应约等于各股收益的平均
  let sum = 0, n = 0;
  for (const c of pool) {
    const bars = m.stocks[c].bars.filter((b) => b.date >= '2025-01-02' && b.date <= '2026-10-16');
    if (bars.length < 30) continue;
    sum += bars.at(-1).close / bars[0].close - 1; n++;
  }
  const cross = sum / n;
  console.log(`  交叉验证（逐股收益平均，不含再平衡/成本）：${pct(cross)}  -> 期末 ${(100000 * (1 + cross)).toFixed(0)} 元`);
  console.log(`  两者差异 ${((r.ret - cross) * 100).toFixed(2)} 个百分点（应很小；小差异来自停牌处理与买入成本）`);
}

console.log('\n================ 检验 E：等权 vs 指数 vs 再平衡 ================');
const WINS = [['2023-01-03', '2026-10-16', 60], ['2024-01-02', '2026-10-16', 60], ['2025-01-02', '2026-10-16', 60]];
const eRows = [];
for (const [f, t, mb] of WINS) {
  const pool = fixedPool(f, { minBefore: mb, minAfter: 30 });
  const bh = equalWeight(pool, f, t, {});
  const rb = equalWeight(pool, f, t, { rebalanceMonths: 12 });
  const rq = equalWeight(pool, f, t, { rebalanceMonths: 3 });
  const idxSeg = ib.filter((b) => b.date >= f && b.date <= t);
  const idxRet = idxSeg.at(-1).close / idxSeg[0].close - 1;
  let idxMdd = 0, pk = -Infinity;
  for (const b of idxSeg) { pk = Math.max(pk, b.close); idxMdd = Math.min(idxMdd, b.close / pk - 1); }
  console.log(`\n${f} ~ ${t}   票池 ${bh.n} 只（期初存在，固定不动，含后来可能退市的票）`);
  console.log(`  上证指数          ${pct(idxRet).padStart(9)}   回撤 ${pct(idxMdd)}`);
  console.log(`  等权持有不动       ${pct(bh.ret).padStart(9)}   回撤 ${pct(bh.mdd)}   年化 ${pct(bh.cagr)}`);
  console.log(`  等权+年度再平衡    ${pct(rb.ret).padStart(9)}   回撤 ${pct(rb.mdd)}   年化 ${pct(rb.cagr)}  再平衡 ${rb.rebalances} 次`);
  console.log(`  等权+季度再平衡    ${pct(rq.ret).padStart(9)}   回撤 ${pct(rq.mdd)}   年化 ${pct(rq.cagr)}  再平衡 ${rq.rebalances} 次`);
  eRows.push({ f, t, pool: bh.n, idxRet, idxMdd, bh: { ret: bh.ret, mdd: bh.mdd, cagr: bh.cagr }, rb: { ret: rb.ret, mdd: rb.mdd, cagr: rb.cagr }, rq: { ret: rq.ret, mdd: rq.mdd, cagr: rq.cagr } });
}

console.log('\n================ 检验 F：收益为何集中在小成交额那档 ================');
function bySizeGroup(from, to) {
  const pool = fixedPool(from, { minBefore: 60, minAfter: 30 });
  const rows = pool.map((c) => {
    const bars = m.stocks[c].bars.filter((b) => b.date >= from && b.date <= to);
    const pre = m.stocks[c].bars.filter((b) => b.date <= from).slice(-20);
    const amt = pre.reduce((a, b) => a + b.close * b.volume * 100, 0) / (pre.length || 1);
    return { code: c, ret: bars.at(-1).close / bars[0].close - 1, amt };
  }).filter((x) => Number.isFinite(x.ret));
  rows.sort((a, b) => a.amt - b.amt);
  const k = Math.floor(rows.length / 3);
  const groups = { '小成交额': rows.slice(0, k), '中成交额': rows.slice(k, 2 * k), '大成交额': rows.slice(2 * k) };
  console.log(`\n${from} ~ ${to}（${rows.length} 只，按期初 20 日均成交额分档）`);
  for (const [name, g] of Object.entries(groups)) {
    const avg = g.reduce((a, x) => a + x.ret, 0) / g.length;
    const med = g.map((x) => x.ret).sort((a, b) => a - b)[Math.floor(g.length / 2)];
    const win = g.filter((x) => x.ret > 0).length / g.length;
    console.log(`  ${name.padEnd(8)} ${String(g.length).padStart(3)} 只  平均 ${pct(avg).padStart(9)}  中位 ${pct(med).padStart(9)}  胜率 ${(win * 100).toFixed(0)}%`);
  }
}
bySizeGroup('2023-01-03', '2026-10-16');
bySizeGroup('2025-01-02', '2026-10-16');

fs.writeFileSync(path.join(OUT, 'design-test.json'), JSON.stringify(eRows, null, 2));
console.log('\n已写入 data/replay/design-test.json');
