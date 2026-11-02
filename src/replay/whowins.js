// 算账：在这段回放里，我和机械规则分别给"市场基础设施"交了多少钱
import fs from 'node:fs';
import path from 'node:path';
import { market } from './engine.js';

const OUT = path.join(process.cwd(), 'data', 'replay');
const read = (f) => (fs.existsSync(path.join(OUT, f)) ? JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) : null);

const mech = read('baseline-state.json');     // 2026-07-01 起 72 天
const agent = read('agent-state.json');
const lr = read('longrun-2023-01-03.json');   // 3.8 年汇总（只有 final，没有逐笔）

function costOf(state, label, days) {
  if (!state) return null;
  const trades = state.trades;
  const buyAmt = trades.filter((t) => t.side === 'buy').reduce((a, t) => a + t.amount, 0);
  const sellAmt = trades.filter((t) => t.side === 'sell').reduce((a, t) => a + t.amount, 0);
  const fees = trades.reduce((a, t) => a + (t.fee || 0), 0);
  const turnover = buyAmt + sellAmt;
  const stamp = trades.filter((t) => t.side === 'sell').reduce((a, t) => a + t.price * t.shares * 0.0005, 0);
  const commission = trades.reduce((a, t) => a + Math.max(t.price * t.shares * 0.00025, 5), 0);
  const slippage = trades.reduce((a, t) => a + t.price * t.shares * 0.001, 0);
  const start = state.snapshots[0];
  const end = state.snapshots.at(-1);
  const alpha = end.total - start.total;
  return {
    label, days, trades: trades.length, turnover,
    fees, commission, stamp, slippage,
    totalCost: fees + slippage,
    pnl: alpha,
    costVsPnl: alpha !== 0 ? (fees + slippage) / Math.abs(alpha) : null,
    costVsCapital: (fees + slippage) / 100000,
    ret: end.total / 100000 - 1,
  };
}

const rows = [
  costOf(agent, '操盘手（72 天）', 72),
  costOf(mech, '机械规则（72 天）', 72),
].filter(Boolean);

console.log('===== 我的回放里，钱去哪了 =====\n');
for (const r of rows) {
  console.log(`${r.label}`);
  console.log(`  成交 ${r.trades} 笔，买入+卖出总额 ${(r.turnover / 10000).toFixed(1)} 万元`);
  console.log(`  佣金 ${r.commission.toFixed(2)} 元 + 印花税 ${r.stamp.toFixed(2)} 元 + 滑点损失 ${r.slippage.toFixed(2)} 元`);
  console.log(`  合计交易成本 ${r.totalCost.toFixed(2)} 元，占本金 ${(r.costVsCapital * 100).toFixed(2)}%`);
  console.log(`  账户盈亏 ${r.pnl.toFixed(2)} 元（${(r.ret * 100).toFixed(2)}%）`);
  console.log(`  → 交易成本相当于账户盈亏的 ${r.costVsPnl == null ? '—' : (r.costVsPnl * 100).toFixed(0) + '%'}\n`);
}

// 3.8 年长周期：估算成本（按平均单笔金额推算）
console.log('===== 3.8 年长周期（2023-01-03 ~ 2026-10-16） =====');
if (lr) {
  const capital = 100000;
  for (const [k, label] of [['mech', '机械规则'], ['mechTrend', '机械规则+MA20闸门'], ['trader', '操盘手打法']]) {
    const f = lr[k];
    if (!f) continue;
    const avgTurnover = capital * 0.95; // 每笔换手约 95% 本金
    const trades = f.trades;
    const perRoundCost = avgTurnover * (0.00025 * 2 + 0.0005 + 0.001 * 2); // 买入卖出佣金+印花税+双边滑点
    const est = trades * perRoundCost;
    console.log(`  ${label.padEnd(18)} 成交 ${String(trades).padStart(4)} 笔  估算交易成本约 ${(est / 10000).toFixed(2)} 万元  账户最终 ${(f.total).toFixed(0)} 元（${(f.pnlPct * 100).toFixed(2)}%）`);
  }
}

// 市场整体：全市场成交额（用它对比个人的交易成本有多微不足道/交易有多频繁）
const m = market();
console.log('\n===== 你在这张牌桌上面对的抽水 =====');
const feeRate = 0.00025 * 2 + 0.0005; // 双边佣金 + 卖出印花税
console.log(`  一次完整买卖（100 万本金）的显性抽水：${(feeRate * 100).toFixed(3)}% = ${(1000000 * feeRate).toFixed(0)} 元`);
console.log(`  加上双边 0.1% 滑点：${((feeRate + 0.002) * 100).toFixed(3)}% = ${(1000000 * (feeRate + 0.002)).toFixed(0)} 元`);
console.log(`  若每周换手一次（一年 50 次）：年化成本 ${((feeRate + 0.002) * 50 * 100).toFixed(0)}%`);
console.log(`  若每天换手一次（一年 242 次）：年化成本 ${((feeRate + 0.002) * 242 * 100).toFixed(0)}%`);
