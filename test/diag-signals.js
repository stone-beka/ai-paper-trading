// 诊断：当前账户下 buildSignals 究竟给出什么信号（只读，不落盘）
import fs from 'node:fs';
import { buildSignals } from '../src/tick.js';
import { STRATEGY } from '../src/lib/strategy.js';

const s = JSON.parse(fs.readFileSync('data/state.json', 'utf8'));
const scan = s.lastScan;

console.log('当前 pending:', JSON.stringify(s.pending));
const sig = buildSignals(s, scan, '2026-10-17');
console.log('\n重新计算信号:');
console.log('  exit :', JSON.stringify(sig.exit));
console.log('  enter:', JSON.stringify(sig.enter));

const cash = s.cash;
const mv = Object.values(s.positions).reduce((a, p) => a + p.lastPrice * p.shares, 0);
const total = cash + mv;
const budget = Math.min(total * STRATEGY.positionPct, Math.max(0, cash - total * STRATEGY.minCashPct));
console.log(`\n资金：现金 ${cash.toFixed(2)} + 市值 ${mv.toFixed(2)} = 总资产 ${total.toFixed(2)}`);
console.log(`单只预算 = min(总资产×18%=${(total * 0.18).toFixed(0)}, 现金-10%底线=${(cash - total * 0.1).toFixed(0)}) = ${budget.toFixed(0)}`);

console.log('\n候选前 8 名的一手成本:');
for (const c of scan.candidates.slice(0, 8)) {
  const lot = c.close * 100;
  const ok = lot * 1.001 <= budget;
  console.log(`  ${c.name}(${c.code}) 价 ${c.close} 一手 ${lot.toFixed(0)} ${ok ? '✅买得起' : '❌买不起'} ${s.positions[c.code] ? '[已持有]' : ''}`);
}
