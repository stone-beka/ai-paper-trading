// 最终策略参数验证：只用上证指数（无幸存者偏差）验证可执行机制
import fs from 'node:fs';
import path from 'node:path';
import { market } from './engine.js';

const OUT = path.join(process.cwd(), 'data', 'replay');
const ib = market().index.bars;
const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const COST = 0.0015; // 单边（佣金+滑点，ETF 口径更贴近，但保守用个股口径）

const F = '2018-07-17';
const T = ib.at(-1).date;
console.log(`区间 ${F} ~ ${T}（${ib.length} 根，约 ${(ib.length / 242).toFixed(1)} 年，上证指数，零幸存者偏差）\n`);

/** 买入持有 */
function buyHold(from = F, to = T, capital = 100000) {
  const seg = ib.filter((b) => b.date >= from && b.date <= to);
  let peak = -Infinity, mdd = 0;
  for (const b of seg) { peak = Math.max(peak, b.close); mdd = Math.min(mdd, b.close / peak - 1); }
  const ret = seg.at(-1).close / seg[0].close - 1;
  const years = seg.length / 242;
  return { ret, mdd, years, cagr: Math.pow(1 + ret, 1 / years) - 1, final: capital * (1 + ret) };
}

/** 一次性买入 + 每年固定金额定投（按指数模拟） */
function dca(monthly, from = F, to = T) {
  const seg = ib.filter((b) => b.date >= from && b.date <= to);
  let units = 0, invested = 0;
  let lastMonth = null;
  for (const b of seg) {
    const mo = b.date.slice(0, 7);
    if (mo !== lastMonth) {
      lastMonth = mo;
      units += (monthly * (1 - COST)) / b.close;
      invested += monthly;
    }
  }
  const finalValue = units * seg.at(-1).close;
  return { invested, finalValue, ret: finalValue / invested - 1, multiple: finalValue / invested };
}

/** 定投 + 每年再平衡回目标仓位（这里用"定投额度动态调整"近似） */
function rebalanceAnnual(from = F, to = T, capital = 100000) {
  // 100% 满仓 + 每年再平衡到满仓 => 等价买入持有，用于确认再平衡在满仓时无意义
  const seg = ib.filter((b) => b.date >= from && b.date <= to);
  return buyHold(from, to, capital);
}

/** 股债/现金再平衡：每年恢复 70% 指数 + 30% 现金 */
function balanced({ stockPct = 0.7, rebalanceMonths = 12, from = F, to = T, capital = 100000 } = {}) {
  const seg = ib.filter((b) => b.date >= from && b.date <= to);
  let units = 0, cash = capital;
  let peak = -Infinity, mdd = 0, rebalances = 0;
  let nextIdx = 21 * rebalanceMonths;
  for (let i = 0; i < seg.length; i++) {
    const b = seg[i];
    if (i === 0) {
      const invest = capital * stockPct;
      units = (invest * (1 - COST)) / b.close;
      cash = capital - invest;
    }
    const v = cash + units * b.close;
    peak = Math.max(peak, v);
    mdd = Math.min(mdd, v / peak - 1);
    if (i >= nextIdx && i < seg.length - 1) {
      const total = cash + units * b.close;
      const targetStock = total * stockPct;
      const curStock = units * b.close;
      if (curStock > targetStock) {
        const sellUnits = (curStock - targetStock) / b.close;
        units -= sellUnits;
        cash += sellUnits * b.close * (1 - COST);
      } else {
        const buyValue = Math.min(total - curStock, targetStock - curStock);
        units += (buyValue * (1 - COST)) / b.close;
        cash -= buyValue;
      }
      rebalances++;
      nextIdx += 21 * rebalanceMonths;
    }
  }
  const v = cash + units * seg.at(-1).close;
  const years = seg.length / 242;
  return { ret: v / capital - 1, final: v, mdd, years, cagr: Math.pow(v / capital, 1 / years) - 1, rebalances };
}

const bh = buyHold();
console.log('===== 基准：上证指数买入持有 =====');
console.log(`  收益 ${pct(bh.ret)}  年化 ${pct(bh.cagr)}  最大回撤 ${pct(bh.mdd)}  期末 ${bh.final.toFixed(0)} 元\n`);

console.log('===== 方案 1：一次性买入并持有（零换手） =====');
console.log(`  同上（这就是零换手的天花板/地板的真实值，年化 ${pct(bh.cagr)}）\n`);

console.log('===== 方案 2：每月定投 2000 元 =====');
const d = dca(2000);
console.log(`  累计投入 ${d.invested.toFixed(0)} 元 -> 期末 ${d.finalValue.toFixed(0)} 元`);
console.log(`  收益率 ${pct(d.ret)}  倍数 ${d.multiple.toFixed(2)}x`);
console.log(`  （定投的收益率高于一次性投入，是因为后期买入的份额赶上了末段的涨势，但总收益也依赖于投入节奏）\n`);

console.log('===== 方案 3：股/现金固定比例 + 年度再平衡 =====');
for (const sp of [0.4, 0.6, 0.7, 0.8, 1.0]) {
  const r = balanced({ stockPct: sp, rebalanceMonths: 12 });
  console.log(`  ${(sp * 100).toFixed(0).padStart(3)}% 指数 + ${((1 - sp) * 100).toFixed(0).padStart(3)}% 现金   收益 ${pct(r.ret).padStart(9)}  年化 ${pct(r.cagr).padStart(7)}  最大回撤 ${pct(r.mdd).padStart(7)}  再平衡 ${r.rebalances} 次`);
}

console.log('\n===== 方案 4：再平衡频率的影响（70/30） =====');
for (const m of [3, 6, 12, 24]) {
  const r = balanced({ stockPct: 0.7, rebalanceMonths: m });
  console.log(`  每 ${String(m).padStart(2)} 个月再平衡   收益 ${pct(r.ret).padStart(9)}  年化 ${pct(r.cagr).padStart(7)}  最大回撤 ${pct(r.mdd).padStart(7)}  再平衡 ${r.rebalances} 次`);
}

console.log('\n===== 方案 5：成本敏感度（年换手次数 -> 年化拖累） =====');
for (const [label, n] of [['0 次（买入持有）', 0], ['1 次（年度再平衡）', 1], ['4 次', 4], ['12 次', 12], ['50 次', 50]]) {
  const drag = Math.pow(1 - 2 * COST, n) - 1; // 每次再平衡双边成本
  console.log(`  ${label.padEnd(18)} 年化成本拖累 ${pct(drag)}`);
}

// 汇总落盘
const res = {
  range: [F, T],
  index: { ret: bh.ret, cagr: bh.cagr, mdd: bh.mdd, final: bh.final },
  dca: d,
  balanced: [0.4, 0.6, 0.7, 0.8, 1.0].map((sp) => ({ stockPct: sp, ...balanced({ stockPct: sp, rebalanceMonths: 12 }) })),
  rebalanceFreq: [3, 6, 12, 24].map((m) => ({ months: m, ...balanced({ stockPct: 0.7, rebalanceMonths: m }) })),
};
fs.writeFileSync(path.join(OUT, 'final-design.json'), JSON.stringify(res, null, 2));
console.log('\n已写入 data/replay/final-design.json');
